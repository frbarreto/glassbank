/**
 * Vitest configuration for the dashboard lane (block: dashboard).
 *
 * The root vitest.config.ts collects `src/**` and `test/**`; the dashboard lives in `public/` and
 * owns none of those paths, so it carries its own config until the integrator adds
 * `public/__tests__/**` to the root include list.
 *
 * Run: npx vitest run --config public/_dev/vitest.config.mjs
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['public/__tests__/**/*.test.mjs'],
    reporters: ['default'],
    globals: false,
  },
});
