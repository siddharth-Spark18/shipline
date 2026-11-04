// Version comparison for the minimum `claude` check. Copied from packages/shared/src/versions.ts.
// Node 20+, no dependencies.

// Extracts the first `x.y.z` from a string (e.g. "2.1.3 (Claude Code)"); null if none.
export function parseVersion(input) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(input));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Returns <0, 0, >0. Unparseable versions compare as lower than any parseable one.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function meetsMinVersion(actual, min) {
  if (!min) return true;
  if (!actual) return false;
  return compareVersions(actual, min) >= 0;
}
