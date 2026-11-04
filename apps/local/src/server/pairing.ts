import crypto from 'crypto';
import { getConfig, saveConfig } from './config';

// Pairing: the tray (or the CLI) shows a one-time code; the browser enters it once and receives a
// token that it stores and sends as the `X-Shipline-Local-Token` header (and WebSocket
// subprotocol). Only the token's hash is kept here. The code is never served over HTTP.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_FAILED_ATTEMPTS = 5;

function newCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

let code = newCode();
let failures = 0;

const normalize = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export function getPairingCode(): string {
  return code;
}

export function regeneratePairingCode(): string {
  code = newCode();
  failures = 0;
  return code;
}

/** Returns a new token for the right code (and burns the code), or null. */
export function pair(submitted: string): string | null {
  const a = Buffer.from(normalize(submitted));
  const b = Buffer.from(normalize(code));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    // Throttle guessing: after a few misses the code changes and must be re-read from the tray.
    if (++failures >= MAX_FAILED_ATTEMPTS) regeneratePairingCode();
    return null;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  saveConfig({ pairedTokenHashes: [...getConfig().pairedTokenHashes, hash(token)] });
  regeneratePairingCode();
  return token;
}

export function isValidToken(token: string): boolean {
  if (!token) return false;
  const h = Buffer.from(hash(token));
  return getConfig().pairedTokenHashes.some((known) => {
    const k = Buffer.from(known);
    return k.length === h.length && crypto.timingSafeEqual(k, h);
  });
}

export function revokeToken(token: string): void {
  const h = hash(token);
  saveConfig({ pairedTokenHashes: getConfig().pairedTokenHashes.filter((k) => k !== h) });
}

export function pairedBrowserCount(): number {
  return getConfig().pairedTokenHashes.length;
}

export function revokeAllTokens(): void {
  saveConfig({ pairedTokenHashes: [] });
}
