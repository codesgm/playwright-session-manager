# playwright-session-manager

Um pacote npm que traz o comportamento do **`cy.session` do Cypress** para o **Playwright**:
cacheia a sessão autenticada, **valida** antes de reutilizar e **reloga automaticamente**
quando a sessão está inválida — resolvendo inclusive o cenário de **token que expira/rotaciona**
no meio da suíte.

```bash
npm install playwright-session-manager
```

---

## 1. Por que este pacote existe

O Playwright tem `storageState` (salva cookies + localStorage em disco), mas ele é **estático**:
carrega o estado e pronto. Se a sessão expirou, o teste simplesmente falha. Não há o `validate`
do Cypress que revalida e reloga sozinho.

O `cy.session` do Cypress faz:
1. Se não há sessão cacheada para o `id` → roda `setup` (login) → roda `validate`.
2. Se há sessão cacheada → restaura → roda `validate`.
3. Se o `validate` falha ao restaurar → **re-roda o `setup`** (reloga) e valida de novo.

Este pacote replica exatamente essa semântica no Playwright, com um extra pensado para
ambientes de **token rotativo**: só o gerenciador escreve o arquivo de estado (escrita atômica
+ lock entre workers), evitando que o refresh de um teste invalide os demais.

---

## 2. Instalação

```bash
npm install playwright-session-manager
# peer dependency (você já deve ter no projeto):
npm install -D @playwright/test
```

- `@playwright/test` é **peerDependency** (usa a versão do seu projeto).
- Sem dependências de runtime adicionais.
- Node >= 18. Distribuído em ESM + CJS + tipos (`.d.ts`).

---

## 3. Uso — equivalência direta com `cy.session`

### Cypress (antes)

```js
Cypress.Commands.add('login', (username, password) => {
  cy.session(
    [username, password],
    () => {
      cy.visit('/login');
      cy.get('[data-test=name]').type(username);
      cy.get('[data-test=password]').type(password);
      cy.get('form').contains('Log In').click();
      cy.url().should('contain', '/dashboard');
    },
    {
      validate() {
        cy.request('/whoami').its('status').should('eq', 200);
      },
    },
  );
});
```

### Playwright com playwright-session-manager (depois)

```ts
import { test, expect } from '@playwright/test';
import { session } from 'playwright-session-manager';

async function login(page, context, username: string, password: string) {
  await session(
    context,
    [username, password],                 // id (string | array | objeto)
    async () => {                          // setup: faz o login (equivale ao 2º arg do cy.session)
      await page.goto('/login');
      await page.getByTestId('name').fill(username);
      await page.getByTestId('password').fill(password);
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForURL('**/dashboard');
    },
    {
      validate: async () => {              // validate: revalida a sessão (equivale ao options.validate)
        const res = await context.request.get('/whoami');
        expect(res.status()).toBe(200);
      },
    },
  );
}

test.beforeEach(async ({ page, context }) => {
  await login(page, context, 'ailic@automation.com.br', 'teste123');
  await page.goto('/');                    // igual ao cy.session: navegue após restaurar
});

test('usuário está logado', async ({ page }) => {
  await expect(
    page.getByRole('list').filter({ hasText: 'Check-in' }).getByRole('img'),
  ).toBeVisible();
});
```

---

## 4. API

```ts
type SessionId = string | Array<string | number> | Record<string, unknown>;

interface SessionOptions {
  /** Revalida a sessão. Inválida se lançar exceção ou resolver `false`. */
  validate?: () => Promise<void> | Promise<boolean> | void;
  /** Pasta onde o estado é salvo. Default: ".auth". */
  cacheDir?: string;
  /** Compartilha o cache entre specs/workers via disco. Default: true. */
  cacheAcrossSpecs?: boolean;
  /** Invalida o cache por idade (ms). Defesa extra p/ token de vida curta. */
  maxAgeMs?: number;
  /** Lock de arquivo p/ evitar corrida entre workers. Default: true. */
  lock?: boolean;
}

export function session(
  context: BrowserContext,
  id: SessionId,
  setup: () => Promise<void>,
  options?: SessionOptions,
): Promise<void>;
```

