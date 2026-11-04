// node-pty's prebuilt `spawn-helper` can be installed without its execute bit (pnpm), which makes
// every PTY spawn fail with "posix_spawnp failed". Restore it after install; no-op if node-pty is absent.
import { chmodSync, existsSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
let root;
try {
  root = path.dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}
const prebuilds = path.join(root, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
