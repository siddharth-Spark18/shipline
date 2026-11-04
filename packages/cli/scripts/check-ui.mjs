// Fails if ui-dist/index.html is missing or the gzipped JS and CSS are over the size budget.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET = 400 * 1024;
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui-dist');

function walk(dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('ui-dist/index.html is missing. Build the UI first.');
  process.exit(1);
}

let total = 0;
for (const file of walk(dist)) {
  if (file.endsWith('.js') || file.endsWith('.css')) total += gzipSync(readFileSync(file)).length;
}
const kb = (total / 1024).toFixed(1);
if (total > BUDGET) {
  console.error(`The UI bundle is ${kb} KB gzipped (JS plus CSS); the budget is 400 KB.`);
  process.exit(1);
}
console.log(`The UI bundle is ${kb} KB gzipped (budget 400 KB).`);
