import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Os .d.ts são gerados pelo tsc (com declarationMap) para o Ctrl+Click
  // navegar até o código-fonte original em src/.
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node18',
});
