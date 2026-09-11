import type { BrowserContext } from '@playwright/test';

/**
 * Identificador da sessão. Pode ser string, array ou objeto — como no cy.session.
 * Arrays/objetos são serializados deterministicamente para gerar a chave de cache.
 */
export type SessionId = string | Array<string | number> | Record<string, unknown>;

/**
 * Função de validação da sessão. A sessão é considerada INVÁLIDA quando:
 * - lança uma exceção;
 * - retorna uma Promise que rejeita;
 * - retorna/resolve `false`.
 * Caso contrário (void/true/qualquer valor != false) é considerada VÁLIDA.
 */
export type ValidateFn = () => Promise<void> | Promise<boolean> | boolean | void;

/** Função de setup (login). Equivale ao 2º argumento do cy.session. */
export type SetupFn = () => Promise<void> | void;

/**
 * Evento emitido durante o ciclo de vida da sessão, para observabilidade.
 * - `created`:   não havia cache → login executado e sessão criada.
 * - `restored`:  cache existia e validou → sessão restaurada sem relogar.
 * - `recreated`: cache existia mas o validate falhou → relogin executado.
 * - `validating`: início da validação de um cache existente.
 */
export type SessionEventType = 'created' | 'restored' | 'recreated' | 'validating';

export interface SessionEvent {
  type: SessionEventType;
  /** Chave (hash) do id no cache. */
  key: string;
  /** Mensagem legível pronta para log/step. */
  message: string;
}

export type OnEventFn = (event: SessionEvent) => void | Promise<void>;

export interface SessionOptions {
  /** Revalida a sessão. Se falhar ao restaurar, o setup é re-executado (re-login). */
  validate?: ValidateFn;
  /** Callback de observabilidade: recebe eventos (created/restored/recreated). */
  onEvent?: OnEventFn;
  /** Pasta onde o estado é salvo. Default: ".auth". */
  cacheDir?: string;
  /** Compartilha o cache entre specs/workers via disco. Default: true. */
  cacheAcrossSpecs?: boolean;
  /** Invalida o cache por idade (ms). Defesa extra para token de vida curta. */
  maxAgeMs?: number;
  /** Lock de arquivo para evitar corrida entre workers. Default: true. */
  lock?: boolean;
  /** Timeout para adquirir o lock (ms). Default: 30000. */
  lockTimeoutMs?: number;
  /** Idade a partir da qual um lock é considerado órfão e recuperado (ms). Default: 60000. */
  staleLockMs?: number;
}

export type { BrowserContext };
