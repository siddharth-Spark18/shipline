// Phone access API: GET/POST /api/remote, /api/remote/pair, /api/remote/claim, /api/remote/devices/:id/revoke.
// Node 20+, no dependencies.
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE } from './auth.mjs';
import { HttpError, sendJson } from './http.mjs';
import { log } from './log.mjs';

export function routes(app) {
  const remote = () => app.remote;

  const view = async (who) => {
    const r = remote();
    const status = await r.status();
    return {
      enabled: status.enabled,
      url: status.url,
      httpsPort: status.httpsPort,
      tailscale: status.tailscale,
      devices: r.devices.list().map((d) => ({ ...d, current: !!who && who.deviceId === d.id })),
      pairing: { cancelled: r.devices.cancelled() },
    };
  };

  return [
    { method: 'GET', path: '/api/remote', handler: ({ who }) => view(who) },

    {
      method: 'POST',
      path: '/api/remote',
      handler: async ({ res, body, who }) => {
        if (!body || typeof body.enabled !== 'boolean')
          throw new HttpError(400, 'bad-request', 'enabled must be true or false');
        const r = remote();
        if (body.enabled) {
          const status = await r.start();
          if (!status.enabled)
            throw new HttpError(409, 'remote-unavailable', status.tailscale.message, {
              state: status.tailscale.state,
            });
          return view(who);
        }
        if (!r.enabled) return view(who);
        // Answer first: when a phone turns phone access off, its own response goes through the mapping.
        const payload = { ...(await view(who)), enabled: false, url: null, httpsPort: null };
        res.once('finish', () => {
          app.hub.closeWhere((c) => c.deviceId !== undefined, 'remote-off');
          r.stop().catch((e) => log('remote-error', { message: e && e.message }));
        });
        return sendJson(res, 200, payload);
      },
    },

    {
      method: 'POST',
      path: '/api/remote/pair',
      handler: () => {
        const r = remote();
        if (!r.enabled) throw new HttpError(409, 'remote-not-on', 'Turn on phone access first');
        const { code, shortCode, expiresAt } = r.devices.createCode();
        return { url: `${r.url}/pair?c=${code}`, shortCode, expiresAt };
      },
    },

    {
      method: 'POST',
      path: '/api/remote/claim',
      handler: ({ res, body, who }) => {
        if (who.kind !== 'device')
          throw new HttpError(403, 'remote-only', 'Pair from the phone, not from this computer');
        const devices = remote().devices;
        const name = body && body.name;
        // Either the QR link's code or the short code a person typed.
        const result =
          body && typeof body.shortCode === 'string'
            ? devices.claimShort(body.shortCode, name)
            : devices.claim(body && body.code, name);
        if (result.error === 'pairing-cancelled')
          throw new HttpError(
            409,
            'pairing-cancelled',
            'Pairing was cancelled after too many wrong codes. Make a new one on the computer.',
          );
        if (result.error)
          throw new HttpError(
            400,
            result.error,
            result.error === 'bad-name'
              ? 'Name the device with 1 to 40 characters'
              : 'Wrong or expired code. Check it, or make a new one on the computer.',
          );
        log('remote-pair', { device: result.device.id, name: result.device.name });
        return sendJson(
          res,
          200,
          { id: result.device.id, name: result.device.name },
          {
            'Set-Cookie': `${DEVICE_COOKIE}=${result.cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}`,
          },
        );
      },
    },

    {
      method: 'POST',
      path: '/api/remote/devices/:id/revoke',
      handler: ({ params }) => {
        const r = remote();
        if (!r.devices.revoke(params.id)) throw new HttpError(404, 'not-found', 'No such device');
        app.hub.closeWhere((c) => c.deviceId === params.id, 'revoked');
        log('remote-revoke', { device: params.id });
        return { ok: true };
      },
    },
  ];
}
