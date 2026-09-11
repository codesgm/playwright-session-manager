import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session } from '../../src/session.ts';
import { serializeId } from '../../src/id.ts';
import { startFakeApp, type FakeApp } from '../fixtures/fake-auth-app/server.ts';

let app: FakeApp;

test.beforeAll(async () => {
  app = await startFakeApp();
});

test.afterAll(async () => {
  await app.close();
});

test.beforeEach(() => {
  app.reset();
});

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'psm-e2e-'));
}

/** Helper de login contra o app fake, com ttl configurável. */
function makeLogin(page: import('@playwright/test').Page, ttlMs?: number) {
  return async () => {
    const suffix = ttlMs != null ? `?ttlMs=${ttlMs}` : '';
    await page.goto(`${app.url}/login${suffix}`);
    await page.locator('#email').fill('user@example.com');
    await page.locator('#password').fill('s3cr3t');
    await page.locator('#submit').click();
    await page.waitForURL('**/dashboard');
  };
}

const validate = (page: import('@playwright/test').Page, ctx: import('@playwright/test').BrowserContext) =>
  async () => {
    const res = await ctx.request.get(`${app.url}/whoami`);
    if (res.status() !== 200) throw new Error('not authenticated');
  };

test('1. cria sessão quando não há cache (roda setup uma vez)', async ({ page, context }) => {
  const cacheDir = freshCacheDir();
  await session(context, 'user', makeLogin(page), { validate: validate(page, context), cacheDir });

  expect(app.loginCount()).toBe(1);
  const res = await context.request.get(`${app.url}/whoami`);
  expect(res.status()).toBe(200);
});

test('2. restaura sessão do cache sem relogar', async ({ browser }) => {
  const cacheDir = freshCacheDir();

  // 1º context: cria a sessão
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await session(ctxA, 'user', makeLogin(pageA), { validate: validate(pageA, ctxA), cacheDir });
  expect(app.loginCount()).toBe(1);
  await ctxA.close();

  // 2º context: deve restaurar do cache, sem novo login
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await session(ctxB, 'user', makeLogin(pageB), { validate: validate(pageB, ctxB), cacheDir });
  expect(app.loginCount()).toBe(1); // continua 1 → não relogou
  const res = await ctxB.request.get(`${app.url}/whoami`);
  expect(res.status()).toBe(200);
  await ctxB.close();
});

test('3. token expirado força re-login', async ({ browser }) => {
  const cacheDir = freshCacheDir();

  // cria sessão com TTL curtíssimo (100ms)
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await session(ctxA, 'user', makeLogin(pageA, 100), { validate: validate(pageA, ctxA), cacheDir });
  expect(app.loginCount()).toBe(1);
  await ctxA.close();

  // espera o token expirar
  await new Promise((r) => setTimeout(r, 200));

  // novo context: validate deve falhar (token expirado) → relogin
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await session(ctxB, 'user', makeLogin(pageB, 100), { validate: validate(pageB, ctxB), cacheDir });
  expect(app.loginCount()).toBe(2); // relogou
  await ctxB.close();
});

test('4. concorrência: 2 contexts com mesmo id relogam no máximo 1x e não corrompem cache', async ({
  browser,
}) => {
  const cacheDir = freshCacheDir();

  const run = async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await session(ctx, 'user', makeLogin(page), { validate: validate(page, ctx), cacheDir });
    await ctx.close();
  };

  await Promise.all([run(), run()]);

  // Com lock, o segundo entra na seção crítica após o primeiro relogar e encontra o
  // cache já válido → exatamente 1 login.
  expect(app.loginCount()).toBe(1);
  // arquivo de cache íntegro e legível
  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
  expect(files.length).toBe(1);
});

test('5. ids diferentes criam sessões independentes', async ({ page, context }) => {
  const cacheDir = freshCacheDir();
  await session(context, 'user-a', makeLogin(page), { validate: validate(page, context), cacheDir });
  await session(context, 'user-b', makeLogin(page), { validate: validate(page, context), cacheDir });

  const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json')).sort();
  expect(files.length).toBe(2);
  expect(files).toContain(`${serializeId('user-a')}.json`);
  expect(files).toContain(`${serializeId('user-b')}.json`);
});

test('6. cache corrompido: recupera relogando', async ({ page, context }) => {
  const cacheDir = freshCacheDir();
  // planta um arquivo corrompido no caminho do id
  writeFileSync(join(cacheDir, `${serializeId('user')}.json`), '{ lixo não-json');

  await session(context, 'user', makeLogin(page), { validate: validate(page, context), cacheDir });

  expect(app.loginCount()).toBe(1); // teve que relogar
  const res = await context.request.get(`${app.url}/whoami`);
  expect(res.status()).toBe(200);
});
