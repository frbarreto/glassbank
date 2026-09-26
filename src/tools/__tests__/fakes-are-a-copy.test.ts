/**
 * The guard that keeps "tested against src/testing/fakes.ts" honest.
 *
 * `src/tools/__tests__/fakes.ts` is a copy, because the block dependency rules forbid this block
 * from importing `src/testing` even from a test. Reading the original from disk is not an import,
 * so this test can compare the two and fail the moment the shared fakes change under us.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MARKER = '// --- verbatim copy of src/testing/fakes.ts begins here ---\n';

describe('the local fakes are a copy of src/testing/fakes.ts', () => {
  it('differs from the shared fakes only in the import path', () => {
    const original = readFileSync(join(REPO_ROOT, 'src', 'testing', 'fakes.ts'), 'utf8');
    const copy = readFileSync(join(HERE, 'fakes.ts'), 'utf8');
    const index = copy.indexOf(MARKER);
    expect(index).toBeGreaterThan(0);
    const body = copy.slice(index + MARKER.length);
    expect(body).toBe(original.replaceAll("'../contracts/index.js'", "'../../contracts/index.js'"));
  });
});
