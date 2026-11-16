# One Shipline UI server for every repo on the machine

**Status:** Approved
**Release:** 2.0.0
**Sources:** `.claude/research/multi-repo-and-custom-workflows-2026-11-16.md` (section 1), planning interview 2026-11-16.

## Problem & Goal

Today `shipline ui` serves exactly one repo per server process. Someone with Shipline in several repos gets one
terminal, one random port and one browser tab per repo. Nothing shows "which repo needs me". Phone access is capped
at three repos (HTTPS ports 443, 8443 and 10000 in `src/ui/remote.mjs`), each with its own URL. Upgrades run repo by
repo with no list of what's installed.

**Goal:** one `shipline ui` server per machine serves every registered repo. One port, one phone URL, a project
switcher, a badge when another repo is waiting for you, and a combined view across repos.

**Success:**
- Running `shipline ui` in a second repo opens that repo in the already-running server instead of starting another
  one.
- Chats can run in two repos at once, and a permission prompt in one shows a badge while you're in the other.
- The phone reaches all repos through one URL.
- `shipline upgrade --all` upgrades every registered repo.

## Scope

**In:**
- A machine-wide project registry: automatic on `init`, `ui` and `upgrade`, removed on `uninstall`, seeded once
  from existing stores.
- Single-server discovery and handoff through `~/.shipline/server.json`. The server lives as long as its terminal.
- Per-repo API routes under `/api/repos/:repoId/...`, and per-repo contexts loaded lazily.
- The setup wizard for an uninstalled folder, served inside the running server.
- Version handling per repo, plus health cards.
- UI: a project switcher (worktrees grouped under their repo), a waiting badge, a combined view (`#/all`) and
  hash routes that carry the repo. The same on the phone layout.
- Phone access: one `tailscale serve` mapping for the whole server. A paired device reaches every registered repo.
- `shipline upgrade --all`.
- Updating existing tests' route paths and version assertions (no new tests).
- Docs and changelog for 2.0.0.

**Out (explicitly):**
- A background service: the server outliving its terminal or starting at login.
- Custom workflows (a separate later plan).
- Hosted relay / phone access without Tailscale (still parked).
- A per-repo "reachable from phone" opt-in.
- An "Add project" button or `shipline add`. Repos join through `init`, `ui`, `upgrade` or seeding.
- Unloading a lazily loaded repo before shutdown.
- New automated tests (verification is manual; see Verification).
- Any change to the vendored repo templates (`packages/cli/templates/**`), so no template-hash bump. Hooks
  don't know about the registry.

## Surface Area

### Data (all under `shiplineHome()`: `$SHIPLINE_HOME` or `~/.shipline`)

**`projects.json` (new): the registry.**

```json
{ "version": 1, "projects": [ { "id": "3f9a0c1b7e22", "root": "/abs/real/path", "group": "/abs/real/path/.git", "addedAt": "2026-11-16T10:00:00.000Z" } ] }
```

- `id`: the first 12 hex characters of sha256 of the repo's real root (`realRoot` from the vendored lib, the same
  as `storeDir`).
- `group`: the realpath of `git rev-parse --git-common-dir`, or `null` outside git. Worktrees share it, which is
  how they're grouped.
- Writes go to a temp file plus a rename. Read-modify-write is safe for concurrent CLI runs: re-read just before
  the write, merge by `id`.
- Missing or unparseable at startup: if it's missing, seed it (below). If it's unparseable, log it, treat it as
  empty and don't overwrite it until the next successful registration (keep a `.bak` of the bad file).

