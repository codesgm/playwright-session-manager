import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BrowserContext } from './types.js';

/** Estrutura do storageState do Playwright. */
export interface StorageState {
  cookies: unknown[];
  origins: unknown[];
}

interface CacheFile extends StorageState {
  __meta: { savedAt: number; version: number };
}

const VERSION = 1;

/**
 * Lê o estado do disco.
 * Retorna null se: arquivo ausente, corrompido/parcial, ou mais velho que maxAgeMs.
 */
export function readState(file: string, maxAgeMs?: number): StorageState | null {
  if (!existsSync(file)) return null;

  let data: CacheFile;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as CacheFile;
  } catch {
    return null; // corrompido → tratar como ausente (força relogin)
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.cookies)) {
    return null;
  }

  if (maxAgeMs != null && data.__meta && typeof data.__meta.savedAt === 'number') {
    if (Date.now() - data.__meta.savedAt > maxAgeMs) return null; // expirado por idade
  }

  return { cookies: data.cookies, origins: data.origins ?? [] };
}

/**
 * Persiste o estado atual do context em disco de forma ATÔMICA
 * (escreve em .tmp e faz rename), evitando que leitores vejam arquivo meio-escrito.
 */
export async function saveState(context: BrowserContext, file: string): Promise<void> {
  const state = (await context.storageState()) as unknown as StorageState;
  const payload: CacheFile = {
    __meta: { savedAt: Date.now(), version: VERSION },
    cookies: state.cookies ?? [],
    origins: state.origins ?? [],
  };

  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, file); // rename é atômico no mesmo filesystem
}
