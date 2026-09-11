import { createHash } from 'node:crypto';
import type { SessionId } from './types.js';

/**
 * Serializa um valor de forma determinística: chaves de objeto são ordenadas
 * recursivamente, de modo que {a,b} e {b,a} produzam a mesma string.
 * A ordem de arrays é preservada (é significativa, como no cy.session).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Gera uma chave de cache curta e determinística a partir do id.
 * Usa sha1 apenas como função de hashing para nomear o arquivo — NÃO é segurança.
 * O valor cru do id (que pode conter dados sensíveis) nunca vai para o nome do arquivo.
 */
export function serializeId(id: SessionId): string {
  const normalized = typeof id === 'string' ? id : stableStringify(id);
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}
