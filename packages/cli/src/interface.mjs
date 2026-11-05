// The version stamp written by `shipline init` (.shipline/bin/VERSION) and how it is compared.
// Node 18+, no dependencies.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Bump when stage.mjs commands or flags, the manifest or state file shape, the YAML subset, the hook
// entry points in settings-hooks.json, or what the hooks print change.
// 1 = the 0.3.0 shape. 2 = lost-task warning and visible warn reminders in the guard.
// 3 = tasks, session state and UI data live in the store (~/.shipline/projects/<repo>/), artifact_root and
// folder_pattern are gone from config.yml, and VERSION carries the `files` hash map.
// 4 = Trust: answer-based confirmations (record-answer.mjs, the PostToolUse hook, no --confirmed/--force),
// the store guard, `stage.mjs pr-summary` and the optional CI check.
export const INTERFACE = 4;

// The first interface whose tasks and session state live in the store (interface 3). Below it, `upgrade` moves
// the data out of the repo, and the UI chat stays disabled until then.
export const STORE_INTERFACE = 3;

// What interface-1 repos lack. Used only for banner text.
export const MISSING_BEFORE = ['the lost-task warning', 'visible warn reminders', 'task storage outside the repo (the store)', 'Trust: answer-based confirmations and the CI check'];

// Returns { package, interface, files, excluded }, or { legacy: true, interface: 1 } when the file is missing or unreadable.
export function readRepoVersion(root) {
  try {
    const v = JSON.parse(readFileSync(path.join(root, '.shipline', 'bin', 'VERSION'), 'utf8'));
    if (v && typeof v === 'object' && Number.isInteger(v.interface)) {
      const files = v.files && typeof v.files === 'object' && !Array.isArray(v.files) ? v.files : null;
      const excluded = Array.isArray(v.excluded) ? v.excluded.filter((p) => typeof p === 'string') : [];
      return { package: typeof v.package === 'string' ? v.package : null, interface: v.interface, files, excluded };
    }
  } catch {
    // Missing or unreadable: treated as a legacy repo below.
  }
  return { legacy: true, interface: 1 };
}

// repo and ui are interface numbers or { interface } objects.
export function compareInterface(repo, ui) {
  const r = typeof repo === 'object' && repo !== null ? repo.interface : repo;
  const u = typeof ui === 'object' && ui !== null ? ui.interface : ui;
  if (r === u) return 'same';
  return r < u ? 'repo-older' : 'repo-newer';
}
