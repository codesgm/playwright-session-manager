import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../../src/lock.ts';

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psm-lock-'));
  return join(dir, 'resource');
}

test('serializa incrementos concorrentes sem corrida', async () => {
  const file = tmpFile();
  writeFileSync(file, '0');
  const N = 25;

  await Promise.all(
    Array.from({ length: N }, () =>
      withLock(file, async () => {
        const current = Number(readFileSync(file, 'utf8'));
        // pequeno atraso para forçar sobreposição se não houvesse lock
        await new Promise((r) => setTimeout(r, 1));
        writeFileSync(file, String(current + 1));
      }),
    ),
  );

  assert.equal(Number(readFileSync(file, 'utf8')), N);
});

test('libera o lock após a seção crítica', async () => {
  const file = tmpFile();
  await withLock(file, async () => {});
  assert.equal(existsSync(`${file}.lock`), false);
});

test('libera o lock mesmo se fn lançar', async () => {
  const file = tmpFile();
  await assert.rejects(
    withLock(file, async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(existsSync(`${file}.lock`), false);
});

test('recupera lock órfão (stale)', async () => {
  const file = tmpFile();
  const lockDir = `${file}.lock`;
  mkdirSync(lockDir);
  // envelhece o lock em 5 minutos
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lockDir, old, old);

  let ran = false;
  await withLock(file, async () => {
    ran = true;
  }, { staleMs: 1_000 });

  assert.equal(ran, true);
});

test('timeout quando lock permanece preso e não é stale', async () => {
  const file = tmpFile();
  mkdirSync(`${file}.lock`); // lock fresco, nunca liberado
  await assert.rejects(
    withLock(file, async () => {}, { timeoutMs: 300, staleMs: 60_000 }),
    /lock timeout/,
  );
});
