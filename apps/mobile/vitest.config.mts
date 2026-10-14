import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@bate-papo/client': pkg('client'), '@bate-papo/crypto': pkg('crypto') },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 120_000 },
});