### Semântica (fiel ao cy.session)

| Situação                              | Comportamento                                   |
|---------------------------------------|-------------------------------------------------|
| Sem cache para o `id`                 | roda `setup` → roda `validate`                  |
| `validate` falha logo após `setup`    | **erro** (não faz loop infinito)                |
| Cache existe para o `id`              | restaura estado → roda `validate`               |
| `validate` falha após restaurar       | **re-roda `setup`** (reloga) → valida de novo   |
| `validate` inválido                   | lança exceção OU resolve `false`                |
| `id` array/objeto                     | serializado deterministicamente p/ chave        |

O `id` é serializado e "hasheado" para nomear o arquivo de cache
(`.auth/<hash>.json`) — dados sensíveis não vão para o nome do arquivo.

---

## 5. Cenário de token rotativo (o problema que motivou o pacote)

Quando o token renova dentro de um teste, o estado salvo pode ficar obsoleto e — em backends
que invalidam o token anterior — quebrar os outros testes. Regras aplicadas:

1. **Só `session()` escreve o arquivo compartilhado.** Testes nunca reescrevem o estado
   compartilhado (evita o "auth-state poisoning").
2. **Escrita atômica + lock:** grava em arquivo temporário e faz `rename`, sob lock, para
   dois workers não corromperem o cache.
3. **Regrava o estado após validate OK:** o disco fica sempre com o token mais fresco.
4. **`maxAgeMs`:** invalida o cache por idade antes mesmo de validar (bom p/ token de 10 min).

**Limitação honesta:** se o refresh token for de uso único **e** o paralelismo for alto, o
re-login pode ocorrer com frequência (o pacote garante correção, mas o ganho de cache cai).
Mitigações: usar `workers: 1` na suíte autenticada, ou um `id` por usuário.

---

## 6. Estrutura do repositório

```
playwright-session-manager/
├── src/
│   ├── index.ts        # export público: session()
│   ├── session.ts      # orquestra restore → validate → setup → save
│   ├── cache.ts        # leitura/escrita atômica do storageState + maxAge
│   ├── id.ts           # serialização determinística do id
│   ├── lock.ts         # lock de arquivo p/ concorrência entre workers
│   └── types.ts        # SessionId, SessionOptions
├── tests/
│   ├── id.spec.ts
│   ├── cache.spec.ts
│   ├── session.e2e.spec.ts
│   └── fixtures/fake-auth-app/   # app HTTP fake p/ login/validate/expiração
├── package.json
├── tsconfig.json
├── tsup.config.ts      # build ESM + CJS + d.ts
├── README.md
├── LICENSE (MIT)
├── .gitignore
├── .npmignore
└── .github/workflows/ci.yml
```

### package.json (esboço)

```json
{
  "name": "playwright-session-manager",
  "version": "0.1.0",
  "description": "cy.session for Playwright: cache, validate and auto re-login sessions.",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "playwright test",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@playwright/test": ">=1.30.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0"
  },
  "keywords": ["playwright", "cypress", "cy.session", "session", "auth", "login", "storageState"],
  "license": "MIT"
}
```

---

## 7. Plano de implementação (milestones)

- [ ] **M1 — Scaffold:** repo, `package.json`, `tsconfig`, `tsup`, CI verde vazio.
- [ ] **M2 — `id.ts`:** serialização determinística + unit tests.
- [ ] **M3 — `cache.ts`:** load/save atômico do storageState + `maxAge` + unit tests.
- [ ] **M4 — `lock.ts`:** lock de arquivo + teste de concorrência.
- [ ] **M5 — `session.ts`:** orquestração restore→validate→setup→save (semântica cy.session).
- [ ] **M6 — App fake + e2e:** restore/relogin/rotação/concorrência.
- [ ] **M7 — README + exemplos** (incl. exemplo real do ERP com token de 10 min).
- [ ] **M8 — Publicar:** `git push` → `npm publish` (`npm install playwright-session-manager`).

---

## 8. Como o consumidor vai usar (objetivo final)

```bash
npm install playwright-session-manager
```

```ts
import { session } from 'playwright-session-manager';
// ...usar como no exemplo da seção 3.
```
