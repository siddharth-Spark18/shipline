# Shipline UI on your phone (Tailscale)

**Status:** Approved
**Starts from:** `main` @ e36e6f3 (1.1.0, published). **Ships as:** 1.2.0, INTERFACE stays 1 (the hook contract doesn't change).
**Research:** `.claude/research/remote-monitoring-native-claude.md`, `-landscape.md`, `-architecture.md` (threat model).

## Problem & Goal

A developer starts work in `shipline ui` on their laptop and walks away. The chat then stops at a gate ("Advance?") or a
tool-permission prompt and waits, and nothing can move it on until they're back at the laptop. Claude Code's own Remote
Control doesn't help: `shipline ui` chats are headless `claude` processes started by the UI server, so they never show up
in the Claude mobile app.

**Goal:** while the laptop is on, the developer opens the same Shipline UI on their own phone, over their own Tailscale
network, and can do everything there that they can do on the laptop.

**Success:** with a chat waiting at a gate on the laptop, the developer, away from the desk, opens the paired phone and
answers the gate. The chat continues on the laptop.

## Scope

### In

1. **Remote mode over Tailscale.** `shipline ui --remote`, plus a "Phone access" on/off switch in the UI, makes the running
   UI reachable at `https://<machine>.<tailnet>.ts.net[:port]/` through `tailscale serve`, which Shipline runs and removes.
   Only for installed repos (repo mode), never in the install wizard.
2. **Full parity on the phone.** A paired device can use every page and action the laptop can: chat, send messages,
   approve/deny tool permissions, answer gate questions, stop/start chats, diffs and files, Setup, and the Phone access
   panel itself (turn remote off, pair another device, revoke devices).
3. **Pairing by QR code** shown in the Phone access panel. The link is single use and expires after 5 minutes. On the
   phone, scanning opens a "Name this device" screen; submitting it pairs the device.
4. **Paired devices are global and persistent.** One device list in `$SHIPLINE_HOME` covers every repo. Pairings survive
   UI restarts and never expire; they end only when revoked.
5. **Devices list** in the Phone access panel: name, paired at, last seen, Revoke. Revoking cuts the device off
   immediately.
6. **Same-Tailscale-user check.** Remote requests must carry Tailscale's identity header for the same Tailscale user who
   is logged in on the laptop.
7. **Audit log.** Device actions go to the repo's existing `ui.log`.
8. **Docs:** README section, CLI help, CHANGELOG.

### Out (not in v1)

- Notifications of any kind (web push, ntfy). The developer opens the page to check.
- Same-Wi-Fi (LAN) mode, public tunnels (Cloudflare/ngrok), any hosted relay.
- Teammates or other Tailscale users viewing someone's session.
- Pairing expiry or rotation, renaming devices after pairing.
- Timeouts on pending approvals: questions keep waiting on every device until answered, as today.
- Keeping the laptop awake. If the laptop sleeps, the phone can't reach it; the panel says so.
- Remote access in install-wizard mode.
- An activity view in the UI for the audit log.

## Surface Area

- **Backend (`packages/cli/src/ui`):** request auth gains a second, remote path next to the laptop path; new modules for
  Tailscale control and the device store; new API routes; SSE connections become tagged by device so they can be cut off.
- **Frontend (`packages/ui`):** a Phone access section on the Setup page, a pairing screen and a "not paired" screen for
  the phone. New dependency: `qrcode-generator` (zero dependencies) in the UI package only.
- **Data:** new global file `$SHIPLINE_HOME/devices.json`, and `$SHIPLINE_HOME/remote-serve.json` (which Tailscale HTTPS
  ports this Shipline registered, for clean-up). Nothing in the repo or the per-repo store changes shape.
- **API:** new routes only (below). Existing routes and responses don't change.
- **CLI:** new `--remote` flag on `ui`.

### How a request is classified

| Host header | Path taken |
|---|---|
| `127.0.0.1:<port>` | **Laptop**, exactly as today: per-run token → `shipline_ui_<port>` cookie, Origin check on POST. |
| `<machine>.<tailnet>.ts.net` or `…ts.net:<httpsPort>` (the one name/port this server registered) | **Remote**: allowed only while remote is on. See below. |
| anything else | 403 `bad-host`, as today. |

**Order in the request handler:** the Host classification always runs first. The laptop token exchange (`GET /?t=<token>`)
is handled only after a request is classified **laptop**; on a remote host it is refused with 403 `bad-host`.

**Runtime remote state (`app.remote`):** one object created in `startServer` before `createAuth`, holding
`{ enabled, host, httpsPort, loginName, tailscale, devices }` (`devices` = the `devices.mjs` store). `remote.start()` and
`remote.stop()` update it in place; `createAuth(port, app)` keeps a reference, and `auth.check` and the SSE heartbeat read
it on every call, so nothing caches stale values. While remote is off, `host` is null and every non-laptop Host is
`bad-host`.

Remote path checks, in order (each failure is a 401/403 with a code, no detail beyond it):
1. Remote is on, else 403 `remote-off`.
2. `Tailscale-User-Login` header equals the laptop's Tailscale login name (from `tailscale status --json`: `Self.UserID`
   → `User[id].LoginName`), else 403 `wrong-tailscale-user`.
