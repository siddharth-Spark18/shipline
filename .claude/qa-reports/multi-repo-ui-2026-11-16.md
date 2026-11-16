# QA report: multi-repo UI (feat/multi-repo-ui, uncommitted), 2026-11-16

Mode: flag-only, nothing fixed. Isolated SHIPLINE_HOME in a temp dir, temp repos (A, A-wt worktree, B, C, D, E, F, U uninstalled), fake claude (SHIPLINE_CLAUDE_BIN) for chats. All servers I started were stopped.

## Summary
- Frontend: 3 (all low)
- Backend: 2 (both low)
- Needs investigation: 0
- Fixed: n/a (flag-only)
- No high or medium bugs found. Flows 1-7 behave as the plan describes.

## Frontend bugs
1. Wasted per-repo requests on non-ok repos produce console errors (low).
   Repro: open `#/r/<id>/chat` for a missing repo (410) or a repo-newer / pre-1.0 repo (409).
   Expected: the card renders without calling data routes. Actual: `GET /api/repos/<id>/tasks` fires and 410/409 appears as a console error ("Failed to load resource"). Cosmetic, UI renders correctly.
2. Malformed repo hash redirects to the wrong repo (low).
   Repro: with last-used repo = X, set `location.hash = '#/r/<validIdY>'` or `'#/r/<validIdY>/nope'`.
   Expected: land on Y (id is valid). Actual: redirected to `#/r/<X>/chat`. (`#/r/`, `#/r//chat`, `#/all/x` also go to the last repo, which is fine.)
3. "You're set up" screen after wizard Install has no project switcher or sidebar (low).
   Repro: `ui` in an uninstalled folder with a server running, "Set up here", Next through all steps, Install. The done card shows only the Commit/claude/Try-it steps. The switcher present on the earlier wizard steps is gone. Only "Open Shipline" leaves; a reload goes to the normal repo view. Install itself works.

## Backend bugs
1. `ui --dir /nonexistent` with NO server running starts a server on that path (low, CLI).
   Repro: `shipline ui --no-open --dir /nonexistent` (no server.json). It logs `start ... dir:/nonexistent` and keeps running. With a server running the same command correctly says "/nonexistent is not a directory." Exit 1-ish path vs hang is inconsistent. I could not tell if the cold-start behaviour predates this change (the old code has no "not a directory" check either), so treat as inconsistency.
2. `POST /api/handoff` with a relative `dir` resolves it against the server's cwd (very low).
   `{"dir":"w/A"}` returns 400 bad-dir "<server cwd>/w/A is not a directory". The CLI always sends an absolute path so it is unreachable from the CLI; only a hardening nit.

## Verified OK (no bug)
- Flow 1: handoff from B, A's worktree and the uninstalled folder all print a URL and exit 0 with one server only. server.json mode 0600; removed on SIGTERM and on SIGINT (with two running fake chats: both chats and their claude processes were stopped). Stale server.json (dead pid) starts a new server; live pid with wrong key starts a new server. projects.json: ids, `group` shared by A and A-wt, API groupName "A" for both. Seeding from projects/*/repo.json works; a corrupt projects.json gets a .bak and is rebuilt on the next registration. uninstall unregisters.
- Flow 2: switcher grouping (A group with A-wt below it), state labels, waiting badges (button shows waiting in other repos, `#/all` shows total), `#/r/<id>/chat|chats|setup`, `#/all` with all four sections (Needs you listed both permission prompts, Chats, Unfinished tasks with stage dots, Repo health), old `#chat/#setup/#chats` redirect, unknown id and stale localStorage id go to `#/all`, back/forward, rapid hash switching, reload. Mobile 390px: no horizontal overflow, switcher header and tab bar OK.
- Flow 3: renamed folder shows missing (410 repo-missing) with Remove (card and switcher); newer repo shows 409 repo-newer with the restart message; pre-1.0 409 repo-too-old; a loaded repo whose folder is renamed turns missing on next probe. DELETE works on loaded, unloaded and install contexts, repeat gives 404 unknown-repo, UI goes to `#/all` after removing the viewed repo. DELETE during a running chat gives 409 chat-running (API and UI toast); confirm dialog present.
- Flow 4: `--port` on handoff prints "already running on port X; stop it to change the port." and still hands off; version mismatch message "Shipline UI 1.9.0 is already running; stop it to use 2.0.0." OK. `--port abc` exits 2.
- Flow 5: `upgrade --all --dry-run` lists per-repo previews, "skipped (folder not found)" and failed (pre-1.0) in the summary, exit 1; `upgrade --all --dir x` / `--dir=x` exit 2 with a usage message; a real `--all --yes` upgraded an older-version repo while a fake chat was running in it (not blocked; same as `upgrade` today).
- Flow 6: wizard works in the server; after Install the repo is state ok with the same id (0ef6d1b72a7d).
- Flow 7: ping/handoff: no key or wrong key 403 bad-key, non-loopback Host 403 bad-host, bad body 400. `/api/projects`, `/api/overview`, `/api/repos/*`, DELETE, `/api/events` without cookie 401 no-session; DELETE without an Origin header 403 bad-origin; foreign Host 403. Bad repo id gives 404 unknown-repo. One-time login token cannot be reused (403).

## Notes
- `--remote` is not isolated by SHIPLINE_HOME: Tailscale is installed on this machine, so the handoff `--remote` really ran `tailscale serve` (443 -> test server) and printed a real Phone access URL. I turned it off via `POST /api/remote {enabled:false}`; `tailscale serve status` then showed "No serve config". The success message and URL looked right. Remote-failure messaging was therefore not exercised.
- Relay timeout from the UI side: the permission card shows a "Denied in 4:48" countdown; I did not wait it out (not confirmed that it denies at zero).
- A process `shipline ui` (pid 13951, cwd .../pocs/brown-bg-tracker) started at 12:21 is not mine; left untouched.
- Scratch artefacts (temp repos, SHIPLINE_HOME) are under the session scratchpad: /private/tmp/claude-502/-Users-siddharth-Projects-shipline/5d1dfe30-8070-4ad6-ad38-2ce5e5fc655c/scratchpad/w
