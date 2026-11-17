// Server-wide UI preferences: $SHIPLINE_HOME/ui-preferences.json ({ version: 1, palette }), shared by every project
// and every browser or paired phone. GET/POST /api/preferences; a change is broadcast as the SSE event `preferences`.
// Node 20+, no dependencies.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shiplineHome } from '../store.mjs';
import { HttpError } from './http.mjs';

export const PALETTES = ['classic', 'graphite', 'ink', 'sage', 'mocha'];
export const DEFAULT_PALETTE = 'mocha';

export const preferencesFile = () => path.join(shiplineHome(), 'ui-preferences.json');

// The whole file as an object ({} when it is missing, unreadable or not an object). Never throws, never writes.
function readFile() {
  try {
    const data = JSON.parse(readFileSync(preferencesFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// { palette }: an unknown or missing palette reads as the default.
export function readPreferences() {
  const { palette } = readFile();
  return { palette: PALETTES.includes(palette) ? palette : DEFAULT_PALETTE };
}

// Merges `patch` into the file (other keys are kept) and writes it atomically, mode 0600. Throws when it can't write.
export function writePreferences(patch) {
  const file = preferencesFile();
  const next = { ...readFile(), version: 1, ...patch };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

export function routes(app) {
  return [
    { method: 'GET', path: '/api/preferences', handler: () => readPreferences() },
    {
      method: 'POST',
      path: '/api/preferences',
      handler: ({ body }) => {
        const palette = body && typeof body === 'object' ? body.palette : undefined;
        if (typeof palette !== 'string' || !PALETTES.includes(palette))
          throw new HttpError(400, 'bad-request', `palette must be one of ${PALETTES.join(', ')}`);
        try {
          writePreferences({ palette });
        } catch (e) {
          throw new HttpError(
            500,
            'preferences-write-failed',
            `Could not save the palette (${e && e.message})`,
          );
        }
        app.hub.send('preferences', { palette });
        return { palette };
      },
    },
  ];
}