3. `/api/relay` is refused (403 `bad-host`): the permission relay is laptop-only.
4. Static files (the app) need nothing more. The pairing claim route needs only a valid pairing code.
5. Every other API route needs a valid `shipline_device` cookie for a device that isn't revoked, else 401 `not-paired`.
6. POST needs `Origin: https://<registered host>` exactly, else 403 `bad-origin`.

`shipline_device` cookie: value `<deviceId>.<secret>` (secret 32 random bytes, hex), `HttpOnly; Secure; SameSite=Strict;
Path=/; Max-Age=34560000` (400 days, the browser maximum; a pairing itself never expires, re-scanning restores the cookie).
Only `sha256(secret)` is stored.

### New API routes (repo mode only)

| Route | Who | Does |
|---|---|---|
| `GET /api/remote` | laptop or device | `{ enabled, url, httpsPort, tailscale: { state: 'ok' \| 'missing' \| 'logged-out' \| 'no-https' \| 'no-free-port', message }, devices: [{ id, name, pairedAt, lastSeenAt, current }] }` |
| `POST /api/remote` `{ enabled: boolean }` | laptop or device | Turns remote on/off (runs/removes `tailscale serve`). Turning it off from the phone disconnects that phone too. |
| `POST /api/remote/pair` | laptop or device | Creates a pairing code: `{ url: "https://…/pair?c=<code>", expiresAt }`. Code: 32 random bytes, hex, in memory only, 5 min, single use. A new code doesn't cancel older unexpired ones. |
| `POST /api/remote/claim` `{ code, name }` | remote, no cookie | Validates and consumes the code, stores the device, sets the cookie. `name` 1–40 chars after trim. Errors: `bad-code` (unknown, used or expired), `bad-name`. |
| `POST /api/remote/devices/:id/revoke` | laptop or device | Removes the device and closes its SSE connections in this process. A device may revoke itself. |

## Files to Touch

