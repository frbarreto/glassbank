/**
 * Enforces the block dependency rules of docs/REPO_LAYOUT.md section 3 by parsing every import
 * in src/. ESLint's `no-restricted-imports` zones cover the same ground for editor feedback;
 * this test is the authority because it also sees dynamic imports and re-exports, and it fails
 * for a block directory that nobody remembered to add to eslint.config.js.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/** Directories under src/ that are blocks. Anything else in src/ belongs to the app block. */
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
] as const;

type Block = (typeof BLOCK_DIRECTORIES)[number] | 'app';

/** What each block may import besides `contracts` and itself. `app` may import everything. */
const ALLOWED_BLOCK_IMPORTS: Record<Block, readonly Block[]> = {
  app: [...BLOCK_DIRECTORIES, 'app'],
  config: [...BLOCK_DIRECTORIES, 'app'],
  contracts: ['contracts'],
  testing: ['contracts', 'testing'],
  auth: ['contracts', 'auth'],
  'bank-core': ['contracts', 'bank-core'],
  etl: ['contracts', 'etl'],
  mcp: ['contracts', 'mcp', 'tools'],
  tools: ['contracts', 'tools'],
  xray: ['contracts', 'xray'],
};

/** Packages only the named blocks may import (CLAUDE.md "Block boundaries"). */
const GATED_PACKAGES: Record<string, readonly Block[]> = {
  '@modelcontextprotocol/sdk': ['mcp'],
  '@modelcontextprotocol/server': ['mcp'],
  '@modelcontextprotocol/express': ['mcp'],
  '@modelcontextprotocol/node': ['mcp'],
  '@modelcontextprotocol/server-legacy': ['mcp'],
  jose: ['auth', 'xray'],
  'better-sqlite3': ['auth', 'etl', 'xray'],
};

function listTypeScriptFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Static imports, re-exports and dynamic `import()` calls. Comments are stripped first. */
function extractImportSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** The block a file under src/ belongs to. */
function blockOf(absoluteFile: string): Block {
  const relativePath = relative(SRC_ROOT, absoluteFile).split(/[\\/]/);
  const first = relativePath[0];
  if (first !== undefined && (BLOCK_DIRECTORIES as readonly string[]).includes(first)) {
    return first as Block;
  }
  return 'app';
}

/** The package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

const sourceFiles = listTypeScriptFiles(SRC_ROOT);

describe('block import boundaries (docs/REPO_LAYOUT.md section 3)', () => {
  it('finds the source tree', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('no block imports another block it is not allowed to import', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const from = blockOf(file);
      const allowed = ALLOWED_BLOCK_IMPORTS[from];
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(SRC_ROOT)) {
          violations.push(`${relative(REPO_ROOT, file)} imports outside src/: ${specifier}`);
          continue;
        }
        const to = blockOf(target);
        if (!allowed.includes(to)) {
          violations.push(
            `${relative(REPO_ROOT, file)} (block ${from}) imports block ${to} via "${specifier}"`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('only the owning blocks import a gated package', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const from = blockOf(file);
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const owners = GATED_PACKAGES[packageNameOf(specifier)];
        if (owners && !owners.includes(from)) {
          violations.push(
            `${relative(REPO_ROOT, file)} (block ${from}) imports "${specifier}"; owners: ${owners.join(', ')}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('src/testing is imported by tests only', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const isTest = posix.normalize(file.split(/[\\/]/).join('/')).includes('/__tests__/');
      if (isTest || blockOf(file) === 'testing') continue;
      for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        if (blockOf(resolve(dirname(file), specifier)) === 'testing') {
          violations.push(`${relative(REPO_ROOT, file)} imports src/testing outside a test`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the dashboard block talks HTTP only (no imports from src/)', () => {
    const publicRoot = join(REPO_ROOT, 'public');
    const violations: string[] = [];
    const walk = (directory: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.js')) {
          for (const specifier of extractImportSpecifiers(readFileSync(full, 'utf8'))) {
            if (specifier.includes('src/') || specifier.startsWith('../')) {
              violations.push(`${relative(REPO_ROOT, full)} imports "${specifier}"`);
            }
          }
        }
      }
    };
    walk(publicRoot);
    expect(violations).toEqual([]);
  });
});
