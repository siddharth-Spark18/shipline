# Review: shipline-multi-repo-ui.md

## 1. Verdict

Ready after must-fixes (3 must-fix items, all small and answerable in a few lines each).

## 2. Paraphrase

**What the plan proposes.** Replace the one-server-per-repo model of `shipline ui` with one server per machine. A machine-wide registry (`projects.json`) lists every repo, and a `server.json` file lets a second `shipline ui` run find the live server and hand its folder over, then exit. The server holds a lazily created context per repo and exposes per-repo routes under `/api/repos/:repoId/...`. The UI gains a project switcher with worktrees grouped, a "waiting for you" badge, a combined `#/all` view, and hash routes that carry the repo id. Phone access becomes one Tailscale mapping for all repos. `shipline upgrade --all` upgrades every registered repo. This ships as 2.0.0, with no new tests, and existing tests only get route and version updates.

**How the system works today, according to the plan.** One server process serves one repo, built by `startRepoMode` (repo, log, prompts, chats, watch, route table). There is a `switchToRepo` for the install wizard. Routes are flat under `/api/<x>`. Logging goes through one module-level file in `log.mjs`. Each repo has its own store under `~/.shipline/projects/<encoded>/` containing `repo.json`, tasks, `ui/` sessions, a lock and `ui.log`. Phone access uses up to three Tailscale HTTPS ports (443, 8443, 10000), one per repo, recorded in `remote-serve.json`. Paired devices live in `devices.json`.

## 3. Must-fix

1. **Unregister (`DELETE /api/projects/:repoId`) on a repo whose context is already loaded is undefined.** Plan section: API and "Per-repo contexts". Contexts are "never unloaded before shutdown", but Remove unregisters a repo. It does not say what happens to the loaded context's watch, lock, and routes. Do `/api/repos/<id>/...` calls now return 404 `unknown-repo` or still work? Does the lock stay held until shutdown? A builder would have to guess, and a wrong guess leaves a ghost context or a stuck lock. Fix: state that Remove (when no chat runs) also disposes that context (stop watch, release lock, drop from the map). Alternatively, state that the context stays and routes keep working until shutdown. Pick one, and note that this is the one exception to "never unloaded".

2. **"Error not seen since (cleared when that chat is opened)" has no defined mechanism.** Plan section: Badge. "Opened" happens in the browser, but `waiting` is computed on the server and also drives the `projects` SSE event. With several browser tabs and a phone, where is the "seen" flag kept (per chat in server memory, or per browser)? Which request clears it? Fix: say it is a per-chat server-side flag, cleared by an existing or new named route (for example the first GET of that chat), and that clearing emits a `projects` event.

3. **Install-context lifecycle on a registry-less or conflicting id is underspecified.** Plan section: Install contexts. The id is "hashed from the install root", and registration uses the same hash of the real root. After Install, the context is "registered and switched to repo mode" and keeps the same id, which works only if the install-context hash is exactly the registry id. Say so explicitly, and say what happens if the same folder is handed off twice (reuse the existing context or create another one). Also say what a dismissed context returns on later requests (404 `unknown-repo`). Fix: add one line, "install-context id equals the registry id for that real root; handoff for an existing install context reuses it".

## 4. Optional (non-blocking)

- A lazily created context can fail on creation because a 1.x server or another process holds the per-checkout lock. The plan only lists a wording change in `sessions.mjs`. Naming the HTTP status and error code for that case (for example 409 `repo-locked`) would help the frontend.
- "`--remote` on a handoff turns on phone access" is not explained. A short pointer to what `--remote` does today (Tailscale serve plus pairing link) would help a zero-context builder.
- The Files list says `README.md` without saying which one. Both the repo root `README.md` and `packages/cli/README.md` exist, and it sits under the CLI heading. `CHANGELOG.md` correctly lives at `packages/cli/CHANGELOG.md` only.
- The test update list says "the files that call `/api/...`". `packages/cli/test/ui/helpers.mjs`, `auth.test.mjs`, `relay.test.mjs` and `shutdown.test.mjs` may be affected. A grep during the build will settle it, so no action is needed.
- `realRoot`, `storeDir` and `shiplineHome` live in the vendored `packages/cli/templates/shipline/bin/lib.mjs`. The plan could name that path, since `registry.mjs` will import from it while the templates stay untouched.
- The upgrade, install and unregister ordering is fine. The "no new tests" decision is the user's call, but a registry merge and a handoff race are exactly the kind of logic that is hard to verify by hand.

## 5. Files-to-touch check

- All "modify" paths checked exist: `packages/cli/src/ui/{server,repo,chat,chat-routes,prompts,setup,tasks,watch,diagnostics,commands,shell,install-routes,sessions,remote,remote-routes,auth,log,sse}.mjs`, `src/{init,upgrade,uninstall}.mjs`, `bin/shipline.mjs`, `packages/cli/CHANGELOG.md`, the UI files (`app.tsx`, `lib/{api,queries,events,types}`, `app-sidebar`, `mobile-chat-list`, `mobile-tab-bar`, `banners`, `install-wizard`, `chat-store`, `setup-page`), and the docs (`usage`, `phone-access`, `install`, `troubleshooting`). Test files named in the plan exist.
- New files (`registry.mjs`, `server-record.mjs`, `projects.mjs`, `project-switcher.tsx`, `overview-page.tsx`) do not exist yet, as expected. I did not verify that `lib/types.ts` exists (the glob output was truncated).
- Nothing described is missing from the list, apart from the README ambiguity noted above. `packages/cli/src/ui/devices.mjs` is not listed. That is probably fine as the plan says `devices.json` is unchanged, but the phone audit path and "paired device reaches all repos" may touch the auth path in `auth.mjs`, which is listed.