| Path | Action | Change |
|---|---|---|
| `packages/cli/src/ui/remote.mjs` | create | Tailscale control: find the `tailscale` CLI on PATH; read `tailscale status --json` (logged in?, `Self.DNSName`, login name, HTTPS/cert availability); pick the first free HTTPS port of 443, 8443, 10000 from `tailscale serve status --json`; run `tailscale serve --bg --https=<p> http://127.0.0.1:<uiPort>` and `tailscale serve --https=<p> off`. Records registered ports in `$SHIPLINE_HOME/remote-serve.json` and, at start, removes a recorded mapping whose target port no longer answers (stale from a crash). Exposes `{ start(), stop(), status(), host, loginName }`. Reports the `tailscale.state` values above instead of throwing. |
| `packages/cli/src/ui/devices.mjs` | create | Device store at `$SHIPLINE_HOME/devices.json` (`{ version: 1, devices: [{ id, name, tokenHash, pairedAt, lastSeenAt }] }`), written atomically (tmp + rename), re-read when its mtime changes so several `shipline ui` processes agree. Pairing codes (in memory). `verify(cookie)` with `safeEqual` on hashes, `touch(id)` (lastSeenAt, written at most once a minute), `revoke(id)`. |
| `packages/cli/src/ui/remote-routes.mjs` | create | The five routes above. |
| `packages/cli/src/ui/auth.mjs` | modify | `createAuth(port, app)` reads `app.remote` on every call. Takes over the Host check from `server.mjs`; `exchange` is allowed only for the laptop host. `check(req, route)` returns `{ kind: 'laptop' }` or `{ kind: 'device', deviceId }` and applies the remote rules above. Cookie parsing shared by both cookies. |
| `packages/cli/src/ui/server.mjs` | modify | `--remote` in `parseUiArgs` and `UI_USAGE`. Creates `app.remote` before `createAuth(app.port, app)`. Host classification runs first, then the (laptop-only) token exchange, then the rest of `auth.check`. Passes the auth result to handlers (`{ ..., who }`). After `startRepoMode`, starts remote if `--remote`; adds a closer that removes the serve mapping on shutdown. Adds remote routes to the repo-mode table. Audit log: after every non-GET API request from a device, `log('remote', { device, name, method, path, status })` (no bodies). |
| `packages/cli/src/ui/sse.mjs` | modify | `connect(req, res, { deviceId })` tags the client; `closeWhere(fn, reason)` sends a final `event: access-ended` with `{ reason: 'revoked' \| 'remote-off' }` to each matching client, then ends it; on each heartbeat, a device client is re-verified and closed if revoked (so a revoke in another `shipline ui` process cuts it off within 15 s). |
| `packages/cli/bin/shipline.mjs` | modify | `ui` help text gains `--remote`. |
| `packages/ui/package.json` | modify | Add `qrcode-generator`, pinned to an exact version. |
| `packages/ui/src/pages/setup/phone-access.tsx` | create | "Phone access" section: on/off switch, Tailscale status with a fix message for each failure state, URL, "Pair a phone" button → QR + link + 5-minute countdown, devices list with Revoke (with "this device" marked), note that the laptop must stay awake. |
| `packages/ui/src/pages/setup/setup-page.tsx` | modify | Renders the Phone access section (repo mode only). |
| `packages/ui/src/pages/pair/pair-page.tsx` | create | Phone screen at `/pair?c=…`: "Name this device" field + Pair button → `POST /api/remote/claim` → load `/`. Shows the `bad-code` / `bad-name` errors. |
| `packages/ui/src/pages/pair/not-paired.tsx` | create | Shown when an API call returns `not-paired`, `remote-off` or `wrong-tailscale-user`: one line per case on how to fix it. |
| `packages/ui/src/app.tsx` | modify | Renders the pair page when the path is `/pair`; renders `not-paired` on those error codes. |
| `packages/ui/src/lib/api.ts` | modify | Remote API calls and types; surfaces the three error codes to `app.tsx`. |
| `packages/ui/src/lib/events.ts` | modify | On an `access-ended` event: stop reconnecting and show the `not-paired` screen with its reason. A close without that event (network drop, laptop asleep) keeps today's reconnect behaviour. |
| `packages/ui/src/lib/types.ts` | modify | Types for `GET /api/remote`, devices, the pairing response and the `access-ended` event. |
| `packages/ui/src/lib/queries.ts` | modify | React Query hook(s) for `/api/remote` and its mutations (switch, pair, claim, revoke). |
| `pnpm-lock.yaml` | modify | Lockfile update from adding `qrcode-generator`. |
| `packages/cli/ui-dist/**` | modify | Rebuilt bundle (generated). |
| `README.md` | modify | §5 The browser UI: "Use it from your phone" (Tailscale install, HTTPS certificates on, `--remote` or the switch, pairing, revoking, security notes). |
| `packages/cli/CHANGELOG.md` | modify | 1.2.0 entry. |
| `packages/cli/package.json` | modify | Version 1.2.0. |
| `packages/cli/test/**` | create / modify | Tests (test agent), with a stub `tailscale` on PATH. |

## Behavior & Edge Cases

- **Tailscale missing, logged out, or HTTPS certificates not enabled** (`tailscale.state` ≠ `ok`): the UI starts
  laptop-only. The terminal prints one line with the reason and the fix; the Phone access section shows the same, and the
  switch stays off.
- **All of 443, 8443, 10000 already served** by something else: `no-free-port`, laptop-only, the message names what is
  using them. Shipline never changes a mapping it didn't create.
- **Two `shipline ui` with remote on** (two repos): each takes its own HTTPS port; each QR link carries its port. A paired
  phone works on both (one device list, cookie scoped to the hostname).
- **Shutdown** (Ctrl+C, normal exit): the mapping is removed. **Crash:** the stale mapping is cleaned at the next start
  (above); until then Tailscale returns a proxy error page.
- **Turning remote off** (switch or exit): mapping removed, all device SSE connections closed. Paired devices stay paired.
- **Revoke:** device removed from `devices.json`; its connections in this process close at once, in other processes
  within one heartbeat (15 s); its next request gets `not-paired`.
