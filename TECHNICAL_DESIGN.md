# Design Técnico — playwright-session-manager

Detalhamento de **como** cada módulo é implementado. Complementa o `IMPLEMENTATION.md`
(que descreve o "o quê"). Decisão fechada: `cacheAcrossSpecs` default = **true**
(estado compartilhado em disco entre specs e workers).

---

## 0. Princípios

1. **Fidelidade ao `cy.session`** na semântica de setup/validate/relogin.
2. **Correção sob concorrência** (workers paralelos do Playwright) — nunca corromper o cache.
3. **Zero dependência de runtime** — só `fs`/`crypto`/`path` do Node.
4. **`@playwright/test` como peerDependency** — nunca bundlar.
5. **Determinismo** — mesmo `id` ⇒ mesmo arquivo de cache.

---

## 1. Fluxo central (`session.ts`)

```
session(context, id, setup, options)
│
├─ key   = serializeId(id)                     // id.ts
├─ file  = path.join(cacheDir, `${key}.json`)  // default cacheDir = ".auth"
│
├─ withLock(file, async () => {                // lock.ts (se options.lock !== false)
│    │
│    ├─ cached = readState(file, maxAgeMs)      // cache.ts → StorageState | null
│    │
│    ├─ if (cached) {
│    │     await context.addCookies(cached.cookies)
│    │     await applyOrigins(context, cached.origins)   // localStorage/sessionStorage
│    │     if (await runValidate(validate)) {
│    │         await saveState(context, file)  // regrava estado "fresco" (token rotativo)
│    │         return                           // ✅ restaurado + válido
│    │     }
│    │     // validate falhou → cai para relogin
│    │  }
│    │
│    ├─ await setup()                           // (re)login
│    ├─ if (validate) {
│    │     const ok = await runValidate(validate)
│    │     if (!ok) throw new Error('Session validation failed immediately after setup')
│    │  }                                        // erro (igual cy.session)
│    └─ await saveState(context, file)          // persiste o novo estado
│ })
```

### `runValidate(validate): Promise<boolean>`
Regras de invalidade (iguais ao cy.session):
- `validate` ausente → considerar válido (`true`).
- lança exceção → `false`.
- retorna Promise que **rejeita** → `false`.
- retorna/resolve `false` (booleano) → `false`.
- resolve `void`/`true`/qualquer não-false → `true`.

```ts
async function runValidate(validate?: ValidateFn): Promise<boolean> {
  if (!validate) return true;
  try {
    const r = await validate();
    return r !== false;         // void e true contam como válido
  } catch {
    return false;
  }
}
```

### Aplicar origins (localStorage/sessionStorage)
`context.addCookies` cobre cookies. Para localStorage/sessionStorage, o storageState guarda
`origins[].localStorage`. Estratégias:
- **Preferencial:** recriar o context com `storageState` no consumidor não é possível aqui
  (já recebemos o context). Então aplicamos via `context.addInitScript` + navegação, OU
  documentamos que o consumidor deve criar o context com o arquivo.
- **Decisão v1:** o `session()` aplica cookies diretamente; para localStorage usa
  `page.addInitScript`-like via `context.addInitScript(seedScript)` injetando os pares.
  (Detalhe de implementação a validar no M5 com o app fake — ver Edge Case E4.)

---

## 2. Serialização de id (`id.ts`)

```ts
export function serializeId(id: SessionId): string {
  const normalized =
    typeof id === 'string' ? id : stableStringify(id);
  return sha1(normalized).slice(0, 16);   // 16 hex chars — suficiente e curto
}
```

- `stableStringify`: ordena chaves de objeto recursivamente para garantir determinismo
  (`{a,b}` e `{b,a}` ⇒ mesma string). Arrays preservam ordem (ordem é significativa, como no Cypress).
- Hash com `crypto.createHash('sha1')` (não é segurança, é chave de cache; sha1 basta e é rápido).
- **Nunca** colocar o valor cru (pode conter usuário/senha) no nome do arquivo → só o hash.

