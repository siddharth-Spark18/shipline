// Builds packages/ui into packages/cli/ui-dist, then checks the bundle. Run by `prepack`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// pnpm runs the build with packages/ui as the working directory, so the output path must be absolute.
const out = path.resolve(here, '..', 'ui-dist');

// On Windows pnpm is pnpm.cmd, which Node only runs through a shell (EINVAL/ENOENT otherwise). The
// arguments are fixed strings, so the shell needs no quoting.
const build = spawnSync('pnpm', ['--filter', '@shipline/ui', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, SHIPLINE_UI_OUT: out },
  shell: process.platform === 'win32',
});
if (build.error) {
  console.error(`Could not run pnpm: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const check = spawnSync(process.execPath, [path.join(here, 'check-ui.mjs')], { stdio: 'inherit' });
process.exit(check.status ?? 1);