- **Pending approvals / gates:** unchanged. They wait until answered from any device. A phone that drops and reconnects
  gets the pending prompts again (the hub already re-sends state on connect).
- **Both laptop and phone answer the same prompt:** first answer wins, as with two laptop tabs today.
- **Laptop sleeps / network drops:** the phone shows the existing "connection lost" state; nothing is queued.
- **Pairing link reused or older than 5 min:** `bad-code`; the phone asks for a new QR.
- **Phone without the cookie** (cleared, other browser): `not-paired` screen, "scan a new QR from Phone access".
- **Request from a different Tailscale user** (shared node or tailnet): `wrong-tailscale-user`, even with a valid cookie.
- **`--remote` in a folder without Shipline:** the install wizard starts laptop-only and the terminal says remote needs an
  installed repo.
- **Node:** `shipline ui` already needs Node 20+; nothing new.

## Constraints

- **Security:** this is remote control of the developer's machine. Fail closed on every check; secrets stored only as
  hashes; pairing codes never logged; the audit log has device id/name, method, path and status, never request bodies or
  chat text. `/api/relay` stays laptop-only.
- **No new CLI runtime dependencies.** `tailscale` is called as an external program. The QR library goes into the UI bundle
  only, pinned exactly.
- **Platforms:** macOS, Linux and Windows (the `tailscale` CLI exists on all three; Windows CI runs the tests).
- **Laptop path unchanged:** plain `shipline ui` behaves exactly as in 1.1.0.

## Verification

Automated (test agent), Node tests with a stub `tailscale` script on PATH:
1. Host classification: laptop host, registered ts.net host/port, unknown host → `bad-host`.
2. Remote off → `remote-off`; wrong or missing `Tailscale-User-Login` → `wrong-tailscale-user`.
3. Pairing: code works once, `bad-code` on reuse and after 5 min (fake clock), `bad-name` on empty/41-char names; claim sets
   a `Secure; HttpOnly; SameSite=Strict` cookie; only the hash is in `devices.json`.
4. Device cookie: valid → API works; tampered/unknown/revoked → `not-paired`; POST with wrong Origin → `bad-origin`.
5. `/api/relay` via the ts.net host → refused. `GET /?t=<valid token>` via the ts.net host → 403 `bad-host`.
6. Revoke closes that device's SSE stream in-process, preceded by an `access-ended` event with `reason: 'revoked'`;
   turning remote off does the same with `reason: 'remote-off'`; a revoke written by another process closes it at the
   next heartbeat.
7. Tailscale states: missing CLI, logged out, no HTTPS, all ports taken → laptop-only with the right `tailscale.state`.
8. Port choice skips mappings Shipline didn't make; shutdown removes its mapping; a stale recorded mapping is removed at
   start.
9. Audit lines are written for device POSTs and contain no body.
10. `shipline ui` without `--remote` passes the existing UI test suite unchanged.

## Open Questions

- **Manual test on a real phone is not planned** (Tailscale isn't installed on the dev Mac). The automated tests cover the
  server; nothing confirms the pairing screen, QR scanning or the gate flow on an actual iPhone/Android browser before
  release. Accept, or add a manual check before tagging 1.2.0?
- *(Resolved at approval)* The API route names and response shapes, the `devices.json` / `remote-serve.json` formats,
  the 400-day cookie Max-Age, the 15-second cross-process revoke delay and the stale-mapping clean-up rule were filled in
  while drafting and accepted as written.
- **Port list 443 / 8443 / 10000:** these are the HTTPS ports Tailscale serve accepts as far as I know; the builder must
  confirm against `tailscale serve --help` and adjust if Tailscale allows others.
- **Node minimum** (separate thread): if the Node/security change raises `engines` to `>=22`, its README/CHANGELOG edits
  will touch the same files; sequence the two branches.
- **Pairing gained a short code** (see `docs/plans/shipline-ui-mobile-layout.md`): `POST /api/remote/pair` now also returns
  `shortCode` (`XXXX-XXXX`), `POST /api/remote/claim` accepts `{ shortCode, name }` as well as `{ code, name }`, using either
  consumes both, 5 wrong short codes cancel the open pairings (`pairing-cancelled`, 409), and `GET /api/remote` carries
  `pairing.cancelled`. The rest of this plan is unchanged.
