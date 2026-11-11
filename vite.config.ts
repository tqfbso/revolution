import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the same build works on GitHub Pages (/revolution/) and locally.
  base: './',
  // Short commit id shown in the overlay, so it is obvious which build is live.
  define: { __BUILD__: JSON.stringify((process.env.GITHUB_SHA ?? 'dev').slice(0, 7)) },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  // Whole games are simulated in the tests; a shared CI runner needs more than the 5 s default.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