**Seeding (once, only when `projects.json` doesn't exist):**
- Read every `projects/*/repo.json` (it already records `root`).
- Add the entries whose `root` still has `.shipline/config.yml`. Skip the rest without listing them; most are test
  temp folders.

**`server.json` (new): the running server.**

```json
{ "pid": 12345, "port": 51234, "version": "2.0.0", "key": "<32 random bytes, hex>", "startedAt": "..." }
```

- Written with mode 0600 right after `listen` and removed on clean shutdown.
- `key` lets a later CLI run ask the server for a login link. The trust boundary is the user's home folder, the
  same as `devices.json` today.
- On Windows the mode isn't enforced. The docs note that the user profile folder is the boundary.

**Unchanged:** `projects/<encoded>/` stores (tasks, `ui/` sessions, lock and per-repo `ui.log`) and `devices.json`.
`remote-serve.json` keeps its format but holds at most one entry for this server.

### Server lifecycle and handoff (`shipline ui [--dir] [--port] [--no-open] [--remote]`)

1. Resolve the target folder: `--dir`, or the current directory.
2. Read `server.json`. A server is alive when the pid exists **and** `GET http://127.0.0.1:<port>/api/handoff/ping`
   with header `X-Shipline-Key: <key>` returns 200 within 2 s.
3. **Alive:** `POST /api/handoff` with the key and `{ dir, remote: bool }`. The server:
   - registers the repo if the folder is installed, or opens an install context if it isn't;
   - turns on phone access if `remote` is set;
   - returns `{ url }`: a one-time login link (the same token mechanism as today) with hash `#/r/<id>/chat`.
   The CLI prints the URL, opens it unless `--no-open`, and exits 0. With `--port <n>` ≠ the running port, it
   prints "Shipline UI is already running on port X; stop it to change the port." and still hands off. If the
   running server's version differs from the CLI's, it prints "Shipline UI <server v> is already running; stop it
   to use <cli v>." and still hands off.
4. **Not alive** (missing file, dead pid, no answer, wrong key): start a new server as today. It overwrites
   `server.json` and serves the target folder first.
5. **Shutdown (Ctrl+C or SIGTERM):** stop every running chat and shell in every loaded repo, release each repo's
   lock, remove this server's tailscale mapping, then delete `server.json` only if its pid is ours.

A 1.x per-repo server still running is not detected (it writes no `server.json`). The existing per-checkout chat lock
keeps the two from running chats in the same repo at once.

### Per-repo contexts (lazy)

- The server keeps a `Map<repoId, ProjectContext>`. A context is what `startRepoMode` builds today: repo, log,
  prompts, chats, watch and route table. It's created on the first request for that repo, never at startup.
  Concurrent first requests share one creation promise, like `switchToRepo` today. It's never unloaded before
  shutdown.
- **Listing a repo** (projects list and combined view) doesn't create a context. It reads `config.yml` (via the
  repo's own lib), the version file, the task files and `ui/sessions.json` directly.
- Version states per repo come from the existing `resolveRepo` / `compareInterface`:
  - `ok`: served.
  - `pre-1.0`: listed with a card showing the existing `versionMessage`. Its routes answer 409 `repo-too-old`.
  - `repo-newer`: listed with the card "This repo uses Shipline <v>. Stop this server (Ctrl+C) and run
    `npx @forgeyard/shipline@<v> ui`." Its routes answer 409 `repo-newer`. Other repos keep working.
  - `missing` (folder or `.shipline/config.yml` gone): greyed out with "Folder not found" and a Remove button.
    Its routes answer 410 `repo-missing`. It's never auto-removed.
- **Install contexts:** `ui` or a handoff in a folder without Shipline creates an in-memory context with state
  `install`. It's listed in the switcher as "Not set up" until Install succeeds (then it's registered and switched
  to repo mode, as `switchToRepo` does today) or the user dismisses it. It isn't persisted across restarts.
  - **Id:** the same function as registry ids (the first 12 hex characters of sha256 of the real install root), so
    the id and URL stay the same after Install.
  - **Repeat handoff:** a handoff for a folder that already has an install context reuses that context.
  - **Dismiss** (`DELETE /api/projects/:repoId` on an install context): removes it from memory. Its routes then
    answer 404 `unknown-repo`, and the UI goes to `#/all`.

