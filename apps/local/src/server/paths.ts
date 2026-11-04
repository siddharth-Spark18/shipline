import fs from 'fs';
import os from 'os';
import path from 'path';

export const CONFIG_DIR = process.env.SHIPLINE_HOME ?? path.join(os.homedir(), '.shipline');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'local.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

const appRoot = path.resolve(__dirname, '..', '..');

/** Bundled plugin (npm package / desktop app) first, then the monorepo copy for development. */
export function resolvePluginDir(): string {
  const candidates = [path.join(appRoot, 'plugin'), path.resolve(appRoot, '..', '..', 'packages', 'plugin')];
  const found = candidates.find((c) => fs.existsSync(path.join(c, '.claude-plugin', 'plugin.json')));
  if (!found) throw new Error('Bundled Shipline plugin not found. Run `pnpm --filter @shipline/local build`.');
  return found;
}

export function readPluginVersion(): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(resolvePluginDir(), '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

export function readAppVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}
