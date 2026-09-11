import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, saveState } from '../../src/cache.ts';

function tmpFile(name = 'state.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'psm-cache-'));
  return join(dir, name);
}

// Fake mínimo de BrowserContext para exercitar saveState sem browser real.
function fakeContext(state: { cookies: unknown[]; origins: unknown[] }) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: async () => state as any,
  } as any;
}

test('round-trip: save depois read preserva cookies e origins', async () => {
  const file = tmpFile();
  const state = {
    cookies: [{ name: 'auth', value: 'tok', domain: 'x', path: '/' }],
    origins: [{ origin: 'http://x', localStorage: [{ name: 'k', value: 'v' }] }],
  };
  await saveState(fakeContext(state), file);
  const read = readState(file);
  assert.deepEqual(read?.cookies, state.cookies);
  assert.deepEqual(read?.origins, state.origins);
});

test('arquivo ausente retorna null', () => {
  assert.equal(readState(tmpFile('nao-existe.json')), null);
});

test('arquivo corrompido retorna null (não lança)', () => {
  const file = tmpFile();
  writeFileSync(file, '{ isso não é json válido');
  assert.equal(readState(file), null);
});

test('maxAgeMs expira cache antigo', async () => {
  const file = tmpFile();
  await saveState(fakeContext({ cookies: [], origins: [] }), file);
  // savedAt = agora; com maxAge negativo, já está "expirado"
  assert.equal(readState(file, -1), null);
  // com maxAge grande, ainda válido
  assert.notEqual(readState(file, 60_000), null);
});

test('escrita atômica não deixa arquivos .tmp órfãos', async () => {
  const file = tmpFile();
  await saveState(fakeContext({ cookies: [], origins: [] }), file);
  const dir = join(file, '..');
  const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0);
  assert.ok(existsSync(file));
});
