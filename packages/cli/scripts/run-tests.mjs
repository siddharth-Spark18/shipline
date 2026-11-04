#!/usr/bin/env node
// Runs the test suite without relying on the shell to expand `*` (cmd.exe on Windows doesn't, and
// `node --test <dir>` would also pick up the helper scripts under test/fixtures).
//   node scripts/run-tests.mjs          → test/*.test.mjs and test/ui/*.test.mjs
//   node scripts/run-tests.mjs hooks    → test/*.test.mjs only (the Node 18 subset)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = process.argv[2] === 'hooks' ? ['test'] : ['test', path.join('test', 'ui')];

const files = dirs.flatMap((d) =>
  readdirSync(path.join(root, d))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join(d, f)),
);
if (files.length === 0) {
  console.error('run-tests: no test files found');
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