### Unit tests (M2)
- `serializeId('user')` estável entre chamadas.
- `serializeId(['a','b'])` ≠ `serializeId(['b','a'])` (ordem importa).
- `serializeId({a:1,b:2})` === `serializeId({b:2,a:1})` (chaves ordenadas).
- objeto aninhado determinístico.

---

## 3. Cache em disco (`cache.ts`)

Formato do arquivo = o próprio `StorageState` do Playwright + metadados:

```jsonc
{
  "__meta": { "savedAt": 1736512000000, "version": 1 },
  "cookies": [ ... ],
  "origins": [ { "origin": "...", "localStorage": [ {name,value} ] } ]
}
```

### `readState(file, maxAgeMs?): StorageState | null`
```
if (!existsSync(file)) return null
raw = readFileSync(file)
try { data = JSON.parse(raw) } catch { return null }    // corrompido → trata como ausente
if (maxAgeMs && Date.now() - data.__meta.savedAt > maxAgeMs) return null   // expirado
return { cookies: data.cookies, origins: data.origins }
```

### `saveState(context, file): Promise<void>` — **escrita atômica**
```
state = await context.storageState()          // { cookies, origins }
payload = { __meta: { savedAt: Date.now(), version: 1 }, ...state }
tmp = `${file}.${process.pid}.${rand}.tmp`
mkdirSync(dirname(file), { recursive: true })
writeFileSync(tmp, JSON.stringify(payload))
renameSync(tmp, file)                          // rename é atômico no mesmo FS
```
Rename atômico garante que um leitor nunca vê um arquivo meio-escrito.

### Unit tests (M3)
- save→read round-trip preserva cookies/origins.
- arquivo corrompido → `readState` retorna null (não lança).
- `maxAgeMs` expira corretamente (mock de `Date.now`).
- escrita atômica: nunca deixa `.tmp` órfão em caso de sucesso.

---

## 4. Lock entre workers (`lock.ts`)

Objetivo: dois workers que precisam relogar o **mesmo id** ao mesmo tempo não devem
(a) relogar em duplicidade desnecessária nem (b) corromper o arquivo.

### Mecanismo: lockfile via `mkdir` atômico
`fs.mkdirSync(lockDir)` é atômico e falha se já existe → primitivo de mutex simples e portátil.

```ts
export async function withLock<T>(file: string, fn: () => Promise<T>, opts?): Promise<T> {
  const lockDir = `${file}.lock`;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const start = Date.now();

  // adquire
  while (true) {
    try { mkdirSync(lockDir); break; }         // conseguiu o lock
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (isStale(lockDir)) { rmSync(lockDir, {recursive:true}); continue; } // lock órfão
      if (Date.now() - start > timeoutMs) throw new Error('Lock timeout');
      await sleep(50 + jitter());
    }
  }
  // seção crítica
  try { return await fn(); }
  finally { rmSync(lockDir, { recursive: true, force: true }); }  // libera
}
```

- **Stale lock:** se o `lockDir` tem mtime mais velho que `staleMs` (ex.: 60s), assume que o
  dono morreu e recupera o lock. Evita deadlock se um worker crashar.
- **Jitter** no backoff evita "thundering herd".
- **Reentrância entre workers:** o segundo worker, ao entrar na seção crítica DEPOIS do
  primeiro relogar, vai encontrar o cache já válido e apenas restaurar — sem relogar de novo.
  (É por isso que o `readState` fica DENTRO do lock.)

### Teste de concorrência (M4)
- Disparar N chamadas `withLock` concorrentes incrementando um contador em arquivo;
  resultado final == N (sem corrida).
- Simular lock órfão (criar `lockDir` antigo) e verificar recuperação.

---

## 5. Tipos (`types.ts`)

```ts
import type { BrowserContext } from '@playwright/test';

export type SessionId = string | Array<string | number> | Record<string, unknown>;
export type ValidateFn = () => Promise<void> | Promise<boolean> | void;

export interface SessionOptions {
  validate?: ValidateFn;
  cacheDir?: string;          // default ".auth"
  cacheAcrossSpecs?: boolean; // default true
  maxAgeMs?: number;
  lock?: boolean;             // default true
  lockTimeoutMs?: number;     // default 30000
  staleLockMs?: number;       // default 60000
}
```

