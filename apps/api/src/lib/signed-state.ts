import crypto from 'crypto';
import { env } from './env';

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Signs an OAuth `state` payload (HMAC keyed on the JWT secret + timestamp) so a callback can
 * prove it was issued by this server. Stateless — no nonce store needed.
 */
export function signState(payload: Record<string, string>): string {
  const body = { ...payload, ts: Date.now() };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = crypto.createHmac('sha256', env.jwtSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyState(state: string): Record<string, string> | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', env.jwtSecret).update(encoded).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
      string,
      string | number
    >;
    const ts = Number(payload.ts);
    if (!Number.isFinite(ts) || Date.now() - ts > OAUTH_STATE_MAX_AGE_MS) return null;
    return payload as Record<string, string>;
  } catch {
    return null;
  }
}
