import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeId, stableStringify } from '../../src/id.ts';

test('serializeId é determinístico para strings', () => {
  assert.equal(serializeId('user'), serializeId('user'));
});

test('serializeId difere para strings diferentes', () => {
  assert.notEqual(serializeId('user'), serializeId('admin'));
});

test('ordem de array é significativa', () => {
  assert.notEqual(serializeId(['a', 'b']), serializeId(['b', 'a']));
});

test('ordem de chaves de objeto NÃO importa (determinístico)', () => {
  assert.equal(serializeId({ a: 1, b: 2 }), serializeId({ b: 2, a: 1 }));
});

test('objetos aninhados são determinísticos', () => {
  const x = serializeId({ user: 'a', meta: { role: 'admin', region: 'br' } });
  const y = serializeId({ meta: { region: 'br', role: 'admin' }, user: 'a' });
  assert.equal(x, y);
});

test('stableStringify ordena chaves recursivamente', () => {
  assert.equal(
    stableStringify({ b: { d: 1, c: 2 }, a: 3 }),
    '{"a":3,"b":{"c":2,"d":1}}',
  );
});

test('serializeId retorna hash curto (16 hex)', () => {
  assert.match(serializeId('anything'), /^[0-9a-f]{16}$/);
});
