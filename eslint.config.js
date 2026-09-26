// ESLint flat config for Glass Bank.
//
// Besides the usual TypeScript rules this file encodes the block dependency rules from
// docs/REPO_LAYOUT.md section 3 as `no-restricted-imports` zones:
//
//   contracts  <- imported by everything (types and schemas only)
//   bank-core / etl / xray / auth / tools -> contracts and their own directory only
//   mcp                                   -> contracts, tools (and the MCP SDK)
//   app (src/app.ts, src/composition.ts, src/server.ts, src/config) -> everything, by injection
//
// and the three package gates: only src/mcp may import an MCP SDK, only src/auth and src/xray may
// import `jose`, only src/etl, src/xray and src/auth may import `better-sqlite3`.
//
// Whatever cannot be expressed here (for example "app is the only place with global mutable state")
// is asserted by test/import-boundaries.test.ts, which parses every import in src/.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Every directory under src/ that is a block of its own. */
const BLOCK_DIRECTORIES = [
  'auth',
  'bank-core',
  'config',
  'contracts',
  'etl',
  'mcp',
  'testing',
  'tools',
  'xray',
];

/** Packages that only named blocks may import. */
const GATED_PACKAGES = {
  '@modelcontextprotocol/sdk': ['mcp'],
  '@modelcontextprotocol/server': ['mcp'],
  '@modelcontextprotocol/express': ['mcp'],
  '@modelcontextprotocol/node': ['mcp'],
  '@modelcontextprotocol/server-legacy': ['mcp'],
  jose: ['auth', 'xray'],
  'better-sqlite3': ['auth', 'etl', 'xray'],
};

/** Blocks each block may import in addition to `contracts` and itself. */
const EXTRA_ALLOWED_BLOCKS = {
  auth: [],
  'bank-core': [],
  etl: [],
  mcp: ['tools'],
  tools: [],
  xray: [],
};

/**
 * Relative specifiers that would reach `directory` from anywhere inside src/.
 * Enumerated explicitly because minimatch's `**` does not cross a leading `..` segment.
 */
function relativePatternsFor(directory) {
  const patterns = [];
  for (let depth = 1; depth <= 5; depth += 1) {
    const prefix = '../'.repeat(depth);
    patterns.push(`${prefix}${directory}`, `${prefix}${directory}/*`, `${prefix}${directory}/**`);
  }
  patterns.push(`./${directory}`, `./${directory}/*`, `./${directory}/**`);
  return patterns;
}

/** The composition-root files: no block may import src/app.ts, src/server.ts or src/composition.ts. */
function compositionRootPatterns() {
  const patterns = [];
  for (let depth = 1; depth <= 5; depth += 1) {
    const prefix = '../'.repeat(depth);
    for (const name of ['app', 'server', 'composition']) {
      patterns.push(`${prefix}${name}`, `${prefix}${name}.js`, `${prefix}${name}.ts`);
    }
  }
  return patterns;
}

/** Package specifiers, including subpath imports such as `@modelcontextprotocol/sdk/server/mcp.js`. */
function packagePatternsFor(packageName) {
  return [packageName, `${packageName}/*`, `${packageName}/**`];
}

/**
 * The `no-restricted-imports` option object for one block directory.
 * `allowedBlocks` is what this block may reach besides `contracts` and itself.
 */
function restrictionsFor(blockName, allowedBlocks) {
  const allowed = new Set([blockName, 'contracts', ...allowedBlocks]);
  const groups = [];

  for (const directory of BLOCK_DIRECTORIES) {
    if (allowed.has(directory)) continue;
    groups.push({
      group: relativePatternsFor(directory),
      message:
        `Block "${blockName}" may not import src/${directory} ` +
        '(docs/REPO_LAYOUT.md section 3: blocks import src/contracts only; app wires them together).',
    });
  }

  groups.push({
    group: compositionRootPatterns(),
    message:
      `Block "${blockName}" may not import the composition root (src/app.ts, src/server.ts); ` +
      'app depends on blocks, never the other way round (docs/REPO_LAYOUT.md section 3).',
  });

  for (const [packageName, owners] of Object.entries(GATED_PACKAGES)) {
    if (owners.includes(blockName)) continue;
    groups.push({
      group: packagePatternsFor(packageName),
      message:
        `Only ${owners.map((owner) => `src/${owner}`).join(', ')} may import "${packageName}" ` +
        '(docs/REPO_LAYOUT.md section 3).',
    });
  }

  return ['error', { patterns: groups }];
}

/** One ESLint config object per block directory. */
const blockBoundaryConfigs = Object.entries(EXTRA_ALLOWED_BLOCKS).map(([blockName, allowed]) => ({
  files: [`src/${blockName}/**/*.ts`],
  rules: { 'no-restricted-imports': restrictionsFor(blockName, allowed) },
}));

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
  // src/contracts and src/testing may not reach into any block, and never touch a gated package.
  {
    files: ['src/contracts/**/*.ts'],
    rules: { 'no-restricted-imports': restrictionsFor('contracts', []) },
  },
  {
    files: ['src/testing/**/*.ts'],
    rules: { 'no-restricted-imports': restrictionsFor('testing', ['contracts']) },
  },
  ...blockBoundaryConfigs,
  // The composition root imports every block, but still not a gated package: auth, mcp, etl and
  // xray own their SDK, jose and better-sqlite3 usage and are injected into app.
  {
    files: ['src/app.ts', 'src/server.ts', 'src/composition.ts', 'src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: Object.entries(GATED_PACKAGES).map(([packageName, owners]) => ({
            group: packagePatternsFor(packageName),
            message:
              `Only ${owners.map((owner) => `src/${owner}`).join(', ')} may import "${packageName}"; ` +
              'the composition root receives it through dependency injection (docs/REPO_LAYOUT.md section 3).',
          })),
        },
      ],
    },
  },
  // Plain JavaScript helpers (scripts/, config files) run on Node without types.
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        // WHATWG fetch API, stable on Node since 18. Declared here so plain .mjs helpers
        // (test/e2e/oauth-walk.mjs, scripts/local-login.mjs) do not each need a /* global */ line.
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        FormData: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