### API (all existing auth, Host and Origin checks unchanged)

- **Per-repo:** every route that `startRepoMode` and `installRoutes` register today moves from `/api/<x>` to
  `/api/repos/:repoId/<x>`, with the same methods and bodies. Examples: `/api/repos/:repoId/chats/:id`,
  `/api/repos/:repoId/setup/save`, `/api/repos/:repoId/status`. Unknown `repoId` → 404 `unknown-repo`.
- **Server-wide, unchanged paths:** `/api/remote`, `/api/remote/pair`, `/api/remote/claim`, `/api/events`, `/pair`.
- **New server-wide routes:**
  - `GET /api/projects` →
    `[{ id, root, name, group, groupName, branch, state, version, setupDone, loaded, waiting, chatRunning }]`.
    `name` is the folder name; `groupName` is the main worktree's folder name; `waiting` is the count of chats
    waiting for the user (see Badge).
  - `DELETE /api/projects/:repoId` → unregisters only. 409 `chat-running` if a chat runs there. The store and
    files are untouched. If the repo's context is loaded, it's disposed: stop its file watch and shells, release
    its lock and drop it from the context map. Its routes then answer 404 `unknown-repo`.
  - `GET /api/overview` → `{ needsYou: [...], chats: [...], tasks: [...], health: [...] }`, each item carrying
    `repoId`. Built without loading contexts; `needsYou` comes only from loaded repos, since only they can have
    running chats.
  - `GET /api/handoff/ping` and `POST /api/handoff`: loopback Host only. They require `X-Shipline-Key` (compared
    with `safeEqual`) and need no cookie; any other caller gets 403.
- **SSE:** one stream as today. Every event a per-repo module sends gains a `repoId` field. A new event,
  `projects`, carries the `/api/projects` payload whenever registration, state, `waiting` or `chatRunning`
  changes.

### Badge: "waiting for you"

A chat in a loaded repo counts as waiting when it has an unanswered permission prompt, an unanswered question or
stage confirmation, or it stopped with an error that hasn't been seen since. A finished, idle chat doesn't count.

The "error not seen" state is an in-memory `errorUnseen` flag on the chat's runtime record in its repo context:
- It's set when the chat stops with an error.
- It's cleared by the existing get-chat request (`GET /api/repos/:repoId/chats/:id`), which the UI makes when the
  chat is opened.
- Every set and clear sends the `projects` event.
- It isn't saved, so it resets when the server restarts.

### Logging

- The per-repo `ui.log` stays in each repo's store; per-repo modules log through their context's logger.
- Server-level events (start, handoff, registry changes, remote on or off, shutdown) go to `<shiplineHome>/ui.log`.
- The phone audit line (device, method, path, status) goes to the repo's log for `/api/repos/:id/...`, and to the
  server log otherwise.
- `log.mjs` changes from one module-level file to `createLogger(file)`. A server logger plus one per context
  replaces `initLog`.

### Phone access

- Still one `tailscale serve` mapping, now for the one server. The 443 → 8443 → 10000 fallback stays, because those
  ports can be taken by other software on the tailnet name.
- A paired device reaches every registered repo. The docs say so plainly.

### `shipline upgrade --all [--yes] [--dry-run] [--force]`

- Runs `runUpgrade` once per registered repo whose state isn't `missing`, sorted by path, each with its own preview
  and confirmation (or `--yes` / `--dry-run` passed through).
- `--all` together with `--dir` is a usage error.
- A failure in one repo is reported and the run continues. At the end it prints a summary (upgraded, already
  current, skipped as missing, failed) and exits 1 if any failed.
- Running it while chats run behaves as `upgrade` does today, per repo.

### Registration hooks in the CLI

