import type { OnEventFn, SessionEvent } from './types.js';

/** Interface mínima do objeto `test` do @playwright/test necessária para os steps. */
export interface StepRunner {
  step: <T>(title: string, body: () => Promise<T>) => Promise<T>;
}

export interface StepReporterOptions {
  /** Prefixo do título do step. Default: "session". */
  prefix?: string;
  /** Também loga no console. Default: true. */
  log?: boolean;
}

/** Rótulo legível padrão para cada tipo de evento. */
function defaultLabel(event: SessionEvent): string {
  switch (event.type) {
    case 'restored':
      return 'session RESTORED from cache (no re-login)';
    case 'created':
      return 'session CREATED (login performed)';
    case 'recreated':
      return 'session RECREATED (invalid cache, re-login)';
    case 'validating':
    default:
      return 'validating cached session';
  }
}

/**
 * Cria um `onEvent` pronto que reporta o ciclo de vida da sessão como steps do
 * Playwright (visíveis nas actions/trace) e, opcionalmente, no console.
 *
 * Uso:
 * ```ts
 * import { test } from '@playwright/test';
 * import { session, stepReporter } from 'playwright-session-manager';
 *
 * await session(context, id, setup, {
 *   validate,
 *   onEvent: stepReporter(test),
 * });
 * ```
 */
export function stepReporter(test: StepRunner, options: StepReporterOptions = {}): OnEventFn {
  const prefix = options.prefix ?? 'session';
  const log = options.log ?? true;

  return async (event: SessionEvent) => {
    await test.step(`[${prefix}] ${defaultLabel(event)}`, async () => {
      if (log) {
        // eslint-disable-next-line no-console
        console.log(`[playwright-session-manager] ${event.type}: ${event.message}`);
      }
    });
  };
}
