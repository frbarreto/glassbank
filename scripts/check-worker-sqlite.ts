#!/usr/bin/env tsx
/**
 * Alias kept for the T0.1 ticket's verification command
 * (`npx tsx scripts/check-worker-sqlite.ts`). The real check lives in
 * scripts/smoke-worker-sqlite.mjs so it can run with plain `node`, with no
 * TypeScript toolchain, inside the container and from the Makefile.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./smoke-worker-sqlite.mjs', import.meta.url));
const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
process.exit(result.status ?? 1);
