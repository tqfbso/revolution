import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages (/revolution/) and locally.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
});
