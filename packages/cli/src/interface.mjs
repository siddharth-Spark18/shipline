// The version stamp written by `shipline init` (.shipline/bin/VERSION) and how it is compared.
// Node 18+, no dependencies.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Bump when stage.mjs commands or flags, the manifest or state file shape, the YAML subset, the hook
// entry points in settings-hooks.json, or what the hooks print change.
// 1 = the 1.0.0 shape.
export const INTERFACE = 1;

// What older interfaces lack, for banner text. Empty until interface 2.
export const MISSING_BEFORE = [];

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

// True when a (semver-ish) version a is greater than b. Missing parts count as 0.
export function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// A repo set up with a Shipline before 1.0: its VERSION names a package below 1.0.0, names none, or is missing or
// unreadable (readRepoVersion's { legacy: true }). 1.0 is the first version with an upgrade path, so such a repo starts
// over: uninstall, then init. Used by `upgrade` and the UI.
export function isPreOne(version) {
  return !version || Boolean(version.legacy) || !version.package || semverGt('1.0.0', version.package);
}

// The guidance for a pre-1.0 repo, shared by `upgrade`'s refusal and the UI.
export function preOneMessage(version) {
  const v = version && version.package ? version.package : 'unknown version';
  return `This repo was set up with a pre-1.0 Shipline (${v}). Run \`npx @forgeyard/shipline uninstall --yes\` then \`init\`; task data in ~/.shipline is kept.`;
}

// repo and ui are interface numbers or { interface } objects.
export function compareInterface(repo, ui) {
  const r = typeof repo === 'object' && repo !== null ? repo.interface : repo;
  const u = typeof ui === 'object' && ui !== null ? ui.interface : ui;
  if (r === u) return 'same';
  return r < u ? 'repo-older' : 'repo-newer';
}
