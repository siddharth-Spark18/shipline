#!/usr/bin/env node
// Records the hashes of the current templates in src/known-hashes.json under the package version.
// Run it before each release: `upgrade` uses these hashes to tell unedited files from edited ones in repos
// that have no VERSION.files record. The publish workflow fails when the version has no entry.
// Format: { "<repo-relative path>": { "<sha256>": "<package version that shipped it>" } }
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION, templateHashes } from '../src/hashes.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'known-hashes.json');
const known = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};

let added = 0;
for (const [p, hash] of Object.entries(templateHashes())) {
  known[p] ||= {};
  if (!known[p][hash]) {
    known[p][hash] = PACKAGE_VERSION;
    added++;
  }
}
const sorted = Object.fromEntries(Object.keys(known).sort().map((k) => [k, known[k]]));
writeFileSync(FILE, JSON.stringify(sorted, null, 2) + '\n');
console.log(`known-hashes.json: ${added} new hash(es) recorded for ${PACKAGE_VERSION}.`);
