import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
if (pkg.version !== manifest.version) {
  console.error(`Version mismatch: package.json ${pkg.version} vs plugin.json ${manifest.version}`);
  process.exit(1);
}
console.log(`Plugin version ${manifest.version}`);
