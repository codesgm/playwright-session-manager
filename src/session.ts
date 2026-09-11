import { join } from 'node:path';
import { serializeId } from './id.js';
import { readState, saveState, type StorageState } from './cache.js';
import { withLock } from './lock.js';
import type {
  BrowserContext,
  SessionId,
  SessionOptions,
  SetupFn,
  ValidateFn,
} from './types.js';

interface OriginEntry {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
}

/**
 * Executa a função de validação e retorna se a sessão é válida.
 * Regras idênticas ao cy.session:
 *   - sem validate → válido;
 *   - exceção/reject → inválido;
 *   - resolve/retorna `false` → inválido;
 *   - void/true/qualquer outro → válido.
 */
async function runValidate(validate?: ValidateFn): Promise<boolean> {
  if (!validate) return true;
  try {
    const result = await validate();
    return result !== false;
  } catch {
    return false;
  }
}

/** Aplica cookies + localStorage/sessionStorage de um storageState a um context já existente. */
async function applyState(context: BrowserContext, state: StorageState): Promise<void> {
  if (Array.isArray(state.cookies) && state.cookies.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await context.addCookies(state.cookies as any);
  }

  const origins = (state.origins as OriginEntry[]) ?? [];
  if (origins.length > 0) {
    // Semeia localStorage por origin antes de qualquer navegação, para que a página já
    // carregue autenticada. O script roda no documento de cada origin correspondente.
    await context.addInitScript((seed: OriginEntry[]) => {
      try {
        const current = window.location.origin;
        for (const entry of seed) {
          if (entry.origin !== current) continue;
          for (const kv of entry.localStorage ?? []) {
            window.localStorage.setItem(kv.name, kv.value);
          }
        }
      } catch {
        /* alguns contextos (ex.: about:blank) não permitem acesso a storage */
      }
    }, origins);
  }
}

/**
 * Equivalente ao cy.session do Cypress para Playwright.
 *
 * Fluxo:
 *  1. Se existe cache válido para o `id` → restaura → valida.
 *       - válido → regrava o estado (token fresco) e retorna.
 *       - inválido → cai para o setup.
 *  2. Roda `setup` (login) → valida.
 *       - inválido logo após setup → erro (não faz loop infinito).
 *  3. Persiste o novo estado em disco.
 *
 * Toda a operação roda sob lock de arquivo (quando habilitado), de modo que workers
 * paralelos com o mesmo `id` não reloguem em duplicidade nem corrompam o cache.
 */
export async function session(
  context: BrowserContext,
  id: SessionId,
  setup: SetupFn,
  options: SessionOptions = {},
): Promise<void> {
  const {
    validate,
    onEvent,
    cacheDir = '.auth',
    maxAgeMs,
    lock = true,
    lockTimeoutMs,
    staleLockMs,
  } = options;

  const key = serializeId(id);
  const file = join(cacheDir, `${key}.json`);

  const emit = async (
    type: 'created' | 'restored' | 'recreated' | 'validating',
    message: string,
  ): Promise<void> => {
    if (onEvent) await onEvent({ type, key, message });
  };

  const run = async (): Promise<void> => {
    // 1. tenta restaurar do cache
    const cached = readState(file, maxAgeMs);
    if (cached) {
      await applyState(context, cached);
      await emit('validating', `validating cached session (${key})`);
      if (await runValidate(validate)) {
        // regrava o estado atual (caso o token tenha rotacionado durante o validate)
        await saveState(context, file);
        await emit('restored', `session restored from cache (${key})`);
        return;
      }
      // validate falhou ao restaurar → prossegue para relogin
      await emit('recreated', `invalid cache, re-running login (${key})`);
    }

    // 2. setup (login)
    await setup();

    if (validate) {
      const ok = await runValidate(validate);
      if (!ok) {
        throw new Error(
          'playwright-session-manager: session validation failed immediately after setup. ' +
            'Verifique se o setup realmente autentica e se o validate confere o estado correto.',
        );
      }
    }

    // 3. persiste
    await saveState(context, file);
    // se havia cache mas caiu aqui, já emitimos 'recreated'; senão, é criação nova
    if (!cached) {
      await emit('created', `new session created via login (${key})`);
    }
  };

  if (lock) {
    await withLock(file, run, { timeoutMs: lockTimeoutMs, staleMs: staleLockMs });
  } else {
    await run();
  }
}
