# Review: shipline-ui-phone-access.md

## 1. Verdict

Ready after must-fixes (3 must-fix items).

## 2. Paraphrase

**What the plan proposes.** `shipline ui --remote`, or a "Phone access" switch in the UI, runs `tailscale serve` so the existing Shipline UI can be reached from the developer's phone at a `https://<machine>.<tailnet>.ts.net` address. This is repo mode only. The phone gets the full UI. It is paired once by scanning a QR code. The QR carries a single-use code that lasts 5 minutes. The phone names itself and receives a long-lived `shipline_device` cookie. Paired devices are stored globally, as hashes, in `$SHIPLINE_HOME/devices.json`, and last until revoked. Every remote request must come in on the registered ts.net host. It must carry the Tailscale login header for the same user as the laptop. It also needs a valid device cookie, except for static files and the claim route. `/api/relay` stays laptop-only. Device POSTs are written to `ui.log`. The change adds five API routes, three new backend modules, and a Phone access panel plus pairing screens in the UI.

**How the existing system works, according to the plan.** The server listens on 127.0.0.1. It accepts only the `127.0.0.1:<port>` Host. A per-run token in `/?t=` is swapped for a `shipline_ui_<port>` cookie. POSTs need a matching Origin. `auth.check` and `createAuth(port)` hold those checks. `server.mjs` currently does the Host check itself. The SSE hub (`sse.mjs`) keeps one untagged stream per tab, with a 15 s heartbeat. It re-sends state when a client connects. The UI is a React app with a Setup page. Unknown paths fall back to `index.html`. Pending approvals wait until someone answers them.

## 3. Must-fix

1. **Token exchange runs before the Host check (Behavior / `server.mjs` row).**
   - In the current code, `GET /?t=` calls `auth.exchange` before `auth.check`, and `exchange` has no Host check of its own. The plan moves the Host check into `auth.check` but doesn't say where the exchange goes.
   - If the builder moves the Host check and leaves the exchange where it is, the exchange is reachable on any Host, including the ts.net host. That weakens the loopback-only guarantee.
   - Fix: say that the exchange must only run on the laptop Host, and that on a remote Host `/?t=` is refused or ignored. Add a test for it.

2. **How the phone learns that it was revoked or switched off is undefined (`events.ts` row).**
   - `EventSource` exposes no HTTP status. When the server ends the stream, the browser quietly reconnects. The reconnect gets a 401 and `es.onerror` fires. The client cannot tell that apart from a dropped network. The plan says "show `not-paired` when the stream is closed by the server", but a plain close gives no way to detect that.
   - The builder has to invent the signal. Options are a final SSE event such as `event: revoked` or `remote-off` before `res.end()`, or a `GET /api/remote` probe on every error.
   - Fix: pick one. The simplest is to send a named final event before closing, have `events.ts` handle it by showing `not-paired`, and have the heartbeat check send the same event.

3. **Remote host is not wired into `auth` (`auth.mjs` / `remote.mjs` rows).**
   - `createAuth(port)` is called right after `listen`. The registered ts.net host and HTTPS port exist only after `remote.start()`, and they change when the switch is toggled at runtime.
   - The plan doesn't say how `auth.check` gets the remote on/off state, host and port, or the laptop login name. It doesn't say how `sse.mjs` gets the device verifier for the heartbeat. It doesn't say who does the "remote on?" check or when it runs.
   - Fix: state the mechanism, for example `auth.setRemote({ enabled, host, httpsPort, loginName })` and `devices.verify` passed into `createHub`. State that `app.remote` is the single source of truth for the on/off state.

## 4. Optional (non-blocking)

- **Spoofable headers on a loopback hop.**
  - `tailscale serve` forwards from 127.0.0.1, so any local process can send a forged Host and `Tailscale-User-Login`. The device cookie still stands in the way, so the exposure is small.
  - Say in the Security notes that the identity header is defense in depth, not the primary check.
- **Claim route on the laptop path.** The table says "remote, no cookie", but it doesn't say what a laptop-host call to `/api/remote/claim` does. Suggest a 403.
- **Turning remote on from a device.** `POST /api/remote {enabled:true}` from a device is impossible when remote is off, because `remote-off` fires first. The behavior is correct, but add a line saying so.
- **Pairing codes are in memory only.** With two `shipline ui` processes, a QR made by one is valid only on that process's port. The plan implies this by saying "each QR link carries its port". State it explicitly.
- **Cookie and port.** The `shipline_device` cookie is shared across HTTPS ports on the same hostname. Confirm that is the intent, since it matches the "global devices" decision.
- **`tailscale status --json` fields.** The plan names `Self.UserID` and `User[id].LoginName`. It names no field for HTTPS-certificate availability. Name the check the builder should use (`CertDomains`, or `tailscale cert` failing).
- **Ports.** The open question about ports 443, 8443 and 10000 is already flagged. Make it a builder task item. The manual phone-test question is also still open and needs a yes/no before 1.2.0.
- **`SHIPLINE_UI_DEV_ORIGIN`.** The dev origin applies to the laptop path only. Say so.

## 5. Files-to-touch check

- Every "modify" path exists: `auth.mjs`, `server.mjs`, `sse.mjs`, `bin/shipline.mjs`, `ui/package.json`, `setup-page.tsx`, `app.tsx`, `lib/api.ts`, and `lib/events.ts`. I confirmed these with Glob. I did not check the README, CHANGELOG, `cli/package.json` or `ui-dist` paths.
- The "create" paths don't clash with existing files. No `remote*.mjs`, `devices.mjs`, `pair/` or `phone-access.tsx` exists yet.
- Possible omissions:
  - `packages/ui/src/lib/types.ts`, since `api.ts` gets new types.
  - `packages/ui/src/lib/queries.ts`, if the remote data uses React Query.
  - The pnpm lockfile, for `qrcode-generator`.
  - A `packages/cli/bin/shipline.mjs` change is listed, but `UI_USAGE` in `server.mjs` also needs `--remote`. That is covered in the server row.
