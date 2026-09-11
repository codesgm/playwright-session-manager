import { mkdirSync, rmSync, statSync } from 'node:fs';

export interface LockOptions {
  /** Timeout para adquirir o lock (ms). Default: 30000. */
  timeoutMs?: number;
  /** Idade a partir da qual um lock é considerado órfão (ms). Default: 60000. */
  staleMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStale(lockDir: string, staleMs: number): boolean {
  try {
    const { mtimeMs } = statSync(lockDir);
    return Date.now() - mtimeMs > staleMs;
  } catch {
    // sumiu enquanto checávamos → não está mais travado
    return true;
  }
}

/**
 * Executa `fn` sob um mutex baseado em `mkdir` atômico (portátil entre plataformas).
 * - Se o lock existe e está órfão (mais velho que staleMs), recupera.
 * - Faz backoff com jitter para evitar thundering herd.
 * - Sempre libera o lock no finally.
 */
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockDir = `${file}.lock`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 60_000;
  const start = Date.now();

  // adquire
  for (;;) {
    try {
      mkdirSync(lockDir);
      break; // conseguiu o lock
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;

      if (isStale(lockDir, staleMs)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* outro worker pode ter removido; ignora e tenta de novo */
        }
        continue;
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`playwright-session-manager: lock timeout on ${lockDir}`);
      }

      await sleep(50 + Math.floor(Math.random() * 50)); // backoff + jitter
    }
  }

  // seção crítica
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
