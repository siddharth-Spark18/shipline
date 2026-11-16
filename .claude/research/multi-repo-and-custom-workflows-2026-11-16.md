# Multi-repo on one machine, and custom workflows (ideation, 2026-11-16)

Discussed on main at 1.3.0 (teams roadmap phases 1–4 done). Order agreed: **multi-repo first**, custom workflows after.

## 1. Several repos with Shipline on one machine

**Today (from the code):**
- Per-repo state is already isolated: `$SHIPLINE_HOME/projects/<encoded repo path>/` (tasks, `ui/` sessions, lock, logs). The folder appears only once a repo has a task, so it is not a reliable registry.
- `shipline ui` serves exactly one repo (`resolveRepo` in `src/ui/repo.mjs`), on a free port. The whole server (~9k lines in `src/ui/`) assumes one `app.repo`.
- A chat lock keyed by port stops two UIs running chats in the same repo (`acquireLock` in `sessions.mjs`).
- Paired phones are machine-wide (`~/.shipline/devices.json`); the `tailscale serve` record is machine-wide too (`remote-serve.json`).
- Phone access tries HTTPS ports 443, 8443, 10000 only (`src/ui/remote.mjs:11`): at most three repos at once, one URL each.
- `upgrade` is per repo; nothing lists installed repos or their versions.
- The server already loads each repo's own vendored `lib.mjs` and checks `compareInterface`.

**Direction chosen: C — one server for every repo.**
- One port, one phone URL (one `tailscale serve` mapping), so the three-repo limit goes away.
- Repos are registered **automatically** on `init` / `ui`, and removed on `uninstall` (plus manual removal in the UI).
- UI: a **project switcher with a badge** when a chat in another repo is waiting for the user, **and a combined view** of chats and tasks across all repos.
- Each repo keeps its own vendored `lib.mjs` and interface check; a repo too old to load shows an "upgrade this repo" card instead of breaking the server.
- Running `shipline ui` while the server is up should reuse it and switch to that repo (implied by "one server").

**Open, left for planning:** server lifetime — tied to the `shipline ui` terminal (like today) or a background service that survives the terminal / starts at login.

**Limitations raised:**
- Large refactor: chats, watch, setup, auth, remote, SSE all assume a single repo.
- Version skew between repos must be handled per repo.
- Registry needs a real home (e.g. under `~/.shipline/`), since the projects folder only appears on first task.
- Options A (`shipline list`, `upgrade --all`) and B (hub page, server per repo) were considered and not chosen; `list` / `upgrade --all` may still fall out naturally from the registry.

## 2. Custom workflows (after multi-repo)

**Today:** workflows are YAML in `.shipline/workflows/`. Setup can create a blank workflow (one Implement stage), copy, add shipped ones back, delete (blocked while tasks use it), and edit stages, blocks and rules, with `validateWorkflow` and an impact list for open tasks. `/shipline-setup` covers the workflow set only as part of a one-time interview over everything.

**Gaps:** no focused "create a workflow" flow; the blank workflow requires knowing `enforcement`, `checkpoint`, `sections`, `blocks`, `checks`; YAML Claude writes isn't validated until a hook reads it; new stage ids need hand-written `rules/<id>.md`.

**Chosen:**
- A. `/shipline-new-workflow` skill: interview → workflow YAML + starter rules → checked by a new `shipline validate` that reuses the UI validator.
- B. The same flow in Setup in the UI ("Describe a workflow"), through the existing preview / save dialog.
- C. More shipped workflows to start from (e.g. Spike/Research, Refactor, Docs, Dependency bump, Release).

**Not chosen for now:** new gate types (named-person sign-off, waiting on a ticket status). Custom workflows are limited to today's stage building blocks (artifact, sections, blocks, checks, agent, confirm/checkpoint).
