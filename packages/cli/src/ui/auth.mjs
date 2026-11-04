// Request checks for the local UI server: Host, cookie and Origin. Node 20+, no dependencies.
// The Host check follows the v1 hub (removed); safeEqual too.
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';

// Equal byte lengths first (timingSafeEqual throws otherwise), so a wrong-length value is a plain
// mismatch and never a 500.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Call after `listen`, with the real port: the token's cookie name and the Host check depend on it.
export function createAuth(port) {
  const token = crypto.randomBytes(32).toString('hex');
  const cookieName = `shipline_ui_${port}`;
  const host = `127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${port}`;
  const devOrigin = process.env.SHIPLINE_UI_DEV_ORIGIN || null;

  function cookieValue(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
    }
    return null;
  }

  return {
    token,
    cookieName,
    devOrigin,

    // route: { method, pathname, isStatic }. Throws HttpError.
    check(req, route) {
      if (req.headers.host !== host) throw new HttpError(403, 'bad-host', 'Host not allowed');
      const relay = route.pathname === '/api/relay';
      if (relay) {
        // Its caller is relay.mjs, a Node process: no cookie, never an Origin. The per-spawn secret
        // is checked by the handler (prompts.mjs, Phase 2).
        if (req.headers.origin !== undefined)
          throw new HttpError(403, 'bad-origin', 'Origin not allowed');
        return;
      }
      if (!route.isStatic) {
        const c = cookieValue(req);
        if (c === null || !safeEqual(c, token))
          throw new HttpError(401, 'no-session', 'No valid session cookie');
      }
      if (route.method === 'POST') {
        const o = req.headers.origin;
        if (
          o === undefined ||
          !(safeEqual(o, origin) || (devOrigin !== null && safeEqual(o, devOrigin)))
        ) {
          throw new HttpError(403, 'bad-origin', 'Origin not allowed');
        }
      }
    },

    // GET /?t=<token>: swap the token for the cookie and drop it from the URL.
    exchange(req, res, supplied) {
      if (!safeEqual(supplied, token)) throw new HttpError(403, 'bad-token', 'Wrong token');
      res.writeHead(302, {
        'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: '/',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
    },
  };
}
