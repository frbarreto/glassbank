import { defineConfig } from 'vitest/config';

// Unit and contract tests run from src/**/__tests__ and test/ (see docs/REPO_LAYOUT.md section 7).
// `npx vitest run src/<block>` must work for a single block in isolation.
//
// `public/__tests__/**/*.test.mjs` is the dashboard block. It has no bundler and no DOM library -
// its panels are pure functions of a virtual-node tree - so it runs on plain Node in this same
// process and needs no environment of its own (docs/blocks/dashboard.md). It is in the root
// include list so `npm run check` is the single definition of green for the whole repository;
// `public/_dev/vitest.config.mjs` still runs that lane alone.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.test.ts',
      'test/**/*.test.ts',
      'public/__tests__/**/*.test.mjs',
    ],
    exclude: ['node_modules/**', 'dist/**', 'test/e2e/**'],
    reporters: ['default'],
    globals: false,
    // A laptop runs this beside an IDE and every fork loads its own native better-sqlite3.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4 } },
  },
});
