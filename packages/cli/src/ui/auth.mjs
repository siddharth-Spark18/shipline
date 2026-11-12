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

export const DEVICE_COOKIE = 'shipline_device';
// 400 days, the browser maximum. A pairing never expires; scanning again restores the cookie.
export const DEVICE_COOKIE_MAX_AGE = 34560000;

// Call after `listen`, with the real port: the token's cookie name and the Host check depend on it. `app.remote`
// (see remote.mjs) is read on every call, so turning phone access on or off needs no new auth.
export function createAuth(port, app = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const cookieName = `shipline_ui_${port}`;
  const host = `127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${port}`;
  const devOrigin = process.env.SHIPLINE_UI_DEV_ORIGIN || null;

  function cookieValue(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  }

  // 'laptop' for the loopback Host, 'remote' for the one ts.net name and port this server registered (only
  // while phone access is on), else 403 bad-host.
  function classify(req) {
    const h = req.headers.host;
    if (h === host) return 'laptop';
    const r = app.remote;
    if (r && r.enabled && r.host && typeof h === 'string') {
      const lower = h.toLowerCase();
      const port = r.httpsPort;
      if (lower === `${r.host}:${port}` || (port === 443 && lower === r.host)) return 'remote';
    }
    throw new HttpError(403, 'bad-host', 'Host not allowed');
  }

  function checkLaptop(req, route) {
    const relay = route.pathname === '/api/relay';
    if (relay) {
      // Its caller is relay.mjs, a Node process: no cookie, never an Origin. The per-spawn secret
      // is checked by the handler (prompts.mjs, Phase 2).
      if (req.headers.origin !== undefined)
        throw new HttpError(403, 'bad-origin', 'Origin not allowed');
      return { kind: 'laptop' };
    }
    if (!route.isStatic) {
      const c = cookieValue(req, cookieName);
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
    return { kind: 'laptop' };
  }

  function checkRemote(req, route) {
    const r = app.remote;
    // 1. Phone access is on.
    if (!r || !r.enabled || !r.host) throw new HttpError(403, 'remote-off', 'Phone access is off');
    // 2. The same Tailscale user as the one logged in on this machine.
    const login = req.headers['tailscale-user-login'];
    if (
      typeof login !== 'string' ||
      !r.loginName ||
      !safeEqual(login.toLowerCase(), String(r.loginName).toLowerCase())
    )
      throw new HttpError(403, 'wrong-tailscale-user', 'Not the Tailscale user of this machine');
    // 3. The permission relay is laptop-only.
    if (route.pathname === '/api/relay') throw new HttpError(403, 'bad-host', 'Host not allowed');
    let who = { kind: 'device', deviceId: null, name: null };
    if (!route.isStatic) {
      if (route.method === 'POST' && route.pathname === '/api/remote/claim') {
        // 4. Pairing: the code (checked by the handler) is the credential.
      } else {
        // 5. Everything else needs a paired, not revoked device.
        const device = r.devices.verify(cookieValue(req, DEVICE_COOKIE));
        if (!device) throw new HttpError(401, 'not-paired', 'This device is not paired');
        r.devices.touch(device.id);
        who = { kind: 'device', deviceId: device.id, name: device.name };
      }
    }
    // 6. A POST must come from this very page.
    if (route.method === 'POST') {
      const o = req.headers.origin;
      if (o === undefined || !safeEqual(o, r.url))
        throw new HttpError(403, 'bad-origin', 'Origin not allowed');
    }
    return who;
  }

  return {
    token,
    cookieName,
    devOrigin,
    classify,

    // route: { method, pathname, isStatic }. Returns { kind: 'laptop' } or { kind: 'device', deviceId, name }
    // (deviceId is null for static files and the pairing claim). Throws HttpError.
    check(req, route) {
      return classify(req) === 'laptop' ? checkLaptop(req, route) : checkRemote(req, route);
    },

    // GET /?t=<token>: swap the token for the cookie and drop it from the URL. Laptop host only.
    exchange(req, res, supplied) {
      if (classify(req) !== 'laptop') throw new HttpError(403, 'bad-host', 'Host not allowed');
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