> Nota `cacheAcrossSpecs`: como o cache é **sempre** em disco, `true` (default) usa um caminho
> estável (`.auth/<hash>.json`) compartilhado. Se algum dia alguém setar `false`, usaríamos um
> caminho por-processo (ex.: sufixo com `process.pid`) para isolar. v1 foca no `true`.

---

## 6. Build e empacotamento

- **tsup** gera `dist/index.js` (ESM), `dist/index.cjs` (CJS) e `dist/index.d.ts`.
- `package.json` com `exports` mapeando import/require/types (já esboçado no IMPLEMENTATION.md).
- `files: ["dist"]` — publica só o build.
- `prepublishOnly: npm run build`.
- `engines.node >= 18`.

### tsup.config.ts
```ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
});
```

---

## 7. App fake para e2e (`tests/fixtures/fake-auth-app/`)

Servidor HTTP mínimo (usando `http` nativo, sem framework) com:
- `POST /login` → valida credenciais fixas, seta cookie `auth` com um token e expiração curta.
- `GET /whoami` → 200 se cookie válido/não-expirado; 401 caso contrário.
- Suporte a **forçar rotação/expiração** via query (`?ttlMs=...`) para testar re-login.
- Uma página `/dashboard` simples para validação por UI, se necessário.

Iniciado/encerrado por um `globalSetup`/fixture do Playwright nos testes do próprio pacote.

### Cenários e2e (M6)
1. **Cria sessão:** sem cache → setup roda 1x → arquivo criado → validate ok.
2. **Restaura sem relogar:** segundo `session()` com mesmo id não chama setup (spy conta 0).
3. **Token expirado:** avança o tempo/ttl → validate falha → setup re-roda → passa.
4. **Concorrência:** 2 contexts em paralelo, mesmo id → no máx. 1 relogin, arquivo íntegro.
5. **id diferente:** cria arquivos distintos, sessões independentes.
6. **Corrompe arquivo:** escreve lixo no cache → session se recupera relogando.

---

## 8. Ordem de execução (com critérios de "pronto")

| M  | Entregável            | Pronto quando…                                             |
|----|-----------------------|------------------------------------------------------------|
| M1 | Scaffold + CI         | `npm run build` gera dist; CI verde; `import { session }` resolve tipos |
| M2 | `id.ts` + unit        | testes de determinismo/ordem passam                        |
| M3 | `cache.ts` + unit     | round-trip, corrupção, maxAge, escrita atômica passam      |
| M4 | `lock.ts` + unit      | teste de concorrência (contador == N) e stale-lock passam  |
| M5 | `session.ts`          | fluxo restore→validate→setup→save implementado             |
| M6 | app fake + e2e        | 6 cenários e2e verdes no Chromium                          |
| M7 | README + exemplos     | exemplo do ERP (token 10 min) documentado                  |
| M8 | publish               | `npm install playwright-session-manager` funciona          |

---

## 9. Edge cases catalogados

- **E1 — validate ausente:** válido por padrão (não força relogin à toa).
- **E2 — setup lança:** propaga o erro (falha o teste; login quebrado é erro real).
- **E3 — validate falha logo após setup:** erro explícito (evita loop infinito) — igual cy.session.
- **E4 — localStorage/sessionStorage:** confirmar no M5 se `addCookies` + seed de storage cobre;
  se não, documentar que o context deve ser criado a partir do arquivo (fallback).
- **E5 — arquivo corrompido/parcial:** `readState` retorna null → relogin.
- **E6 — lock órfão (worker morto):** recuperação por staleLockMs.
- **E7 — cacheDir inexistente:** criado com `recursive: true` no save.
- **E8 — id com dados sensíveis:** nunca vai para o nome do arquivo (só hash).
- **E9 — relógio/maxAge:** `savedAt` em epoch ms; comparação simples.

---

## 10. Decisões travadas
- `cacheAcrossSpecs` default **true** (compartilha em disco). ✅ confirmado.
- Estilo de API **imperativo** `session(context, id, setup, options)` (cara de cy.session). ✅
- Sem deps de runtime; peerDep `@playwright/test`. ✅
- Lock por `mkdir` atômico + stale recovery. ✅
