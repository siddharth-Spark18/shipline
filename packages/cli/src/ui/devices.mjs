// Paired phones: the device store ($SHIPLINE_HOME/devices.json, shared by every repo and every `shipline ui`
// process) and the one-time pairing codes (in memory). Node 20+, no dependencies.
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shiplineHome } from '../store.mjs';
import { safeEqual } from './auth.mjs';

export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
export const NAME_MAX = 40;
export const SHORT_CODE_TRIES = 5;
// No 0, O, 1, I or L (look-alikes): 31 characters, so 8 of them are about 40 bits.
const SHORT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SHORT_LENGTH = 8;
const TOUCH_INTERVAL_MS = 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// What a person types: any case, with or without the dash and spaces.
export const normalizeShortCode = (s) =>
  (typeof s === 'string' ? s : '').replace(/[\s-]+/g, '').toUpperCase();

function newShortCode() {
  let out = '';
  for (let i = 0; i < SHORT_LENGTH; i++)
    out += SHORT_ALPHABET[crypto.randomInt(SHORT_ALPHABET.length)];
  return out;
}

// `now` is injectable so tests can move the clock.
export function createDevices({ now = () => Date.now(), file = null } = {}) {
  const filePath = () => file || path.join(shiplineHome(), 'devices.json');
  let cache = [];
  let stamp = null; // "mtimeMs:size" of the file as last read
  // One open pairing per "Pair a phone": its link code and its short code, both single use, shared expiry.
  const pairings = new Map(); // id -> { long: sha256(code), short: sha256(shortCode), expiresAt (ms) }
  let wrongShort = 0; // wrong short codes in a row, across all devices
  let cancelled = false; // set when SHORT_CODE_TRIES wrong codes cancelled every open pairing
  const lastTouch = new Map(); // device id -> ms of the last write

  // Re-reads the file when it changed, so several `shipline ui` processes agree. A missing or broken file is
  // an empty list: nobody is paired (fail closed).
  function load() {
    let st;
    try {
      st = statSync(filePath());
    } catch {
      cache = [];
      stamp = null;
      return cache;
    }
    const s = `${st.mtimeMs}:${st.size}`;
    if (s === stamp) return cache;
    try {
      const data = JSON.parse(readFileSync(filePath(), 'utf8'));
      cache = Array.isArray(data && data.devices)
        ? data.devices.filter(
            (d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string',
          )
        : [];
    } catch {
      cache = [];
    }
    stamp = s;
    return cache;
  }

  // tmp + rename, so a reader never sees half a file.
  function save(devices) {
    const f = filePath();
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, f);
    stamp = null; // re-read on next use
    load();
  }

  const publicDevice = (d) => ({
    id: d.id,
    name: d.name,
    pairedAt: d.pairedAt,
    lastSeenAt: d.lastSeenAt,
  });

  function claimWith(kind, hash, name) {
    if (cancelled) return { error: 'pairing-cancelled' };
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean.length < 1 || clean.length > NAME_MAX) return { error: 'bad-name' };
    const t = now();
    for (const [k, p] of pairings) if (p.expiresAt <= t) pairings.delete(k);
    // Nothing open to guess at: not a wrong try.
    if (pairings.size === 0) return { error: 'bad-code' };
    const hit = [...pairings].find(([, p]) => p[kind] === hash);
    if (!hit) {
      if (kind === 'long') return { error: 'bad-code' };
      wrongShort += 1;
      if (wrongShort >= SHORT_CODE_TRIES) {
        pairings.clear();
        cancelled = true;
        wrongShort = 0;
        return { error: 'pairing-cancelled' };
      }
      return { error: 'bad-code' };
    }
    pairings.delete(hit[0]);
    wrongShort = 0;
    const id = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const at = new Date(t).toISOString();
    const device = { id, name: clean, tokenHash: sha256(secret), pairedAt: at, lastSeenAt: at };
    save([...load(), device]);
    return { device: publicDevice(device), cookie: `${id}.${secret}` };
  }

  return {
    list() {
      return load().map(publicDevice);
    },

    has(id) {
      return load().some((d) => d.id === id);
    },

    // Whether too many wrong short codes cancelled the open pairings. Cleared by the next createCode().
    cancelled() {
      return cancelled;
    },

    // A new pairing: a link code and a short code (XXXX-XXXX), valid for 5 minutes; using either consumes both.
    // Older pairings stay valid. Clears the cancelled state and the wrong-code counter.
    createCode() {
      const t = now();
      for (const [k, p] of pairings) if (p.expiresAt <= t) pairings.delete(k);
      cancelled = false;
      wrongShort = 0;
      const code = crypto.randomBytes(32).toString('hex');
      const short = newShortCode();
      const expiresAt = t + PAIR_CODE_TTL_MS;
      pairings.set(crypto.randomBytes(8).toString('hex'), {
        long: sha256(code),
        short: sha256(short),
        expiresAt,
      });
      return {
        code,
        shortCode: `${short.slice(0, 4)}-${short.slice(4)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    // Consumes the pairing the link code belongs to and stores the device. Returns { device, cookie } or
    // { error: 'bad-code' | 'bad-name' | 'pairing-cancelled' }. The name is checked first, so a typo does not
    // burn the code.
    claim(code, name) {
      return claimWith('long', sha256(typeof code === 'string' ? code : ''), name);
    },

    // Same, with the short code a person typed. A wrong one counts toward SHORT_CODE_TRIES (only while a pairing is
    // open); the last one cancels every open pairing and answers `pairing-cancelled`.
    claimShort(shortCode, name) {
      return claimWith('short', sha256(normalizeShortCode(shortCode)), name);
    },

    // Cookie value -> { id, name } for a paired, not revoked device; null otherwise.
    verify(cookie) {
      if (typeof cookie !== 'string') return null;
      const dot = cookie.indexOf('.');
      if (dot < 1) return null;
      const id = cookie.slice(0, dot);
      const device = load().find((d) => d.id === id);
      if (!device) return null;
      if (!safeEqual(sha256(cookie.slice(dot + 1)), device.tokenHash)) return null;
      return { id: device.id, name: device.name };
    },

    // lastSeenAt, written at most once a minute per device.
    touch(id) {
      const t = now();
      if (t - (lastTouch.get(id) || 0) < TOUCH_INTERVAL_MS) return;
      lastTouch.set(id, t);
      try {
        const devices = load();
        const d = devices.find((x) => x.id === id);
        if (!d) return;
        save(
          devices.map((x) => (x.id === id ? { ...x, lastSeenAt: new Date(t).toISOString() } : x)),
        );
      } catch {
        // A failed write must not fail the request.
      }
    },

    // True when the device existed.
    revoke(id) {
      stamp = null; // always start from the file: another process may have written it
      const devices = load();
      if (!devices.some((d) => d.id === id)) return false;
      save(devices.filter((d) => d.id !== id));
      return true;
    },
  };
}
