// Bundles the Shipline plugin with the app (versioned together) for the headless service and the desktop shell.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../../packages/plugin');
const dest = path.resolve(here, '../plugin');

if (!existsSync(src)) {
  console.error(`Plugin source not found at ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: (p) => !p.includes('node_modules') });
console.log(`Bundled plugin into ${dest}`);
