# playwright-session-manager

[![npm](https://img.shields.io/npm/v/playwright-session-manager.svg)](https://www.npmjs.com/package/playwright-session-manager)
[![license](https://img.shields.io/npm/l/playwright-session-manager.svg)](./LICENSE)

`cy.session` for Playwright — cache an authenticated session, **validate** it before reuse,
and **automatically re-login** when it's no longer valid. Handles the tricky case of
**tokens that expire or rotate** mid-suite, shared safely across tests and parallel workers.

```bash
npm install playwright-session-manager
```

> Requires `@playwright/test` (peer dependency) and Node >= 18. Ships ESM + CommonJS + types.

## Contents

- [Why](#why)
- [Quick start](#quick-start)
- [Recommended: a `login` fixture](#recommended-a-login-fixture)
- [Observability: report created / restored / recreated](#observability-report-created--restored--recreated)
- [API](#api)
- [Behavior (faithful to cy.session)](#behavior-faithful-to-cysession)
- [Rotating / short-lived tokens](#rotating--short-lived-tokens)
- [Multiple users](#multiple-users)
- [Token-based auth (no cookies)](#token-based-auth-no-cookies)
- [Notes & limitations](#notes--limitations)
- [FAQ](#faq)

## Why

Playwright's `storageState` is static: it loads cookies/localStorage once and that's it. If the
session expired, the test just fails. Cypress's `cy.session` solves this with a `validate`
callback that re-runs the login when the session is invalid.

This package brings that behavior to Playwright, plus:

- **Disk-backed cache** shared across specs and parallel workers (on by default).
- **Atomic writes + file locking**, so concurrent workers never corrupt the state or trigger
  redundant logins.
- **Validate-then-reuse-or-relogin** semantics, identical to `cy.session`.
- **Lifecycle events** so you can see in your report whether a session was *created*,
  *restored*, or *recreated*.

## Quick start

```ts
import { test, expect } from '@playwright/test';
import { session } from 'playwright-session-manager';

test.beforeEach(async ({ page, context }) => {
  await session(
    context,
    'user@example.com',              // id: string | array | object (like cy.session)
    async () => {                    // setup: perform the login (runs only when needed)
      await page.goto('/login');
      await page.getByLabel('Email').fill('user@example.com');
      await page.getByLabel('Password').fill('s3cr3t');
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForURL('**/dashboard');
    },
    {
      validate: async () => {        // validate: throw or return false = invalid → re-login
        const res = await context.request.get('/whoami');
        expect(res.status()).toBe(200);
      },
    },
  );

  await page.goto('/');              // navigate after restoring, like cy.session
});

test('is authenticated', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
});
```

## Recommended: a `login` fixture

Wrapping `session()` in a custom fixture keeps the login logic in one place and makes tests
read like Cypress. Tests just call `login({ ... })` in `beforeEach`.

```ts
// fixtures.ts
import { test as base, expect } from '@playwright/test';
import { session, stepReporter } from 'playwright-session-manager';

interface Credentials {
  username: string;
  password: string;
}

export const test = base.extend<{
  login: (credentials: Credentials) => Promise<void>;
}>({
  login: async ({ page, context }, use) => {
    await use(async ({ username, password }: Credentials) => {
      await session(
        context,
        username,                    // one cache entry per user
        async () => {
          await page.goto('/login');
          await page.getByLabel('Email').fill(username);
          await page.getByLabel('Password').fill(password);
          await page.getByRole('button', { name: 'Log In' }).click();
          await page.waitForURL(url => !url.pathname.startsWith('/login'));
        },
        {
          validate: async () => {
            const res = await context.request.get('/whoami');
            expect(res.status()).toBe(200);
          },
          onEvent: stepReporter(test),  // report created/restored/recreated
          maxAgeMs: 9 * 60 * 1000,      // proactively refresh before a 10-min token expires
        },
      );
    });
  },
});

export { expect };
```

```ts
// login.spec.ts
import { test, expect } from './fixtures';

test.beforeEach(async ({ login }) => {
  await login({ username: 'user@example.com', password: 's3cr3t' });
});

test('is authenticated', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
});
```

## Observability: report created / restored / recreated

`session()` emits lifecycle events through the optional `onEvent` callback. The bundled
`stepReporter(test)` helper turns those events into Playwright **steps** (visible in the
report/trace) and logs them to the console.

```ts
import { test } from '@playwright/test';
import { session, stepReporter } from 'playwright-session-manager';

await session(context, id, setup, {
  validate,
  onEvent: stepReporter(test),
});
```

Steps it produces:

| Event        | Step title                                       | When                                        |
|--------------|--------------------------------------------------|---------------------------------------------|
| `validating` | `[session] validating cached session`            | before validating an existing cache         |
| `restored`   | `[session] session RESTORED from cache (no re-login)` | cache was valid, no login performed    |
| `created`    | `[session] session CREATED (login performed)`    | no cache existed, login ran                 |
| `recreated`  | `[session] session RECREATED (invalid cache, re-login)` | cache was invalid, login ran again   |

Customize the prefix or disable console logging:

```ts
onEvent: stepReporter(test, { prefix: 'auth', log: false })
```

Or write your own handler — `onEvent` just receives `{ type, key, message }`:

```ts
onEvent: (event) => {
  myLogger.info({ session: event.type, key: event.key }, event.message);
}
```

## API

```ts
import {
  session,
  stepReporter,
  serializeId,     // hash an id the same way the cache does
  stableStringify, // deterministic JSON (key order independent)
} from 'playwright-session-manager';

function session(
  context: BrowserContext,
  id: SessionId,
  setup: () => Promise<void> | void,
  options?: SessionOptions,
): Promise<void>;

type SessionId = string | Array<string | number> | Record<string, unknown>;
```

### `SessionOptions`

| Option             | Type                          | Default   | Description                                                        |
|--------------------|-------------------------------|-----------|--------------------------------------------------------------------|
| `validate`         | `() => void\|boolean\|Promise`| —         | Session is **invalid** if it throws, rejects, or returns `false`.  |
| `onEvent`          | `(event) => void\|Promise`    | —         | Lifecycle callback. Pair with `stepReporter(test)`.                |
| `cacheDir`         | `string`                      | `".auth"` | Directory where the storage state is saved.                        |
| `cacheAcrossSpecs` | `boolean`                     | `true`    | Share the cache between specs/workers via disk.                    |
| `maxAgeMs`         | `number`                      | —         | Invalidate a cache older than this age (great for short-lived tokens). |
| `lock`             | `boolean`                     | `true`    | Use a file lock so parallel workers don't race.                    |
| `lockTimeoutMs`    | `number`                      | `30000`   | Max time to wait to acquire the lock.                              |
| `staleLockMs`      | `number`                      | `60000`   | Age after which a lock is treated as orphaned and recovered.       |

### `stepReporter(test, options?)`

```ts
function stepReporter(
  test: { step: <T>(title: string, body: () => Promise<T>) => Promise<T> },
  options?: { prefix?: string; log?: boolean }, // prefix default "session", log default true
): OnEventFn;
```

## Behavior (faithful to cy.session)

| Situation                            | Behavior                                     |
|--------------------------------------|----------------------------------------------|
| No cache for `id`                    | run `setup` → run `validate`                 |
| `validate` fails right after `setup` | **throws** (no infinite loop)                |
| Cache exists for `id`                | restore state → run `validate`               |
| `validate` fails after restoring     | **re-run `setup`** (re-login) → validate     |
| `validate` invalid                   | throws OR resolves `false`                   |
| `id` is array/object                 | deterministically serialized into the key    |

The `id` is hashed to name the cache file (`.auth/<hash>.json`), so sensitive values never
appear in the filename.

## Rotating / short-lived tokens

- Only `session()` writes the shared cache file (prevents "auth-state poisoning").
- Writes are **atomic** (temp file + rename) and guarded by a **file lock**, so parallel
  workers never corrupt the cache or re-login redundantly.
- After a successful `validate`, the freshest state is re-saved.
- Use `maxAgeMs` to proactively invalidate a cache older than your token's lifetime.

If your refresh token is single-use **and** you run with high parallelism, re-logins may
happen more often (correctness is always guaranteed; the caching benefit degrades). Mitigate
with `workers: 1` for the authenticated suite, or one `id` per user.

## Multiple users

```ts
// Different ids → independent cached sessions, each in its own cache file.
await session(context, ['admin', orgId], loginAsAdmin, { validate });
await session(context, ['viewer', orgId], loginAsViewer, { validate });
```

## Token-based auth (no cookies)

Some apps don't use cookies — they store a JWT in `localStorage` and send it as a bearer
token. `session()` captures `localStorage` too, so you can read the token inside `validate`
and call your API with the right header:

```ts
validate: async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  const raw = await page.evaluate(() => localStorage.getItem('app.session'));
  if (!raw) return false;
  const { token } = JSON.parse(raw);

  const res = await context.request.get('/authorization/verify', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok();
}
```

## Notes & limitations

- Applies cookies and `localStorage` to the given context. `IndexedDB` is **not** captured by
  Playwright's `storageState` (same limitation as the native feature).
- Add `.auth/` to your `.gitignore` — the cache contains live session data.
- `session()` restores state into the context; navigate afterwards (`page.goto('/')`) just
  like you would after `cy.session`.

## FAQ

**Does it re-login on every test?** No. It restores the cached state and only re-logins when
`validate` says the session is invalid (or when `maxAgeMs` expired the cache).

**Is it safe with `fullyParallel` / multiple workers?** Yes. A file lock ensures that
concurrent workers sharing an `id` create the session once; the others wait and restore it.

**Where is the cache stored?** In `cacheDir` (default `.auth/`), one JSON file per `id` hash.

## License

MIT
