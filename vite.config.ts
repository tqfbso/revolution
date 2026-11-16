import { defineConfig } from 'vitest/config';

// The page may run only its own scripts, and talk only to itself and the co-op meeting point
// (security review). Set in the page, because GitHub Pages cannot send headers; the dev
// server is left without it, as it needs inline scripts of its own. Styles stay
// 'unsafe-inline': the interface writes style attributes everywhere, and styles cannot run
// code. WebRTC between players is not something this policy governs.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://0.peerjs.com wss://0.peerjs.com",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export default defineConfig({
  plugins: [
    {
      name: 'content-security-policy',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        ),
    },
  ],
  // Relative base so the same build works on GitHub Pages (/revolution/) and locally.
  base: './',
  // Short commit id shown in the overlay, so it is obvious which build is live.
  define: { __BUILD__: JSON.stringify((process.env.GITHUB_SHA ?? 'dev').slice(0, 7)) },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  // Whole games are simulated in the tests; a shared CI runner needs more than the 5 s default.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
