// The task store outside the repo ($SHIPLINE_HOME/projects/<key>/). The helpers live in the vendored lib.mjs
// template (the hooks must stay dependency-free); the CLI and UI reuse that one copy so the key scheme (interface 2:
// <encoded main checkout>-<hash>, shared by worktrees; interface 1: the encoded path) is defined once.
// Node 22+, no dependencies.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  encodePath,
  mainRoot,
  storeDirFor,
  storeKey,
  storeScheme,
  shiplineHome,
  storeDir,
  tasksDir,
  stateDir,
  draftsDir,
  draftsTmpDir,
  safeId,
  isInside,
  sameRoot,
  detectEol,
  toEol,
} from '../templates/shipline/bin/lib.mjs';

export { encodePath, mainRoot, storeDirFor, storeKey, storeScheme, shiplineHome, storeDir, tasksDir, stateDir, draftsDir, draftsTmpDir, safeId, isInside, sameRoot, detectEol, toEol };

// <store>/ui/: sessions.json, lock.json, mcp-<id>.json, ui.log and tmp/.
export const uiDir = (root) => path.join(storeDir(root), 'ui');

// The folder names a repo's store may have, newest scheme first: [{ scheme: 2, dir }, { scheme: 1, dir }]. Creates nothing.
export function storeCandidates(root) {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    real = path.resolve(root);
  }
  const projects = path.join(shiplineHome(), 'projects');
  return [
    { scheme: 2, dir: path.join(projects, storeKey(mainRoot(real))) },
    { scheme: 1, dir: path.join(projects, encodePath(real)) },
  ];
}

// Read-only: the store folder this repo uses now (by its installed interface), or an existing one of the other scheme
// when the preferred one isn't there yet (not migrated); null when there is none.
export function peekStore(root) {
  const [fresh, old] = storeCandidates(root);
  const order = storeScheme(root) >= 2 ? [fresh, old] : [old, fresh];
  const hit = order.find((c) => existsSync(c.dir));
  return hit ? hit.dir : null;
}
