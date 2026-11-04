/** Extracts the first `x.y.z` from a string (e.g. "2.1.3 (Claude Code)"); null if none. */
export function parseVersion(input: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(input);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns <0, 0, >0. Unparseable versions compare as lower than any parseable one. */
export function compareVersions(a: string, b: string): number {
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

export function meetsMinVersion(actual: string | null | undefined, min: string | null | undefined): boolean {
  if (!min) return true;
  if (!actual) return false;
  return compareVersions(actual, min) >= 0;
}

export const HEADER_APP_VERSION = 'x-shipline-app-version';
export const HEADER_PLUGIN_VERSION = 'x-shipline-plugin-version';
export const HEADER_CLIENT = 'x-shipline-client';
/** Set by Shipline Local's MCP proxy so the hub knows which ticket a Claude session belongs to. */
export const HEADER_TICKET = 'x-shipline-ticket';
