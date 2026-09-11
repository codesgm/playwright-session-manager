# playwright-session-manager

`cy.session` for Playwright — cache an authenticated session, **validate** it before reuse
and **automatically re-login** when it's no longer valid. Handles the tricky case of
**tokens that expire or rotate** mid-suite, shared safely across tests and parallel workers.

```bash
npm install playwright-session-manager
```

> Requires `@playwright/test` (peer dependency) and Node >= 18.

## Why

Playwright's `storageState` is static: it loads cookies/localStorage and that's it. If the
session expired, your test just fails. Cypress's `cy.session` solves this with a `validate`
callback that re-runs the login when the session is invalid. This package brings that behavior
to Playwright, plus atomic, locked, shared-on-disk caching so parallel workers never corrupt
the state or trigger redundant logins.

## Quick start

```ts
import { test, expect } from '@playwright/test';
import { session } from 'playwright-session-manager';

async function login(page, context) {
  await session(
    context,
    'user@example.com',              // id: string | array | object (like cy.session)
    async () => {                    // setup: perform the login
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
}

test.beforeEach(async ({ page, context }) => {
  await login(page, context);
  await page.goto('/');              // navigate after restoring, like cy.session
});

test('is authenticated', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
});
```

## API

```ts
function session(
  context: BrowserContext,
  id: SessionId,
  setup: () => Promise<void> | void,
  options?: SessionOptions,
): Promise<void>;

type SessionId = string | Array<string | number> | Record<string, unknown>;

interface SessionOptions {
  validate?: () => Promise<void> | Promise<boolean> | boolean | void;
  cacheDir?: string;          // default ".auth"
  cacheAcrossSpecs?: boolean; // default true (shared on disk)
  maxAgeMs?: number;          // invalidate cache by age (great for short-lived tokens)
  lock?: boolean;             // default true (file lock across workers)
  lockTimeoutMs?: number;     // default 30000
  staleLockMs?: number;       // default 60000
}
```

### Behavior (faithful to cy.session)

| Situation                              | Behavior                                   |
|----------------------------------------|--------------------------------------------|
| No cache for `id`                      | run `setup` → run `validate`               |
| `validate` fails right after `setup`   | **throws** (no infinite loop)              |
| Cache exists for `id`                  | restore state → run `validate`             |
| `validate` fails after restoring       | **re-run `setup`** (re-login) → validate   |
| `validate` invalid                     | throws OR resolves `false`                 |
| `id` is array/object                   | deterministically serialized into the key  |

The `id` is hashed to name the cache file (`.auth/<hash>.json`) — sensitive values never
appear in the filename.

## Rotating / short-lived tokens

- Only `session()` writes the shared cache file (prevents "auth-state poisoning").
- Writes are **atomic** (temp file + rename) and guarded by a **file lock**, so parallel
  workers never corrupt the cache or re-login redundantly.
- After a successful `validate`, the freshest state is re-saved.
- Use `maxAgeMs` to proactively invalidate a cache older than your token's lifetime.

If your refresh token is single-use **and** you run with high parallelism, re-logins may
happen more often (correctness is always guaranteed; cache benefit degrades). Mitigate with
`workers: 1` for the authenticated suite, or one `id` per user.

## Multiple users

```ts
// Different ids → independent cached sessions.
await session(context, ['admin', orgId], loginAsAdmin, { validate });
await session(context, ['viewer', orgId], loginAsViewer, { validate });
```

## Notes / limitations

- Applies cookies and `localStorage` to the given context. `IndexedDB` is not captured by
  Playwright's `storageState` (same limitation as the native feature).
- Add `.auth/` to your `.gitignore` — the cache contains live session data.

## License

MIT