- `init` (all modes, including the wizard's Install), `ui` (when the folder is installed) and `upgrade` (each repo):
  register or refresh the entry.
- `uninstall`: unregister after a successful uninstall.
- A registry write failure is a warning, never a failed command.

### Frontend

- **Hash routes:** `#/r/<repoId>/chat`, `#/r/<repoId>/chats`, `#/r/<repoId>/setup` and `#/all` (the combined view).
  An old-style hash (`#chat`, `#setup`, `#chats`) or an unknown repo id redirects to the last repo used in this
  browser (localStorage, wrapped in try/catch) or to `#/all`. The phone's default landing is `#/all`; the laptop's
  is the repo in the handoff link.
- **API client:** `src/lib/api.ts` takes the current `repoId` for per-repo calls. TanStack Query keys include
  `repoId`. `src/lib/events.ts` routes events by `repoId` and handles `projects`.
- **Project switcher:** at the top of the sidebar on the laptop, and in the mobile chat list header on the phone.
  - Projects are grouped by `group`: the worktrees of one repo sit under its `groupName`, each labelled with folder
    and branch.
  - Each entry shows a waiting count badge; the switcher button shows the total waiting in *other* repos.
  - Missing, too-old, newer and not-set-up repos show their state. Remove from list sits in each entry's menu.
- **Combined view (`#/all`)** has four sections:
  1. **Needs you:** waiting chats with their repo and reason (permission, question or confirmation, error). Clicking
     one opens it.
  2. **Chats:** all chats in every repo, newest first, labelled with the repo.
  3. **Unfinished tasks:** per repo, with workflow and current stage (reusing `stage-dots`).
  4. **Repo health:** version, setup not done, and the upgrade / restart-newer / missing cards.
- **Install wizard:** works inside a repo context whose state is `install`. Its API calls go through
  `/api/repos/:id/...`.

## Files to Touch

**CLI (`packages/cli`)**
- `src/registry.mjs`: **create**. Registry read, write, merge, seed, id hashing, group lookup and per-entry state
  probe (no contexts).
- `src/ui/server-record.mjs`: **create**. Read, write and remove `server.json`; liveness check; handoff client used
  by `bin/shipline.mjs`.
- `src/ui/projects.mjs`: **create**. The `ProjectContext` map with lazy creation, install contexts, the
  `/api/projects`, `/api/overview` and handoff routes, and the `projects` SSE event.
- `src/ui/server.mjs`: **modify**. `startRepoMode` becomes context creation. Dispatch for `/api/repos/:repoId/...`;
  writes `server.json`; registers the start folder; shutdown across all contexts.
- `src/ui/repo.mjs`: **modify**. Expose the worktree group (git common dir) and branch; the state probe used without
  a context.
- `src/ui/chat.mjs`, `src/ui/chat-routes.mjs`, `src/ui/prompts.mjs`, `src/ui/setup.mjs`, `src/ui/tasks.mjs`,
  `src/ui/watch.mjs`, `src/ui/diagnostics.mjs`, `src/ui/commands.mjs`, `src/ui/shell.mjs`: **modify**. Take a
  project context instead of the single `app.repo`; add `repoId` to SSE events; report waiting state (chat).
- `src/ui/install-routes.mjs`: **modify**. Serve an install context; on Install, register and switch the context to
  repo mode.
- `src/ui/sessions.mjs`: **modify**. Lock message wording for a lock held by another server process.
- `src/ui/remote.mjs`, `src/ui/remote-routes.mjs`: **modify**. One mapping for the server; the audit log goes to
  the repo or server logger.
- `src/ui/auth.mjs`: **modify**. Mint a one-time login token for the handoff; key check for the handoff routes.
- `src/ui/log.mjs`: **modify**. `createLogger(file)` replaces the module-level file; server log at
  `<shiplineHome>/ui.log`.
- `src/ui/sse.mjs`: **modify** only if needed to carry `repoId`; otherwise unchanged.
- `src/init.mjs`, `src/upgrade.mjs`, `src/uninstall.mjs`: **modify**. Registry register and unregister; `upgrade
  --all` in `upgrade.mjs`.
- `bin/shipline.mjs`: **modify**. The `ui` handoff path; `upgrade --all` parsing and help text.
- `package.json`: **modify**. Version 2.0.0.
- `CHANGELOG.md`, `README.md`: **modify**. 2.0.0 entry: one server, the registry, `upgrade --all`, and that a
  paired phone reaches every repo.

**UI (`packages/ui`)**
- `src/app.tsx`: **modify**. Hash routes with the repo, `#/all`, old-hash redirect, last-repo memory.
- `src/lib/api.ts`, `src/lib/queries.ts`, `src/lib/events.ts`, `src/lib/types.ts`: **modify**. Per-repo
  prefixing, the projects and overview calls and types, query keys with `repoId`, event routing and the `projects`
  event.
- `src/components/project-switcher.tsx`: **create**. The switcher with grouping, badges, states and Remove.
- `src/pages/overview/overview-page.tsx`: **create**. The combined view.
- `src/components/app-sidebar.tsx`, `src/components/mobile-chat-list.tsx`, `src/components/mobile-tab-bar.tsx`:
  **modify**. Place the switcher and add the `#/all` entry.
- `src/components/banners.tsx`: **modify**. Per-repo version banners become the health cards shown for the current
  repo.
- `src/pages/install/install-wizard.tsx`, `src/pages/chat/chat-store.ts`, `src/pages/setup/setup-page.tsx`:
  **modify**. Use the current `repoId` (only where they call the API or subscribe to events directly).

**Docs (repo root)**
- `docs/usage.md`: **modify**. One server, handoff, `--port` and `--remote` while running, `upgrade --all`, the
  project switcher and combined view.
- `docs/phone-access.md`: **modify**. One URL for all repos; a paired device reaches every registered repo.
- `docs/install.md`: **modify**. Registration on `init`, `upgrade` and `uninstall`; `upgrade --all`.
- `docs/troubleshooting.md`: **modify**. A stale `server.json`; a 1.x server still running; a repo shown as
  missing.

**Tests (path and version updates only, no new tests)**
- `packages/cli/test/ui/*.mjs` (the files that call `/api/...`) and `packages/cli/test/paths-eol.test.mjs`,
  `packages/cli/test/protected-paths.test.mjs`: **modify**. Per-repo route paths become `/api/repos/<id>/...`; the
  helpers learn the repo id.
- `packages/cli/test/cli.test.mjs`, `packages/cli/test/init-version.test.mjs`,
  `packages/cli/test/publish.test.mjs`: **modify**. The expected version becomes 2.0.0 (the known-hash assertions
  for templates are unchanged).

## Behavior & Edge Cases

- **Two `shipline ui` runs racing with no server:** both may start a server. The second to write `server.json`
  wins; the other keeps running on its own port, and the per-checkout chat lock prevents conflicts. Not worth a
  machine lock in this pass.
- **A stale `server.json`** (crash or reboot): the liveness check fails, a new server starts and overwrites it.
- **Handoff to a server that's shutting down:** the handoff fails, and the CLI falls back to starting a new server.
- **A repo moved while loaded:** its watch and requests start failing; the state becomes `missing` on the next probe
  (the projects list or the next request).
- **Removing the repo you're viewing:** the UI navigates to `#/all`.
- **Two chats in different repos waiting at once:** both are counted; the badge shows the total for other repos.
- **The install context is dismissed or the server restarts before Install:** nothing is written, as today.
- **`uninstall` while the server has that repo loaded:** `uninstall` already refuses while a chat holds the lock;
  otherwise it unregisters, and the loaded context turns `missing` on the next probe.
- **Empty registry** (fresh machine, `ui` run in an uninstalled folder): only the install context is listed.
- **No paired devices and phone access off:** everything as today, minus per-repo ports.

## Constraints

- Node 22+, and no new dependencies in `packages/cli` (the CLI stays dependency-free).
- Templates and hooks stay untouched (no template-hash bump).
- Security:
  - The handoff routes are loopback-only and key-checked.
  - `server.json` is 0600.
  - A paired device's reach widens to every registered repo (accepted; documented).
  - The existing Host, Origin and cookie checks apply to every new route.
- Startup cost stays flat with many repos (lazy contexts; listing reads small files only).

## Verification

Manual, by the user:

1. **Laptop:**
   - Run `shipline ui` in repo A, then in repo B and in a worktree of A.
   - B's run hands off and exits, the switcher shows A (with its worktree grouped under it) and B, and URLs carry
     `#/r/<id>/...`.
2. **Chats:** run chats in A and B at once. A permission prompt in B shows a badge while you view A, and "Needs you"
   in `#/all` lists it.
3. **Uninstalled folder:** `shipline ui` in an uninstalled folder opens the wizard in the running server; after
   Install it joins the list.
4. **Edge states:**
   - Rename a registered repo's folder: it shows as missing, and Remove works.
   - A repo with a newer version file shows the restart-newer card.
5. **Flags:** `--remote` on a second run turns on phone access in the running server; `--port` prints the note.
6. **Upgrade:** `shipline upgrade --all --dry-run`, then a real run.
7. **Phone:** pair once and reach every repo through one URL; the switcher, badge and `#/all` work on the mobile
   layout.
8. **Existing suite:** passes after the path and version updates (run through test-runner when asked).

## Open Questions

- None blocking. Accepted trade-offs:
  - Two simultaneous cold starts can briefly produce two servers.
  - A 1.x per-repo server isn't detected (the chat lock covers conflicts).
  - Install contexts aren't persisted across restarts.

---

## Revision 1 (2026-11-16): chat-first navigation and Health

**Status:** Approved. Agreed in conversation after the first build and QA pass. Where this section conflicts with the
sections above, this one wins.

### Why

In the first build, the All projects item hid every other nav item: the sidebar showed New chat, Chat, Setup, the
chat list and Status only while a repo was open. Discussing a fix led to a simpler model. The user thinks in chats,
not projects, so the sidebar becomes one flat chat list across all projects. Health gets its own page.

### Sidebar (laptop) and phone navigation

```
＋ New chat
▦ All projects   (n)     n = chats waiting for you, across all projects
⚙ Setup
♥ Health         ●       worst health state across projects
───────────────
flat chat list
───────────────
◐ Theme
```

- **No project switcher.** `project-switcher.tsx` is deleted. Projects are reached through All projects, the New
  chat picker and the Setup selector.
- **The items above are always visible** in every view; nothing is hidden by the current view. The active item is
  highlighted.
- **Flat chat list:** every chat in every registered project, sorted by latest activity (newest first).
  - Each row shows the title, the project name (plus the worktree folder when it isn't the main worktree), the
    workflow, stage dots and a waiting dot (permission, question or confirmation, or an unseen error, as defined in
    "Badge").
  - Chats of missing projects are not listed.
- **Phone:** the same structure. The chat list is the Chats tab, and the tab bar gets All projects, Setup and
  Health in place of the old per-repo tabs.
- **The Status row in the footer is removed.** Its role moves to Health.

### Views and hash routes

| Hash | View |
| --- | --- |
| `#/chat/<chatId>` | A chat. Chat ids are unique across projects, and the server maps an id to its repo. |
| `#/new` | The new-chat screen. |
| `#/all` | All projects. |
| `#/setup/<repoId>` | Setup for one project. |
| `#/health` | Health. |

- **Redirects:** old hashes (`#chat`, `#setup`, `#chats`, and `#/r/<id>/...` from the first build) redirect: a chat
  route to `#/chat/<id>`, Setup to `#/setup/<id>`, anything else to `#/all`.
- **Unknown ids:** an unknown chat id or repo id goes to `#/all` with a toast.
- **Default landing:** the laptop lands on `#/new` with the project preset to the handoff repo. The phone lands on
  `#/all`.
- **The last project used** (localStorage, in try/catch) is the project of the chat last opened, or the project
  last picked in New chat or Setup.

### New chat

- A project dropdown sits at the top of the new-chat screen. It's preset to the last project used, or to the handoff
  repo when the page was opened from `shipline ui`.
- Only `ok` projects can be picked. The others are listed but disabled, with their state.
- The unfinished tasks with no chat, which already show on this screen, are filtered to the picked project.

### Chat header

Shows the chat's project name and branch next to the title, on the laptop and in the phone header's subtitle.
Clicking the project name opens `#/setup/<repoId>`.

### Setup

One Setup page with a project dropdown at the top, preset to the last project used. Changing it changes the hash
to `#/setup/<id>`. A project that isn't `ok` shows its state card instead of the form.

### All projects (`#/all`)

From top to bottom:
1. **Needs you:** waiting chats across projects, each with its project and reason.
2. **Project cards:** one per project, with worktrees grouped under their repo.
   - Each card shows the name, branch, state, waiting count, unfinished task count and health dot.
   - Actions: New chat here (`#/new` preset to the project), Setup, and Remove from list (as `DELETE
     /api/projects/:id`).
3. **Unfinished tasks:** per project, with workflow and stage dots, including tasks with no chat.
4. **Health summary:** one line, "N projects need attention → Health", or "All projects healthy".

The "Chats" section of the first build's overview is dropped, since the sidebar list covers it.

### Health (`#/health`)

- **Overall (machine):**
  - Shipline server version and the CLI version that started it.
  - Claude: path, installed, signed in, version, meets the minimum.
  - Node version, port, and phone access state (off, on with its URL, or the Tailscale problem).
  - The server log tail (`<shiplineHome>/ui.log`, last 50 lines, redacted).
- **Per project:** one row per project.
  - State: ok, missing, repo-newer, pre-1.0 or install.
  - Setup done or not, a `config.yml` parse error, the chat-lock holder (pid and port), and the warning count
    (the per-repo banners that the Status row used to count).
  - The existing state cards: restart-newer, missing with Remove, upgrade this repo.
  - Expanding a row loads that project's diagnostics (`GET /api/repos/:id/diagnostics`: summary, last log lines,
    raw redacted data). This replaces today's Diagnostics sheet.
- **Health dot (sidebar and project cards):**
  - **Red:** Claude is missing or not signed in, or the project is repo-newer or pre-1.0, or has a config parse
    error.
  - **Amber:** missing, setup not done, or other warnings.
  - **Green:** otherwise.

### API changes (all server-wide; auth as for the other server-wide routes)

- `GET /api/chats`: the flat list.
  - Fields: `[{ id, repoId, title, updatedAt, task: { workflow, stage, stages } | null, waiting: null | 'permission'
    | 'question' | 'error' }]`.
  - Built from each registered `ok` project's `ui/sessions.json` and task files without loading contexts. `waiting`
    comes from loaded contexts only.
  - The SSE `projects` event is joined by a `chats` event carrying this payload whenever a chat is added, renamed or
    removed, its task stage changes, or its waiting state changes.
- `GET /api/chats/:chatId/repo` → `{ repoId }`, so `#/chat/<id>` can resolve its project. 404 `unknown-chat`.
- `GET /api/health` → `{ machine: {...}, projects: [{ id, state, setupDone, configError, lock, warnings, dot }] }`.
  - Built without loading contexts, except `warnings`. That counts banners for loaded projects; for unloaded ones it
    uses what can be checked from files (config parse error, version state).
  - The `projects` event also refreshes the health dot.
- `GET /api/overview` drops `chats` and `health`, and gains `projects` (the card data) and `attention` (the count of
  projects whose dot isn't green).
- Per-repo `/api/repos/:id/status` and `/api/repos/:id/diagnostics` stay. The Status row was their only frontend
  caller apart from the Diagnostics sheet, and Health now calls them.

### Also in this pass

**Fix the 6 failing tests:**
- **`upgrade --help` usage (2 tests):** update the expected text for `--all`.
- **`publish.test.mjs:341`:** remove the stale `1.3.0`.
- **`setup.test.mjs:1378`:** now expects 409 `repo-newer`.
- **`relay.test.mjs:458` and `:485`:** find out why a permission prompt with no answer is no longer denied at the
  timeout after the relay URL moved to `/api/repos/<id>/relay`, and fix the cause in the code, not the test.

**QA findings (`.claude/qa-reports/multi-repo-ui-2026-11-16.md`):**
- **F1:** don't request tasks for a project that isn't `ok`.
- **F2:** obsolete under the new routes; make sure `#/setup/<valid id>` with trailing junk opens that project.
- **F3:** the "You're set up" screen gets the normal sidebar.
- **B1:** `ui --dir <nonexistent>` fails with "not a directory" on a cold start too.
- **B2:** `POST /api/handoff` refuses a non-absolute `dir` with 400.

### Files to Touch (in addition to the list above)

**UI (`packages/ui`)**
- `src/components/project-switcher.tsx`: **delete**.
- `src/components/app-sidebar.tsx`: **modify**. The new item set and the flat chat list with project labels; no
  Status row.
- `src/components/mobile-tab-bar.tsx`, `src/components/mobile-chat-list.tsx`: **modify**. The same structure on the
  phone.
- `src/components/chat-row.tsx`: **modify**. The project label and waiting reason.
- `src/components/banners.tsx`: **modify**. Health cards are used by Health and Setup.
- `src/app.tsx`, `src/lib/routes.ts`: **modify**. The new routes and redirects; last project used.
- `src/lib/api.ts`, `src/lib/queries.ts`, `src/lib/events.ts`, `src/lib/types.ts`: **modify**. `chats`, `health`,
  chat→repo, the overview change, and the `chats` event.
- `src/lib/use-chat-selection.ts`: **modify**. Selection by `#/chat/<id>`.
- `src/pages/chat/chat-page.tsx`: **modify**. The project picker on the new-chat screen, tasks filtered by project,
  and the project in the header.
- `src/pages/setup/setup-page.tsx`: **modify**. The project dropdown, and a state card for projects that aren't `ok`.
- `src/pages/overview/overview-page.tsx`: **modify**. The new sections.
- `src/pages/health/health-page.tsx`: **create**.
- `src/pages/diagnostics.tsx`: **modify**. Its content is reused inside a Health project row; the sheet is no longer
  opened from the sidebar.
- `src/pages/install/install-wizard.tsx`: **modify**. The "You're set up" screen with the sidebar (F3).

**CLI (`packages/cli`)**
- `src/ui/projects.mjs`: **modify**. `GET /api/chats`, `GET /api/chats/:chatId/repo`, `GET /api/health`, the
  overview change, the `chats` event, and the B2 check.
- `src/ui/chat.mjs`: **modify** only as needed to emit the `chats` event on add, rename, remove and waiting changes.
- `src/ui/server-record.mjs` and/or `bin/shipline.mjs`: **modify**. B1.
- `src/ui/prompts.mjs` / `src/ui/chat-routes.mjs`: **modify**. The relay timeout fix (exact file per the cause).

**Tests (updates only)**
- `test/cli.test.mjs`, `test/publish.test.mjs`, `test/ui/setup.test.mjs`: **modify** (as above). `test/ui/relay.test.mjs`
  is changed only if the investigation shows the test, not the code, is wrong. Report that if it happens.

**Docs**
- `docs/usage.md`, `docs/phone-access.md`, `docs/troubleshooting.md`, `packages/cli/CHANGELOG.md`: **modify**.
  Chat-first navigation, Health (replacing Status and Diagnostics), and the project picker.
