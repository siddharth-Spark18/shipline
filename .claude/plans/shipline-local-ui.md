# Shipline Local UI (`npx shipline ui`)

*   **Author:** Siddharth Paneri
*   **Status:** Draft (review findings resolved 2026-11-03)
*   **Date:** 2026-11-03

--------------------------------------------------------------------------------

## Overview

Shipline v2 (`docs/plans/shipline-v2-repo-init.md`) installs a Claude Code
workflow into a repo with `npx shipline init`. The installed files are committed:
`.shipline/` (config, workflows, per-stage rules, dependency-free hook scripts in
`bin/`), `.claude/` agents, skills and hooks, and a block in `CLAUDE.md`. A team
then customizes the workflow by running the `/shipline-setup` interview inside
Claude Code. After that, the hooks enforce the workflow in every Claude surface:
terminal, IDE extension and desktop app.

This design adds a second command, `npx shipline ui`, in the same npm package.
It starts a local web server on `127.0.0.1` that runs only while the command
runs (Ctrl+C stops it). The server serves one checkout: the repo it was started
in. It has two parts:

*   **Setup screen.** A form-based editor for the files `/shipline-setup` already
    writes: `config.yml`, `workflows/*.yml` and `rules/<stage>.md`. Either tool
    can be used for setup, in either order, and neither loses the other's
    fields.
*   **Chat.** A browser chat that runs the developer's own installed `claude`
    CLI as a child process and shows its output. Claude's permission prompts and
    questions appear as cards in the browser. A side panel always shows the
    current task's workflow stages, the artifacts in its task folder, and the
    working-tree changes (`git status`).

"v1", "the hub" and "the prior implementation" in this document all mean the
retired hosted Shipline: `apps/api`, `apps/web`, `apps/local` and
`packages/shared` in this repo. Some of its code is copied here; none of it is
imported.

The work ships in three phases with a gate before the last one:

| Phase | Content | Release | Ships alone? |
| --- | --- | --- | --- |
| 0 | Groundwork in the existing CLI and hooks: version stamp, YAML writer, lost-task warning, visible warn-mode reminders, rename of `apps/local`. A throwaway chat test runs in parallel. | `shipline` 0.4.0 | Yes (improves v2 without any UI) |
| 1 | Local server, auth, setup screen, Tasks panel, diagnostics. | 0.5.0 | Yes |
| Gate | `-p` use is allowed, the reason to build a chat is written down, a Phase 1 dogfood signal exists, and the chat test answered its questions. A "no" on `-p` ends the work after Phase 1. | n/a | n/a |
| 2 | Chat with permission cards: spawning and resuming `claude`, session list, lock, side panel, permission and question cards through a local relay. | 0.6.0 | Yes |

Decisions in Phase 2 that depend on how Claude Code behaves are marked
**[test-dependent]**. The chat test (item 19) settles each one. No fallback
code is built in advance.

## The Problem

### How Shipline v2 works today

*   **Tasks and manifests.** A task is a folder under `artifact_root` (default
    `docs/shipline/<task>/`). Its `manifest.json` is committed and holds
    `task` (`slug`, `title`, `key`, `workflow`, `branch`), `flags.ui`, and
    `stages`: a list of `{ id, status, artifact }` where status is `pending`,
    `in_progress`, `done` or `skipped`. When a task starts, `stage.mjs start`
    **copies the workflow's stage list into the manifest**. Later changes to
    the list of stages in a workflow file don't reach tasks already open.
*   **Settings are read on every call.** Each stage's `enforcement`,
    `blocks`, `confirm_to_advance`, `artifact` and rules are read from the
    workflow and rules files every time a hook runs, so changes to them apply
    to open tasks at once.
*   **Sessions and state files.** Claude records progress by running
    `node .shipline/bin/stage.mjs <command>` (`start`, `resume`, `status`,
    `advance`, `skip`, `reopen`). `start` and `resume` bind the current Claude
    session to a task by writing `.shipline/.state/<session id>.json`
    (gitignored) with `{ session_id, workflow, task_dir }`.
*   **How `stage.mjs` knows the session.** The SessionStart hook
    (`session-start.mjs`) appends `export SHIPLINE_SESSION=<id>` to the file
    named by `CLAUDE_ENV_FILE`, an environment file Claude Code loads into
    every Bash tool command. `stage.mjs` reads `SHIPLINE_SESSION` (or
    `--session <id>`).
*   **Enforcement.** The PreToolUse hook (`guard.mjs`) reads the session's
    state file (`readSession`), then the manifest, then finds the current
    stage and checks the `blocks` rules of every stage that isn't done yet.
    It exits silently when the session has no state file. A broken config
    produces a visible warning instead (`failOpen` in `lib.mjs`).

### Glossary

*   **`guide` / `warn` / `block`:** a stage's enforcement level. Under `guide`
    the stage's `blocks` rules are ignored. Under `warn` a call matching them
    is allowed, and Claude gets a reminder. Under `block` the call is denied
    with a reason.
*   **`blocks` entry:** what a stage holds back until it is done. Either
    `{ tools: '<regex of tool names>', allow_paths: [globs] }` (those tools
    are held back except on matching paths) or `{ bash: '<regex>' }` (Bash
    commands matching the regex are held back).
*   **`condition: ui_only`:** the stage runs only when the task is flagged as
    UI work (`stage.mjs flag ui true`). Otherwise it is skipped.
*   **Feature task:** a task on the `feature` workflow (`workflows/feature.yml`).
*   **`system/init`:** the first event `claude` prints in stream-json mode. It
    carries the session id.

### What is wrong today

**Setup is a text interview, and it is hard to see the whole workflow at once.**
`/shipline-setup` asks one question at a time and writes YAML. A team lead
deciding on a workflow has to keep the stage order, each stage's enforcement
level, its confirm-to-advance setting and its rules in their head, or open
several YAML files. The YAML subset the hooks read is strict. A typo in
`enforcement` falls back to `guide` with no error, so the team believes a
stage is enforced when it is not.

**Daily work gives no view of where a task stands.** In the terminal or the
extension, a developer sees Claude's messages but not the task's current stage,
which stages are left, which artifacts exist, or which files changed. To find
out, they run `node .shipline/bin/stage.mjs status` or read `manifest.json` and
`git status` themselves.

**Some v2 gaps are bugs today, with or without a UI.**

*   `init` writes no version stamp. Nothing can tell which Shipline version
    installed a repo, so any future tool that reads or writes `.shipline/`
    files can't check that it is compatible with them.
*   When a session that should be working on a task has no state file (for
    example, a new session opened on the task's branch, or a lost state
    file), the guard exits silently and enforces nothing. A team on `block`
    mode would not notice.
*   `warn` mode is invisible to the developer: the reminder goes only to
    Claude (`additionalContext`), so nobody sees that a rule was hit.
*   Two workspace packages are named `shipline`: `packages/cli` (the CLI) and
    `apps/local` (the hub's local service). `pnpm --filter shipline` matches
    both, and `apps/local` could be published under the CLI's name by mistake.

**Why not just use Claude Code's own extension or desktop app?** They already
show chat, tool calls and diffs, and the hooks already work inside them. What
they don't show is Shipline's own state: the workflow stages, the task's
artifacts and enforcement status, next to the chat. The browser chat is
justified only if that view is worth running one more local process. Phase 0
and Phase 1 deliver value even if the chat is never built. The gate before
Phase 2 makes that call on evidence.

## Goals

Phases are in brackets. Each goal names its test. "Item N" refers to the
Detailed Implementation Plan.

1.  **Version stamp [0].** `init` writes `.shipline/bin/VERSION` with the
    package version and an interface version. A repo without the file is
    reported as "legacy". Every refusal message names a command the user can
    run.
    *Test:* item 17.
2.  **Lost-task warning [0].** A session with no state file, on a git branch
    that equals an unfinished task's `task.branch`, gets one visible warning
    per session saying how to resume. This also fires for a new session
    opened on that branch, which is intended: that session isn't enforcing
    the task's rules either. Sessions on other branches stay silent.
    *Test:* item 16.
3.  **Warn reminders are visible [0].** A call that hits a `warn` stage's
    `blocks` rule shows "Shipline reminder: ..." to the developer, in the
    terminal and in the UI, and Claude still gets the reminder.
    *Test:* item 16.
4.  **No data lost on save [0, 1].** For every shipped template and a set of
    hand-edited fixtures: parsing the file on disk, applying the form's edits,
    writing it, and parsing the result with the repo's own vendored
    `.shipline/bin/lib.mjs` gives the expected structure. Keys the form doesn't
    know are kept. The comments and quoting of the shipped templates are
    kept.
    *Test:* items 13, 15, 45.
5.  **Setup parity [1].** A workflow saved from the UI loads in the hooks with
    no fail-open warning. Editing by hand or with `/shipline-setup` and then
    in the UI, or the reverse, loses no fields.
    *Test:* item 45 (interchangeability case).
6.  **Open-task impact shown [1].** Before a workflow save that adds, removes
    or reorders stages, the UI lists every open task whose manifest keeps the
    old stage list.
    *Test:* item 45.
7.  **Local-only access [1].** The server rejects requests whose `Host` is not
    `127.0.0.1:<port>`, state-changing requests without a matching `Origin`,
    and requests without the session cookie. The one exception is the relay
    callback `POST /api/relay`, which must carry no `Origin`, needs no cookie,
    and is authenticated by its per-spawn secret instead.
    *Test:* item 45 (auth cases) and item 59 (relay cases).
8.  **Gate parity [2].** A `block`-mode edit before the plan stage is denied
    with the same reason in the browser chat as in the terminal.
    *Test:* item 58, plus the Phase 2 manual check.
9.  **Resume [2].** After the UI server restarts, reopening a chat continues the
    same `claude` session, and the hooks find the same state file.
    *Test:* item 58, plus item 19 question 1.
10. **Clean exit [2].** Ctrl+C on `npx shipline ui` leaves no `claude` or relay
    processes running and releases the chat lock.
    *Test:* item 58 (shutdown case).
11. **Permission cards [2].** Every permission prompt and question Claude raises
    in a UI chat appears as a card. A prompt with no answer within the timeout
    is denied. A prompt still pending when the tab reloads is shown again.
    *Test:* item 59.
12. **The terminal keeps working.** With the UI never started, a clone of the
    repo behaves as v2 does today, apart from the two Phase 0 warnings (Goals
    2 and 3).
    *Test:* the Phase 1 manual check.
13. **Dogfood check (adoption, measured by hand).** A named team sets up one
    repo in the UI and runs a set number of real tasks through the browser chat
    in a set period. The team, task count and period are in Open Questions.
    *Test:* the dogfood manual check.

## Non-Goals

*   A view across several repos, or a projects list. (Later phase.)
*   Listing or attaching to sessions started in the terminal, extension or
    desktop app. The UI lists only chats it started.
*   Git worktrees or more than one active UI chat per checkout.
*   New guardrail types. The UI edits only what v2 supports: the three
    enforcement levels, `confirm_to_advance`, `blocks` and stage rules.
*   Access from another machine, LAN, or any auth other than the local token.
*   Editing `bin/*.mjs`, the `CLAUDE.md` block, agents or skills from the UI.
*   Committing or pushing on the user's behalf. After a save, the UI tells the
    user to commit.
*   Any policy logic in the permission relay. Hooks remain the only guardrail
    engine; the relay only passes a human's answer back.
*   Runtime dependency on `apps/local`, `apps/web` or `packages/shared`. Code
    worth keeping is copied into `packages/cli` as dependency-free `.mjs`, so
    removing the hub stays unblocked.
*   Handling, storing or forwarding Claude credentials. No Agent SDK. The UI
    runs the user's installed, unmodified `claude`.
*   "Draft with Claude" for stage rules (moved to Future Improvements).
*   Windows support (see Open Questions).

## Open Questions

*   **Is `-p` mode allowed?** Is a local app allowed to drive the user's own
    `claude` CLI in print mode (`claude -p`) on the user's subscription? The
    author decides by checking Anthropic's terms and usage policy for Claude
    Code, and asking Anthropic if the terms don't settle it. "Yes" means
    written confirmation or terms that clearly allow it. The answer is
    recorded in item 19. A "no" ends the work after Phase 1.
*   **Chat test results [test-dependent].** The questions are listed in item
    19: whether the session id is kept on resume, the hook environment under
    `-p`, AskUserQuestion routing, how many cards a task produces, a
    10-minute prompt, and the exact text of a guard denial.
*   **Upgrade path for existing repos.** `init` refuses on existing files and
    there is no `upgrade`. Repos initialized before Phase 0 never receive the
    lost-task warning, the visible warn reminders, or later `bin/` changes.
    When, if ever, does an upgrade command come into scope?
*   **Windows.** Out of scope for now. Process-group kill, pid liveness and
    path quoting differ. Revisit if a team needs it.
*   **Dogfood check.** Which team, how many tasks, over what period? This also
    sets the Phase 1 dogfood signal for the gate.

## Critical User Journeys (CUJs)

### CUJ 1: A team lead sets up a repo in the browser

*   **Given**: a repo where `npx shipline init` has run, and Node 20 or later.
*   **When**: the lead runs `npx shipline ui`, opens the Setup tab, drags
    `wireframes` after `implement`, sets `implement` to `warn`, edits
    `rules/plan.md`, and saves.
*   **Then**: the UI shows a diff of each file before writing. The comments in
    `config.yml` and the header of each workflow file are kept. Any other
    comment in a workflow file is shown as removed. The UI lists the open
    tasks that keep the old stage order. After confirming, it writes the files
    and tells the lead to commit them. A teammate who pulls the commit gets
    the new flow in the terminal with nothing else installed.

### CUJ 2: A developer checks task state next to the extension (Phase 1)

*   **Given**: a developer working on a task in the VS Code extension.
*   **When**: they open the UI's Tasks tab.
*   **Then**: they see each unfinished task, its stages with status, the files
    in its task folder, and the working-tree changes. The view updates within
    1 s of Claude advancing a stage or editing a file.

### CUJ 3: A developer works a Feature task in the browser chat (Phase 2)

*   **Given**: a repo with Shipline, signed-in `claude`, no other UI chat
    active in this checkout.
*   **When**: the developer starts a chat, describes the work, and Claude
    starts a Feature task, writes a plan, and tries to edit source before
    the plan is done.
*   **Then**: the side panel shows the task's stages. The edit is denied by the
    guard and shown as a Shipline block, not as a user denial. When Claude
    later needs to run a shell command, an Allow/Deny card appears. When
    Claude asks to advance past `plan`, the developer confirms in the chat.

### CUJ 4: The chat breaks and the developer continues in the terminal

*   **Given**: a running UI chat.
*   **When**: `claude` emits a line the UI can't parse, or the UI server is
    stopped.
*   **Then**: the UI stops the session cleanly and shows
    `claude --resume <id>`. The developer runs it in a terminal in the same
    checkout and continues. The hooks find the same state file. Reopening the
    chat in the UI later shows the terminal turns too, because history is read
    from Claude's own session file.

## Technical Plan (Architecture)

### Components

```text
 npx shipline ui  (packages/cli, Node >= 20 for this command)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ UI server  (node:http, 127.0.0.1:<random port>, no runtime deps)         │
 │                                                                          │
 │  static ui-dist/ ── built from packages/ui (React, Vite, Tailwind)       │
 │  /api/*  JSON       /api/events  SSE (server → browser)                  │
 │                                                                          │
 │  setup:   config + workflow + rules read/write  ── repo's .shipline/     │
 │  tasks:   manifests, task files, git status     ── watcher               │
 │  chat:    session index, lock, claude child     ── .shipline/.state/ui/  │
 │  relay endpoint  /api/relay  (per-spawn secret)                          │
 └───────────────┬───────────────────────────────────────▲──────────────────┘
                 │ spawn (stdin/stdout stream-json)      │ HTTP (loopback)
                 ▼                                       │
        user's own `claude -p ...`  ── stdio ──►  relay.mjs (MCP server,
        (hooks run as today:                      tool `approve`, no policy)
         session-start, prompt-submit, guard)
```

The browser never talks to `claude` or the relay directly. Everything goes
through the UI server.

### Packaging

*   **Server code** lives in `packages/cli/src/ui/` as dependency-free `.mjs`,
    the same style as the existing CLI. `shipline ui` checks for Node 20 or
    later. `init` and the vendored hooks stay at Node 18.
*   **Browser code** lives in a new workspace package `packages/ui` (React,
    Vite, Tailwind v4). It is private and never published. A `prepack` script
    in `packages/cli` builds it into `packages/cli/ui-dist/`, which is added to
    `files`. `ui-dist/` is gitignored and `prepack` rebuilds it on every
    `npm pack` and `npm publish`. CI fails if the built bundle is larger than
    the size budget (400 KB gzip for JS plus CSS).
*   **Copied, not imported**, from the prior implementation (each becomes a
    dependency-free `.mjs` file; see the item for each):
    *   `packages/shared/src/stream-json.ts`: the stream-json line parser.
    *   `apps/local/src/server/chat-session.ts`: spawn and line buffering.
    *   `apps/local/src/server/transcript.ts`: reading Claude's session files.
    *   `apps/local/src/server/claude-cli.ts` (`claudeHealth`): `claude`
        version and sign-in check.
    *   `apps/local/src/server/git.ts` (`gitRun`, `git`, `gitOk`) and
        `apps/local/src/server/diff.ts` (`diffFile`, `untrackedFiles`,
        `looksBinary`), plus `parseUnifiedDiff` from
        `packages/shared/src/local.ts`.
    *   `apps/local/src/server/assets.ts` (`resolveInsideWorktree`, which
        checks containment after `realpath`).
    *   `apps/local/src/server/watcher.ts` (`watchWorktree`).
    *   `packages/shared/src/versions.ts` (`compareVersions`,
        `meetsMinVersion`).
    *   `apps/local/src/server/http.ts` (the Host check) and
        `apps/local/src/server/pairing.ts` (timing-safe token compare).

### Server, auth and browser launch (Phase 1)

*   `npx shipline ui [dir] [--port <n>] [--no-open]`. `ui` has its own argument
    parser: `--port` takes the next argument, `--no-open` is a switch, and the
    first argument that isn't a flag or a flag's value is `dir`. The repo root
    is found by walking up from `dir` (or the current directory) to the first
    folder with `.shipline/config.yml`. Unlike `findRoot` in `lib.mjs`, it
    ignores `CLAUDE_PROJECT_DIR`. With no config found, it prints "run
    `npx shipline init` first" and exits 1.
*   It binds to `127.0.0.1` on a random port (or `--port`) and creates a
    32-byte random token. It prints and opens
    `http://127.0.0.1:<port>/?t=<token>`.
*   The first request with a valid `t` sets the cookie
    `shipline_ui_<port>=<token>; HttpOnly; SameSite=Strict; Path=/` and
    redirects to `/` without the token, so the token isn't left in history or
    sent in a Referer header. The port is in the cookie name because browsers
    share cookies across ports on the same host, so two UI servers would
    otherwise overwrite each other's cookie.
*   Checks on every request:
    *   `Host` must equal `127.0.0.1:<port>`. Anything else gets 403, which
        blocks DNS rebinding.
    *   Every POST except `POST /api/relay` must carry an `Origin` equal to
        `http://127.0.0.1:<port>` (or the dev origin, below). A POST without
        `Origin` gets 403.
    *   The cookie is required on every route except `/?t=<token>`, the
        static files in `ui-dist/`, and `/api/relay`.
    *   `POST /api/relay` is the one route with its own rules, because its
        caller is `relay.mjs`, a Node process that sends no `Origin` and has
        no cookie. It needs the `X-Shipline-Relay` header to equal the
        current spawn's secret. A request that carries any `Origin` header
        gets 403, so a browser page can't call it even if it learns the
        secret.
    *   Every secret comparison (cookie, relay secret) checks that the two
        byte lengths are equal before calling `crypto.timingSafeEqual`, as
        `apps/local/src/server/pairing.ts` does. A value of the wrong length
        gets the same 401 or 403 as a wrong value, never a 500.
    *   Request bodies over 1 MB get 413.
*   **Development.** When `SHIPLINE_UI_DEV_ORIGIN` is set (for example
    `http://localhost:5173`), that origin is also accepted in the `Origin`
    check. The Vite dev server proxies `/api` and `/?t=` to the UI server with
    `changeOrigin: true`, so the proxied `Host` is the UI server's own. The
    developer opens `http://localhost:5173/?t=<token>` once to get the cookie
    through the proxy.
*   The token is never written to the log.
*   **Startup order.** The server calls `listen` first (port 0 picks a free
    port), then creates the token and cookie name from
    `server.address().port`, because both depend on the real port. An invalid
    `--port` value or `EADDRINUSE` prints a one-line message and exits 1.
*   **Config errors at startup.** If `config.yml` doesn't parse, the server
    still starts. Setup shows the file read-only with the parse error and the
    Tasks tab is empty until the file is fixed. `cfg` is loaded again after
    every config save and on every watch event that touches `config.yml`, so
    a changed `artifact_root` reaches the task scan and the watcher.
*   Ctrl+C, SIGTERM, an uncaught error or an unhandled promise rejection runs
    one shutdown path. It awaits each module's `close()` in reverse start
    order (stop the `claude` process group, release the lock, close the
    watcher), with an overall limit of 7 s, then calls `process.exit`.
    Awaiting matters because `claude` runs in its own process group and
    `stop()` can take up to 5 s.

### Version stamp and contract (Phase 0 and Phase 1)

*   `init` writes `.shipline/bin/VERSION`, as its last write:
    `{ "package": "<semver>", "interface": <integer> }`. Interface 1 is the
    0.3.0 shape. Phase 0 makes it 2, because the guard gains the lost-task
    warning and visible warn reminders. Phases 1 and 2 don't change `bin/`,
    so they keep interface 2.
*   The interface number goes up when any of these change: `stage.mjs`
    commands or flags, the manifest or state file shape, the YAML subset, the
    hook entry points in `settings-hooks.json`, or what the hooks print.
*   On start, the UI compares the repo's interface number with its own. There
    are three states:
    *   **Same:** no banner.
    *   **Repo older (including no `VERSION` file, treated as interface 1):**
        an information banner: "This repo's hook scripts are from an older
        Shipline (interface <n>). They don't have: the lost-task warning,
        visible warn reminders." Nothing in the UI is disabled.
    *   **Repo newer than the UI:** the UI refuses to save or start a chat and
        shows "This repo was set up with Shipline <v>. Run
        `npx shipline@<v> ui`." The Tasks tab still works, read-only.
*   Known gap: existing repos have no way to get newer `bin/` files (see
    Open Questions and Risks).

### Renaming `apps/local` (Phase 0)

*   Today both `apps/local/package.json` and `packages/cli/package.json` are
    named `shipline`, and both declare a `shipline` bin. `apps/local` becomes
    `@shipline/local` with `"private": true` and no `bin`. The CLI keeps the
    npm name `shipline`.
*   What this fixes: `pnpm --filter` targets one package, and `apps/local` can
    no longer be published under the CLI's name.
*   What it can't fix: a copy already in a user's npx cache. The hub's local
    service was never meant to be published under this name, so this is
    expected to affect nobody outside the team.
*   Every hub string and README line that tells users to run `npx shipline`
    for the hub service changes to `pnpm dev:local` (items 11, 12 and 60).

### Saving setup changes (Phase 0 writer, Phase 1 screen)

The writer (`emitYaml`) and the schema check live in the CLI package. Parsing
always uses the repo's own vendored parser, loaded with
`import(<repo>/.shipline/bin/lib.mjs)`, because that is the code the hooks run.
Every repo has `parseYaml`, so this works on legacy repos too.

**Which files can be written.** Only `.shipline/config.yml`,
`.shipline/workflows/<id>.yml` and `.shipline/rules/<id>.md`, where `<id>`
matches `^[A-Za-z0-9_-]+$`. The server builds the path from the kind and the
id. A client-supplied path is never used. Any other target returns 400.

Save steps. The client sends `{ files: [...] }`. Each entry is
`{ kind: "config" | "workflow" | "rules", id?, model?, text?, baseHash }`:
`model` for YAML files, `text` for rules files.

1.  When a file is loaded, the server reads its text, records a SHA-256 of it,
    and parses it with the vendored `parseYaml` to get `diskModel`. A file
    that doesn't parse is sent to the browser read-only, with the parse error,
    and can't be edited until it is fixed by hand.
2.  The form edits a copy of `diskModel` in place. Keys the form doesn't know
    stay in the object, so they survive. Empty maps become `null` before
    emitting, because the parser reads `key:` with nothing nested as `null`.
3.  On save, **the server** runs the whole pipeline for every YAML entry. It
    never trusts the client's preview:
    1.  Run the schema check (below). Any error returns 400 with the list.
    2.  Emit text from the model (writer rules below).
    3.  Parse the emitted text with the vendored parser. It must deep-equal
        the model; if not, return 400 naming the first key that differs.
4.  Before writing anything, check every entry's `baseHash` against the file
    on disk. If any file changed, return 409 for the whole batch and write
    nothing. `baseHash: null` means the file must not exist yet. If it does
    exist, that also returns 409 (`exists`) for the whole batch, in this same
    step, before any file is written. New files are then created with the
    `wx` flag.
5.  Write each file atomically (temporary file in the same folder, then
    rename).
6.  After the write, the UI shows "Commit these files so teammates get the
    change".

`POST /api/setup/preview` runs steps 3.1–3.3 without writing. It returns the
emitted text, a diff against the file on disk, the comment lines that would
be removed, the errors, and the open-task impact list.

**Creating and deleting workflows.** A new workflow starts as a copy of an
existing one with a new id. The copy parses the source file, sets
`model.id` to the new id (the file's own `id:` decides what `stage.mjs start`
records, because `loadWorkflow` returns `{ id, ...wf }`), and goes through the
same validate, emit, re-parse and `baseHash: null` path as a save. A copy onto
an existing id returns 409 (`exists`). A workflow can be deleted only when no
open task uses it; otherwise 409 (`in-use`). Deleting leaves its rules files in
place, and the preview says so.

**Writer rules: comments and layout.**

*   **`config.yml` is written from a fixed layout.** The layout is the shipped
    `templates/shipline/config.yml`, including its comment lines and blank
    lines. The writer replaces each known key's value in that layout with the
    model's value (`artifact_root`, `folder_pattern`, `branch_pattern`,
    `tracker`, and each key under `commands`). When the model and the layout
    differ:
    *   A known key missing from the model drops its line, together with the
        comment block and blank line directly above it.
    *   `commands: null` (an empty map after the empty-map rule) is written as
        a bare `commands:` with no child lines.
    *   Unknown top-level keys go at the end of the file, after one blank line,
        in `diskModel` order. Unknown keys under `commands` go after the last
        command.
    *   Key order always follows the layout. If the team's file used a
        different order, the preview shows the lines as moved.
    *   A comment a team added to `config.yml` that isn't in the layout is
        shown as removed in the preview.

    Item 14 has a fixture for each of these cases.
*   **Workflow files keep only their header.** The header is the run of lines
    starting with `#` from line 1, plus one blank line after it if there is
    one. It is taken from the matching shipped template
    (`templates/shipline/workflows/<id>.yml`), or from `feature.yml` for a
    workflow with no template. Any other comment in a workflow file is shown
    as removed in the preview.

**Writer rules: values.**

*   Two-space indent. Keys follow the order of `diskModel`; new keys go after
    their siblings.
*   **Original quoting is kept.** `yaml-emit.mjs` also scans the text on disk
    with `rawScalars(text)`, which maps each scalar's path (stage lists are
    keyed by stage id, as in `stages[id=plan].blocks[0].tools`; other lists by
    index) to its raw text on disk. When a value at a path is unchanged, the
    writer reuses that raw text exactly, quotes included. The deep-equal check
    in step 3.3 still applies.
*   **New or changed values** are quoted only when the parser would otherwise
    read them as something else: empty, `true`, `false`, `null`, `~`, a
    number, starting with a quote, `[`, `-` or `#`, containing `: ` or ` #`, or
    having leading or trailing spaces. A string containing a backslash or a
    `|` (regexes) uses single quotes, with `'` doubled; this matches the setup
    skill's "single quotes around regexes". A string containing both `'` and
    ` #` uses double quotes instead, because the parser's comment stripper
    (`stripComment` in `lib.mjs`) misreads ` #` after a doubled `''`. Other
    quoted strings use double quotes with JSON escaping.
*   **Inline lists** (`[a, b]`) are used for lists of scalars. An item
    containing `,`, `[`, `]` or `'` is double-quoted. An item containing `"`
    is single-quoted instead, because `splitInline` in `lib.mjs` doesn't honour
    `\"`. A list with an item that contains both `"` and `,`, or both `'` and
    ` #`, is written as a block list (`- item` lines) instead of inline.
*   Lists of maps use `- key: value`. Empty lists are written as `[]`. `null` is
    written as `key:` with no value.
*   **Rejected values.** A string containing a newline or another control
    character can't be represented in the parser's subset. The schema check
    rejects it with "line breaks are not allowed here".

**Schema check, per file:**

| File | Field | Form control | Check |
| --- | --- | --- | --- |
| `config.yml` | `artifact_root` | text | relative path, no `..` |
| | `folder_pattern`, `branch_pattern` | text | must contain `{slug}`; only `{key}`, `{slug}`, `{type}` allowed |
| | `tracker` | read-only | n/a |
| | `commands.test/lint/build` | text | none |
| | unknown keys | listed read-only as "other fields (kept)" | kept as they are |
| `workflows/<id>.yml` | `id` | read-only | must equal the file name |
| | `name`, `description`, `branch_type` | text | `branch_type` matches `^[A-Za-z0-9_-]*$` |
| | `stages[].id` | text when the stage is new, then read-only | `^[A-Za-z0-9_-]+$`, unique in the workflow |
| | `stages[].name`, `artifact`, `description` | text | `artifact` is a file name, no `/` |
| | `stages[].optional`, `confirm_to_advance` | switch | boolean |
| | `stages[].condition` | select: none, `ui_only` | one of these |
| | `stages[].agent` | select from `.claude/agents/*.md` file names without `.md`, or none | exists, or a warning |
| | `stages[].enforcement` | select: `guide`, `warn`, `block` | one of these, never left to the silent fallback |
| | `stages[].blocks` | list editor: a "tools + allow paths" entry or a "bash regex" entry | `tools` and `bash` compile as `RegExp`; shows "has no effect under guide" |
| | unknown keys (top level or in a stage) | listed read-only as "other fields (kept)" | kept as they are |
| `rules/<id>.md` | whole file | plain-text editor | none |

Every text field also gets the line-break check above.

A stage id can't be renamed, because open manifests and `rules/<id>.md` refer
to it. A new stage creates `rules/<id>.md` only if the user types rules for it.
Deleting a stage leaves its rules file in place, and the preview says so.

**Open-task impact (warn, then save).** Before a workflow save that adds,
removes or reorders stages, the UI reads every unfinished manifest under
`artifact_root` whose `task.workflow` is this workflow. It lists how each one
differs from the new stage list, for example "LL-12: keeps old order; will not
get stage `security`". The save goes ahead after confirmation. The UI never
writes a manifest. Changes to settings (`enforcement`, `blocks`,
`confirm_to_advance`, `artifact`, rules) need no warning, because the hooks
read them on every call.

### Lost-task warning (Phase 0, in the vendored guard)

*   Today, `guard.mjs` exits silently when the session has no state file.
    Before exiting in that case, it now:
    1.  exits if `.shipline/.state/<session>.lost-warned` exists;
    2.  runs `git rev-parse --abbrev-ref HEAD`;
    3.  looks for an unfinished manifest whose `task.branch` equals the
        current branch.
*   On a match, it writes the `.lost-warned` marker and outputs a
    `systemMessage`: "Shipline: branch `<b>` belongs to unfinished task
    `<dir>`, but this session isn't tracking it, so its stage rules are not
    enforced. Run `node .shipline/bin/stage.mjs resume <dir>`." The call is
    still allowed.
*   When there's no match, no marker is written. So in a session with no task,
    every guarded call pays for one `git` call and one scan of the manifests.
    The author accepted this cost (see Risks).
*   Any error on this path ends with exit 0, so the warning itself never
    denies a call.
*   The scan logic moves from `session-start.mjs` into a shared
    `listOpenTasks(root, cfg)` in `lib.mjs`.

### Visible warn reminders (Phase 0, in the vendored guard)

*   Today, a call that matches a `warn` stage's `blocks` rule outputs only
    `hookSpecificOutput.additionalContext` ("Reminder: ..."), which Claude sees
    and the developer doesn't.
*   It now also outputs `systemMessage: "Shipline reminder: <msg>"`, which
    Claude Code shows to the developer. This changes terminal output for every
    repo on interface 2 whenever a warn rule is hit, which is what `warn` is
    for.
*   The UI shows that `systemMessage` as a "Shipline reminder" notice
    (Phase 2).

### Tasks panel (Phase 1)

*   **Data:**
    *   The UI's own copy of the open-task scan (`tasks.mjs`), used for every
        repo, so interface-1 repos need no fallback.
    *   The workflow file for stage names.
    *   A directory listing of each `task_dir` for artifacts.
    *   `git status --porcelain=v1 -z --untracked-files=all` for working-tree
        changes, labelled "Working tree changes".
*   **Updates:** the watcher copied from `watcher.ts`:
    *   It watches the repo root recursively, ignoring `.git`,
        `node_modules`, `dist` and `.shipline/.state`. Ignoring `.state`
        stops the UI's own log and lock writes from triggering it.
    *   It also watches the git directory found with
        `git rev-parse --git-dir`. This works for linked worktrees and
        submodules, where `.git` is a file. It watches directories, not
        `index` or `HEAD` as single files, because git replaces those files
        and a watch on a single file stops firing.
    *   A missing `artifact_root` is fine: the repo root watch sees it when it
        is created.
    *   300 ms after the last change, the data is recomputed once and an SSE
        `tasks` event is sent. Only one `git status` runs at a time; if
        something changes during a run, one more run follows.
    *   The copied `watchWorktree` swallows its own errors, so the copy is
        changed to report them. `watchRepo` returns `{ mode, close }` and
        switches to polling, with a banner, on a synchronous throw at startup
        or on any later `'error'` event (on Linux, running out of inotify
        watches arrives as an async `ENOSPC` error).
    *   Each poll, every 2 s, lists `artifact_root` and each `task_dir` (so it
        sees new task folders and artifacts), checks the git directory's
        `index` and `HEAD` mtimes, and re-runs `git status` every 10 s to catch
        working-tree edits. The diagnostics view shows the mode.
    *   On Linux, a recursive watch adds one inotify watch per subdirectory,
        including ignored ones such as `node_modules`, because the ignore list
        only filters events. This is listed in Risks, with polling as the
        fallback.
*   **State-file watch (Phase 2).** Because `.shipline/.state` is ignored by
    the repo watch, a separate non-recursive watch on the `.state/` directory,
    filtered to `<session id>.json`, picks up the file `stage.mjs start`
    creates. Watching the file itself would fail with `ENOENT` until it
    exists.
*   **Parsing `git status -z`.** Split on NUL. Each entry is `XY <path>`.
    After an `R` or `C` status code, the next token is the old path, stored as
    `oldPath`. Each change is `{ path, oldPath?, index, worktree }`.
*   Clicking an artifact opens its contents read-only, with markdown rendered.
    Clicking a changed file shows its diff with `--no-color`:
    `git diff HEAD -- <path>` for a tracked file, or
    `git diff --no-index /dev/null <path>` for an untracked file, where exit
    code 1 means "differs". In a repo with no commits yet, tracked files use
    `git diff --cached -- <path>`. Binary detection uses the patch text for
    tracked files and the copied `looksBinary` for untracked files.

### Chat with permission cards (Phase 2)

**Lock and session index** (in `.shipline/.state/ui/`, gitignored):

*   `sessions.json`: a list of
    `{ id, title, created, last_active, task_dir | null, status: "active" | "ended" }`.
    `id` is the `claude` session id.
*   `lock.json`: `{ pid, hostname, port, session_id }`, created with the `wx`
    flag, so only one writer wins.
    *   The lock is taken when a chat starts or continues, and released when it
        ends, crashes or the server shuts down.
    *   On `EEXIST`, if the hostname matches and the pid is not alive, the lock
        is stale: remove it and retry once. A lock file that doesn't parse
        (a crash between creating and writing it) counts as stale once it is
        more than 10 s old.
    *   If the lock's pid is this server's own pid, a chat is already active
        here: `POST /api/chats` returns 409 (`chat-active`) with that chat's
        id, and the UI switches to it.
    *   A live lock held by another process shows "A chat is active in another
        Shipline UI on port <p>; stop it there." There is no take-over.
    *   Terminal and extension sessions are not locked out. The UI says this
        once on the chat screen.
*   An ended chat is read-only. "Continue" makes it active again if the lock
    is free.

**Spawn.** The working directory is the repo root.

```text
claude -p
  --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages
  --session-id <uuid>            # new chat; the UI makes the uuid
  | --resume <uuid>              # existing chat; never --fork-session
  --mcp-config <state>/ui/mcp-<uuid>.json
  --permission-prompt-tool mcp__shipline_ui__approve
env: inherited + SHIPLINE_SESSION=<uuid>
```

Never passed: `--bare`, `--settings`, `--plugin-dir`, `--allowedTools`,
`--append-system-prompt`, `--strict-mcp-config`. The repo's committed
`.claude/settings.json`, hooks, agents and MCP servers apply as they do in the
terminal. Before every spawn, the UI checks that `claude --version` meets the
minimum version recorded by the chat test.

*   **Session id [test-dependent].** The UI makes the uuid and passes it with
    `--session-id`, then `--resume` with the same uuid. Item 19 question 1
    checks that `system/init` and the hooks report the same id. If they
    don't, the gate fails until this part is redesigned. No rebind code is
    built in advance.
*   **Hook environment [test-dependent].** The UI sets `SHIPLINE_SESSION=<uuid>`
    in `claude`'s environment, so `stage.mjs` finds the session whether or
    not `CLAUDE_ENV_FILE` works under `-p`. Item 19 question 2 records which
    of the two sources the Bash tool sees.
*   **Stream handling.**
    *   Each stdout line is parsed with the copied parser. Blank lines are
        skipped.
    *   A valid JSON line with an unknown `type` is logged and skipped.
    *   A line that is not valid JSON stops the session and shows CUJ 4's
        "continue in terminal".
    *   User messages are written to stdin as stream-json `user` messages,
        right away; the UI doesn't wait for `system/init`.
    *   While a turn is running (from a user message until its `result`
        event), the composer is disabled.
    *   `result` events update a cost and usage line under the chat.
    *   Usage-limit text is shown as a banner.
*   **Failures.**
    *   `claude` not found on `PATH`: the chat screen shows "Install Claude
        Code and sign in, then reload" instead of a composer.
    *   `claude` exits unexpectedly: the chat is marked ended, the lock is
        released, and the UI shows the exit code, the last 4 KB of stderr and
        `claude --resume <id>`.
    *   `--resume` fails (exits before `system/init`): the UI offers "Start a
        new chat". It doesn't retry on its own.
*   **History.** `GET /api/chats/<id>` reads Claude's own session file at
    `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<repo path with every
    non-alphanumeric character replaced by "-">/<id>.jsonl`, falling back to a
    scan of `projects/*/` for `<id>.jsonl`. This is copied from
    `transcript.ts`. Lines that fail to parse are skipped. If none parse, the
    UI shows "History unavailable for this Claude version; you can still
    continue the chat."
*   **Side panel.** The same component as the Tasks tab, filtered to the
    chat's task. The task is found from `.state/<session>.json` (`task_dir`),
    which `stage.mjs start` or `resume` writes, and stored in
    `sessions.json` once known.
*   **How notices are shown.**
    *   **Shipline block:** a tool result whose text matches the guard's deny
        reason. The exact text is captured by item 19 question 6. The prefix
        `Shipline (` is part of the interface, so changing it raises the
        interface number.
    *   **Shipline reminder:** a hook `systemMessage` starting with
        "Shipline reminder:".
    *   **Shipline notice:** any other hook `systemMessage`.
    *   **[test-dependent]** Whether hook `systemMessage` output appears in
        the `-p` stream-json output at all, and as which event type, is not
        known. Item 19 question 8 captures it. `hookSystemMessage(event)` in
        `stream.mjs` (item 48) is written from that capture. If the messages
        don't appear, reminders and notices are not shown in the chat, and
        the Risks table records it. The fail-open and lost-task banners
        depend on the same answer.
    *   **You denied:** a tool result for a call the developer denied on a
        card. It is matched by `tool_use_id`. When the prompt had no
        `tool_use_id`, it is matched to the most recent denied prompt for the
        same `tool_name`.

**Permission and question cards.**

```text
claude ──tools/call approve{tool_name,input,tool_use_id}──► relay.mjs (stdio)
relay.mjs ──POST /api/relay  X-Shipline-Relay: <secret>──► UI server
UI server ──SSE "prompt" {id, chatId, tool, input, expiresAt}──► browser card
browser ──POST /api/prompts/<id> {decision, answers?}──► UI server
UI server ──HTTP 200 {behavior, updatedInput | message}──► relay.mjs ──► claude
```

*   **`relay.mjs`** is a dependency-free MCP stdio server that `claude` starts.
    It speaks newline-delimited JSON-RPC 2.0:
    *   `initialize` returns `{ protocolVersion: <the client's>,
        capabilities: { tools: {} }, serverInfo: { name: "shipline_ui",
        version: <package version> } }`.
    *   `notifications/initialized` is ignored.
    *   `tools/list` returns one tool, `approve`, with input schema
        `{ tool_name: string, input: object, tool_use_id?: string }`.
    *   `tools/call` with `approve` POSTs the arguments to the UI and returns
        `{ content: [{ type: "text", text: JSON.stringify(answer) }] }`.
    *   An unknown method returns error `-32601`. A line that isn't valid JSON
        returns error `-32700`.
    *   If the UI can't be reached, the relay returns
        `{ behavior: "deny", message: "Shipline UI is not reachable" }`.
    *   It reads no repo files, and exits when its stdin closes.
*   **Waiting for the answer.** The relay uses `node:http.request` with
    `setTimeout(0)`, not `fetch`, because `fetch` stops waiting for response
    headers after 300 s. The UI server sets `requestTimeout = 0` and
    `timeout = 0`; on a loopback-only server this is harmless. Item 19
    question 5 checks that `claude` itself lets a permission-prompt call
    wait 10 minutes. The rule for the answer:
    *   If Claude's limit is 10 minutes or more, nothing changes.
    *   If `MCP_TOOL_TIMEOUT` raises the limit, item 49 adds
        `MCP_TOOL_TIMEOUT=660000` to `claude`'s environment.
    *   Otherwise the prompt timeout becomes the recorded limit minus 30 s.
        The design still works if that is at least 2 minutes; a shorter limit
        fails the gate.
*   **No policy in the relay.** The relay never reads stage state, workflow
    files or config. Hooks run before the permission prompt, so a `block`
    denial never reaches the relay.
*   **Secret and config.**
    *   The UI server makes a new 32-byte secret for each spawn.
    *   The config file `<state>/ui/mcp-<uuid>.json` (mode 0600) is
        `{ "mcpServers": { "shipline_ui": { "command": "<node path>",
        "args": ["<absolute path to relay.mjs>"], "env": {
        "SHIPLINE_UI_RELAY_URL": "http://127.0.0.1:<port>/api/relay",
        "SHIPLINE_UI_RELAY_SECRET": "<secret>" } } } }`.
    *   The secret is only in that file's `env`, which goes to the relay
        process. It isn't in `claude`'s own environment, so Bash commands
        don't inherit it.
    *   `/api/relay` is exempt from the cookie and `Origin` checks (see
        "Server, auth and browser launch"). It accepts only a request with no
        `Origin` header whose `X-Shipline-Relay` equals that secret, compared
        with a length check and then `timingSafeEqual`. It can only create
        prompts. Answering needs the browser cookie.
    *   If the repo's `.mcp.json` already defines `shipline_ui`, the chat
        refuses to start and says why.
*   **Answers.**
    *   Allow: `{ behavior: "allow", updatedInput: <input> }`.
    *   Deny: `{ behavior: "deny", message: "Denied by the developer in Shipline UI" }`.
    *   AskUserQuestion **[test-dependent]**: the card shows the questions as
        choices and returns `updatedInput: { ...input, answers: { [question
        text]: label } }`, with multi-select labels joined by `, `. This is
        the format v1 used. Item 19 question 3 confirms it works under `-p`.
    *   No "always allow" in this design. Teams use `.claude/settings.json`
        allow rules for that.
*   **Timeout and reconnect.**
    *   A pending prompt waits for `PROMPT_TIMEOUT_MS` (a named constant in
        `prompts.mjs`, 600 000 by default, adjusted by the rule above, and
        overridable with `SHIPLINE_UI_PROMPT_TIMEOUT_MS` for tests). Then it is
        denied with "No answer within <n> minutes", built from the constant.
    *   Pending prompts are kept in server memory and sent again on every SSE
        connect, so reloading the tab doesn't lose them.
    *   When a prompt is answered or times out, SSE `prompt-resolved` removes
        its card from every open tab.
    *   If the browser has no SSE connection when a prompt arrives, the
        terminal running `npx shipline ui` prints a one-line notice.
*   **Card volume.** Item 19 question 4 counts the cards one normal Feature
    task produces. A high count is a reason to stop at the gate and rethink,
    not a trigger for extra features.

**Stopping a chat.** `stop()` closes `claude`'s stdin, sends SIGTERM to its
process group, sends SIGKILL after 5 s if it is still running, denies any
pending prompts, then releases the lock.

### Diagnostics and logging (Phase 1, extended in Phase 2)

*   `.shipline/.state/ui.log` (gitignored; rotated at 1 MB, keeping one old
    file) records:
    *   start and exit
    *   version check result
    *   each save (file, hash before and after)
    *   each spawn: argv, `claude --version` and session id
    *   each permission prompt and its answer or timeout
    *   lock taken and released
    *   the last 4 KB of `claude` stderr on exit
*   Any key whose name contains `secret`, `token` or `cookie` is replaced with
    `"[redacted]"` before logging and in the diagnostics output.
*   A Diagnostics screen shows:
    *   UI and repo versions
    *   `claude` path, version and sign-in status
    *   repo root
    *   active session and lock owner
    *   watch or poll mode
    *   the last 50 log lines
*   Any `failOpen` `systemMessage` seen in the stream, and any lost-task
    warning, also becomes a banner that stays until dismissed.

### API surface (UI server)

Every error response is `{ "error": { "code": "<string>", "message": "<text>",
"details": <optional> } }` with a matching HTTP status.

Every response from a cookie-protected route can also be 401 (`no-session`),
403 (`bad-host`, `bad-origin`) or 413 (`too-large`), so those are not repeated
in each row.

| Method and path | Phase | Request | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/status` | 1 | none | `{ uiVersion, repoVersion, versionState, root }` | none |
| `GET /api/setup` | 1 | none | `{ config, workflows: [...], rules: [...], agents: [names] }`; each file is `{ kind, id?, model, raw, hash }` or `{ kind, id?, raw, parseError }` | none |
| `POST /api/setup/preview` | 1 | `{ files: [{ kind, id?, model?, text?, baseHash }] }` | `{ files: [{ kind, id?, text, diff, removedComments, errors }], impact: [...] }` | 400 `bad-target` |
| `POST /api/setup/save` | 1 | same as preview | `{ written: [{ kind, id?, hash }] }` | 400 `bad-target`, 400 `invalid` (with `details` = error list), 400 `round-trip` (first differing key), 409 `changed` (file changed on disk), 409 `exists` (`baseHash: null` on an existing file), 423 `repo-newer` |
| `POST /api/setup/workflows` | 1 | `{ action: "copy", from, id }` or `{ action: "delete", id }` | `{ ok: true }` | 400 `bad-target`, 409 `exists`, 409 `in-use`, 423 `repo-newer` |
| `GET /api/tasks` | 1 | none | `{ tasks, changes, configError? }` (shape in item 26) | none |
| `GET /api/file?path=&mode=content\|diff` | 1 | query | `{ path, content }` or `{ path, hunks }` or `{ path, binary: true }` | 404 `not-found`, 413 `too-large` |
| `GET /api/events` | 1 | none | SSE stream (events below) | none |
| `GET /api/diagnostics` | 1 | none | redacted diagnostics data | none |
| `GET /api/chats` | 2 | none | `{ chats: [sessions.json entries] }` | none |
| `POST /api/chats` | 2 | `{ message }` | `{ id }` | 409 `chat-active` (with `details.chatId`), 409 `lock-held` (with `details.heldBy`), 412 `claude-missing` / `claude-too-old` / `claude-signed-out`, 423 `repo-newer` |
| `GET /api/chats/<id>` | 2 | none | `{ chat, history }` or `{ chat, history: null, unavailable: true }` | 404 `not-found` |
| `POST /api/chats/<id>/message` | 2 | `{ text }` | `{ ok: true }` | 404 `not-found`, 409 `busy`, 409 `chat-ended` |
| `POST /api/chats/<id>/stop` | 2 | none | `{ ok: true }` | 404 `not-found` |
| `POST /api/chats/<id>/continue` | 2 | none | `{ ok: true }` | same as `POST /api/chats` |
| `POST /api/relay` | 2 | `{ tool_name, input, tool_use_id? }`; header `X-Shipline-Relay`; no cookie; must have **no** `Origin` | the answer `{ behavior, updatedInput \| message }`, sent when the developer answers or the timeout runs out | 403 `bad-origin` (any `Origin` header), 403 `bad-secret` |
| `POST /api/prompts/<id>` | 2 | `{ decision: "allow" \| "deny", answers? }` | `{ ok: true }` | 404 `not-found` (unknown or already resolved) |

SSE events:

| Event | Phase | Data |
| --- | --- | --- |
| `tasks` | 1 | the `GET /api/tasks` body |
| `banner` | 1 | `{ id, kind: "version" \| "fail-open" \| "lost-task" \| "usage-limit", text }` |
| `chat` | 2 | `{ chatId, kind: "event" \| "fatal" \| "ended", event?, reason?: "parse" \| "exit" \| "resume-failed", code?, stderrTail?, resumeCommand? }` |
| `prompt` | 2 | `{ id, chatId, tool, input, expiresAt }` |
| `prompt-resolved` | 2 | `{ id, outcome: "allow" \| "deny" \| "timeout" }` |

## Alternatives Considered

Decisions below marked "Rejected by author" were made by the author in the
design session of 2026-11-03, recorded in `concepts_brief.md` and in this
document's review history.

### Scope and shape

#### Alternative A: Setup screen and chat in one phase

*   **Pros**: One release gives a single surface for setup and daily work.
*   **Cons**: Rebuilds most of the `apps/local` runtime in one step. Rests on
    the unanswered `-p` question and an undocumented stream format. Puts the
    version, save, lock, relay and security work into one release.
*   **Reason for Rejection**: Rejected by author: if the `-p` answer or the
    chat test comes back badly, a single release would have built the setup
    screen and the chat together for nothing. Phasing lets Phases 0 and 1
    ship and be useful whatever the gate decides.

#### Alternative B: Setup screen only, with the chat as a separate concept

*   **Pros**: Small and consistent with v2. No Claude process to own. Can be
    validated alone.
*   **Cons**: Doesn't meet the goal of developers using a browser chat day to
    day. The chat's unknowns would be left until a later concept.
*   **Reason for Rejection**: Rejected by author: the chat shares the server,
    auth, Tasks panel and diagnostics with Phase 1. Designing it now keeps
    those parts shaped for it, and the gate still stops it if the evidence is
    bad.

#### Alternative C: A view across several repos with one machine-wide server

*   **Pros**: One place for all repos on a machine. Matches the projects-list
    idea.
*   **Cons**: Needs a registry outside any repo (for example
    `~/.shipline/projects.json`) and a long-running server on a fixed port,
    which is the per-machine service v2 removed.
*   **Reason for Rejection**: Rejected by author for now: one checkout per UI
    server. A projects list is a later phase.

#### Alternative D: Use `apps/local` and `apps/web` directly

*   **Pros**: Already handles many edge cases (resume fallback, transcripts,
    the Host check).
*   **Cons**: Brings back express, ws, node-pty with a postinstall step,
    Electron, React components tied to hub data types, Node 20 for every
    command, and the shared npm name. It would also block removing the hub.
*   **Reason for Rejection**: Rejected by author: the useful modules are copied
    into `packages/cli` as dependency-free `.mjs` (see Packaging), and the hub
    apps stay on track for removal.

#### Alternative E: A git worktree for each chat

*   **Pros**: A clean changed-files list for each chat. Several chats can run at
    once in one repo.
*   **Cons**: Each worktree needs its own dependency install and its own dev
    server ports. The developer's editor stays on the main checkout and doesn't
    see Claude's edits.
*   **Reason for Rejection**: Rejected by author for Phases 1–2: one active UI
    chat per checkout, with a lock. The session index is keyed by session id,
    not path, so worktrees can be added later.

### Packaging

#### Alternative F: Plain static page with no build step

*   **Pros**: No build and no dependencies. What is edited is what ships.
*   **Cons**: Everything the chat needs (markdown rendering, diff views,
    drag-to-reorder, card state) is hand-written DOM code. Nothing from the
    team's existing React stack is reused.
*   **Reason for Rejection**: Rejected by author: the chat's UI is large enough
    that hand-managed DOM code would become the main maintenance cost. The
    prebuilt bundle keeps the CLI free of runtime dependencies.

#### Alternative G: A separate UI package fetched on first use

*   **Pros**: `init` stays small. The UI can use any dependency.
*   **Cons**: Two packages to version, which makes the version-mismatch
    problem worse. The first run needs network access, and a corporate npm
    proxy may block the second package.
*   **Reason for Rejection**: Rejected by author: one package and one version
    for the CLI and UI.

#### Alternative H: WebSocket for live updates

*   **Pros**: One two-way connection.
*   **Cons**: Needs the `ws` dependency or a hand-written WebSocket frame
    parser. The browser only needs server-to-browser pushes; its own actions
    are ordinary POST requests.
*   **Reason for Rejection**: Not chosen while drafting, as a consequence of
    the zero-runtime-dependency CLI: Server-Sent Events over `node:http` cover
    the need with no dependency.

### Chat

#### Alternative I: PreToolUse hook relay for permissions

*   **Pros**: Uses only the hook mechanism v2 already relies on. No MCP.
*   **Cons**: Hooks fire on every matching call, not only calls that need
    permission. To avoid a card for every read, the hook would have to copy
    Claude's own rules for when to ask, which makes it a second policy engine.
    Hook timeouts cap how long a card can wait. Older repos don't have the
    hook.
*   **Reason for Rejection**: Rejected by author: `--permission-prompt-tool`
    receives exactly the prompts a human would see, so the relay needs no
    policy.

#### Alternative J: No relay; a fixed allowlist and terminal handoff

*   **Pros**: Least code. No MCP and no waiting.
*   **Cons**: Every unlisted Bash command stops the chat. `acceptEdits` mode
    accepts all edits automatically, which weakens safety compared with the
    terminal. Drops Goal 11.
*   **Reason for Rejection**: Rejected by author: normal tasks run varied shell
    commands, so developers would keep being sent back to the terminal.

#### Alternative K: A terminal-mode fallback inside the browser (node-pty)

*   **Pros**: If `-p` mode is disallowed or the stream format breaks, the
    unmodified interactive `claude` can still run inside the browser. v1 had
    this.
*   **Cons**: node-pty is a native dependency with a postinstall step, which
    the CLI package can't carry.
*   **Reason for Rejection**: Rejected by author: if `-p` is not allowed, the
    work stops after Phase 1 instead of adding a native dependency. When the
    stream format breaks, the fallback is the user's own terminal with
    `claude --resume <id>`.

#### Alternative L: The UI keeps its own chat log, with or without backfill

*   **Pros**: Depends only on the stream the UI already parses. Doesn't read
    Claude's private files (or does so only after a terminal handoff, in the
    backfill version).
*   **Cons**: Without backfill, turns made in the terminal after a handoff are
    missing. With backfill, there are two readers and a rule for joining them.
    The conversation is stored twice on disk.
*   **Reason for Rejection**: Rejected by author: one source of truth, which
    also covers turns made in the terminal. The minimum `claude` version check
    and the "history unavailable" notice handle format changes.

### Setup and enforcement

#### Alternative M: A writer that keeps all comments, or no comments at all

*   **Pros**: Keeping every comment makes the UI fully interchangeable with
    hand edits. Dropping all comments (with field documentation moved to a
    README) gives the simplest writer.
*   **Cons**: Keeping every comment in workflow files means moving comments
    with their stage on a reorder, and comments end up on the wrong stage when
    their position is unclear. Dropping all comments changes the v2 templates
    and removes the field reference teams read at the top of each file.
*   **Reason for Rejection**: Rejected by author: `config.yml` is written from
    the shipped template's layout, so its comments stay where they are.
    Workflow files keep their header, and any other comment is shown as
    removed in the preview. On 0.3.0 repos, workflow files contain only the
    shipped header, so nothing is lost there; a team's own additions to
    `config.yml` are shown as removed before saving.

#### Alternative N: Update open tasks, or refuse changes to stage structure

*   **Pros**: Updating pending stages makes structure changes reach every
    task. Refusing prevents any drift.
*   **Cons**: Updating means the UI writes committed manifests that a running
    session may also be writing, and that can cause merge conflicts. Refusing
    lets an abandoned task folder lock a workflow indefinitely.
*   **Reason for Rejection**: Rejected by author: `writeJson` in `lib.mjs` is
    last-write-wins, so a UI write to a manifest can silently undo a running
    session's `advance`. Warning and leaving manifests alone has no such race.

#### Alternative O: An upgrade command with strict refusal, or the repo's scripts as the only authority

*   **Pros**: An upgrade command gives every refusal a fix and lets repos get
    hook fixes. Treating the repo's scripts as the authority never blocks anyone
    and respects team edits to `bin/`.
*   **Cons**: An upgrade command brings back `shipline upgrade`, which v2 left
    out of scope, and forces teams that edited `bin/` to lose those edits or
    never upgrade. Treating the repo as the authority means the UI must handle
    many interface versions, and features may appear or disappear from repo to
    repo.
*   **Reason for Rejection**: Rejected by author: the common case is a UI newer
    than the repo, and old hooks ignore keys they don't know, so warning is
    enough there. Only a repo newer than the UI risks the UI writing something
    the repo's hooks read differently, so only that case refuses. The missing
    upgrade path is an open question.

#### Alternative P: Detect lost tasks by last-session record, or only in the UI, or once at session start

*   **Pros**: A last-session record doesn't depend on branch names. Detecting
    only in the UI needs no hook change. Checking once at session start costs
    nothing on later calls.
*   **Cons**: A last-session record warns about unrelated second sessions.
    Detecting only in the UI leaves terminal sessions with no help. Checking
    at session start misses a branch switch made later in the session.
*   **Reason for Rejection**: Rejected by author: the guard matches the git
    branch on each guarded call in sessions with no task, and warns once per
    session. It catches a branch switched to mid-session, at the cost recorded
    in Risks.

#### Alternative Q: Leave the Tasks panel until Phase 2

*   **Pros**: A smaller Phase 1. The panel could use the chat's own events
    instead of watching files.
*   **Cons**: Developers see nothing new day to day until Phase 2. If the gate
    before Phase 2 fails, the panel never ships, even though it doesn't depend
    on the chat.
*   **Reason for Rejection**: Rejected by author: the panel needs no Claude
    process, so it ships in Phase 1 and is used next to any Claude surface.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security and privacy.**
    *   The server listens only on `127.0.0.1`. The token is swapped for an
        HttpOnly, SameSite=Strict cookie named per port. The Host and Origin
        checks block other sites and DNS rebinding.
    *   The relay endpoint uses a separate secret for each spawn, rejects any
        request with an `Origin` header (so browser pages can't call it), and
        that secret can only create prompts.
    *   No Claude credentials are read, stored or forwarded.
    *   The UI reads `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`) only to
        load history for this repo's own chat session ids.
    *   Writes are limited to the allowlisted `.shipline/` files and the
        gitignored `.shipline/.state/`. File reads through `/api/file` are
        limited to task folders and changed files.
*   **Performance.**
    *   The Tasks panel updates within 1 s of a change, including the 300 ms
        wait after the last change (2 s when polling).
    *   In sessions with no task, the guard runs one `git` call and one
        manifest scan per guarded call (accepted; see Risks).
    *   Token cost: the UI adds no system prompt. Each chat carries one extra
        MCP tool definition (`approve`).
*   **Rollout and rollback.**
    *   Phase 0 ships in `shipline` 0.4.0 (interface 2), Phase 1 in 0.5.0 and
        Phase 2 in 0.6.0. The interface stays 2 after Phase 0.
    *   The UI writes only the allowlisted `.shipline/` files and the
        gitignored `.shipline/.state/`. Rolling back means not running
        `shipline ui`.
    *   The hooks never read `VERSION`. Deleting it only makes the UI treat
        the repo as legacy.

## Risks

| Risk | Impact | What is done about it |
| --- | --- | --- |
| The lost-task check runs `git` and a manifest scan on every guarded call in sessions with no task | Slower tool calls in those sessions, possibly beyond the v2 hook budget of about 100 ms in large repos | Accepted by the author, to catch branch switches during a session |
| `-p` use is not allowed | No browser chat | The work stops after Phase 1, which is useful alone |
| The stream-json format changes in a `claude` update | The chat breaks | Minimum version check; unparsable lines stop the chat cleanly with `claude --resume <id>` |
| Claude's session file format changes | No history for old chats | "History unavailable" notice; the chat can still continue |
| Repos initialized before Phase 0 can't get newer `bin/` files | No lost-task warning or visible reminders there | Accepted; information banner; upgrade path is an open question |
| The branch match warns a new session opened on a task's branch | A warning the developer may not expect | Accepted; the warning says how to resume, and that session isn't enforcing the task anyway |
| A team's own comments in `config.yml`, or interior comments in workflow files, are dropped on save | Lost notes | Shown as removed in the preview before the developer confirms |
| `claude` (running as the same OS user) can read the relay secret from `.shipline/.state/ui/` | Claude could create prompts | Accepted: the secret can only create prompts, and answering needs the browser cookie |
| A high permission-card count makes the chat tiresome | Developers go back to the terminal | Counted by the chat test; a high count is a reason to stop at the gate |
| On Linux, the recursive repo watch adds one inotify watch per subdirectory, including `node_modules` | Large repos can run out of inotify watches (`ENOSPC`) | The watcher switches to 2 s polling with a banner (item 27) |
| Hook `systemMessage` output may not appear in `-p` stream-json | No reminders, notices or fail-open and lost-task banners in the chat | Item 19 question 8 captures it; if absent, those are dropped from the chat (the terminal still shows them) |

## Additional Resources

*   `docs/plans/shipline-v2-repo-init.md`: the v2 plan this design extends.
*   `concepts_brief.md`: the brainstorm brief, with the risks and open
    questions it raised.
*   Review reports in the repo root (`consolidated_review_report.md` and the
    per-stage reports): the design review and how each finding was resolved.
    This design was drafted and reviewed with EGM, a design-review workflow
    that uses separate reviewers with no shared context.
*   Prior implementation copied from: see Packaging.
*   `apps/api/src/services/tool-decision.service.ts`: the v1 AskUserQuestion
    answer format.

## Future Improvements

*   **Draft with Claude.** A button on the rules editor that asks Claude to
    draft a stage's rules. Options considered: a fixed prompt sent into the
    chat, a committed skill, a one-shot read-only `claude -p` call, or a
    "Copy prompt" button. It was deferred because it ties the setup screen to
    the chat for little gain.
*   **Upgrade command.** A `shipline upgrade --bin-only` that brings newer
    `bin/` scripts to existing repos (see Open Questions).
*   **Projects list.** One UI across several repos on a machine.
*   **Worktrees.** More than one active chat per repo.
*   **Terminal sessions in the UI.** Listing and viewing sessions started
    outside the UI.
*   **New guardrail types.** Protected paths, banned commands and so on, once
    the UI exists to edit them.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Phases are built in order. Each phase ends with its own verification (see
Verification Plan). The chat test runs in parallel with Phase 0. Its code is
throwaway and lives outside the repo. Only its results document is committed.

Mechanical choices made here: tests use the built-in `node:test` runner (the
CLI has no test setup today and must stay dependency-free). The browser
package uses `@dnd-kit/sortable` for drag-to-reorder and `react-markdown` with
`remark-gfm` for rendering. shadcn/ui components are copied from
`apps/web/src/components/ui/`. CI is a new GitHub Actions workflow, because
the repo has none today.

Test layout: tests for Phase 0 (hook scripts, writer, schema, init) are
`packages/cli/test/*.test.mjs`. Tests for the UI server are
`packages/cli/test/ui/*.test.mjs`. Fixtures are under
`packages/cli/test/fixtures/`, which no test glob matches.

### Target Files to Create/Modify

#### Phase 0: groundwork

##### 1. `packages/cli/src/interface.mjs` (Create)

*   **Type / Scope**: Node module, no dependencies.
*   **Proposed Changes**:
    *   `export const INTERFACE = 2`.
    *   `readRepoVersion(root)` returns `{ package, interface }`, or
        `{ legacy: true, interface: 1 }` when `.shipline/bin/VERSION` is
        missing or unreadable.
    *   `compareInterface(repo, ui)` returns `'same' | 'repo-older' |
        'repo-newer'`.
    *   `MISSING_BEFORE`: a fixed list of what interface-1 repos lack
        (`["the lost-task warning", "visible warn reminders"]`), used only for
        the banner text.
*   **Why**: `init` and `ui` share one definition of the stamp and the
    comparison.

##### 2. `packages/cli/src/init.mjs` (Modify)

*   **Type / Scope**: CLI command.
*   **Proposed Changes**:
    *   Add `.shipline/bin/VERSION` to the list of files checked for
        collisions and to the dry-run listing.
    *   Write it last, after every template file and the settings and
        `CLAUDE.md` merges, as
        `{"package": <package.json version>, "interface": INTERFACE}` plus a
        newline. If an earlier write fails, `VERSION` is never written.
    *   Add one line to the success message: "Or set it up in the browser:
        `npx shipline ui`."
*   **Why**: Goal 1.

##### 3. `packages/cli/templates/shipline/bin/lib.mjs` (Modify)

*   **Type / Scope**: vendored hook library (Node 18, no dependencies).
*   **Proposed Changes**:
    *   Add `listOpenTasks(root, cfg)`, moved from the loop in
        `session-start.mjs`. It returns `[{ dir, slug, workflow, branch,
        done: [ids of stages with status done], next: id|null }]` for every
        task folder under `cfg.artifact_root` whose manifest has a stage that
        isn't done or skipped. Unreadable manifests are skipped.
    *   Add `currentBranch(root)`, which wraps
        `git rev-parse --abbrev-ref HEAD` and returns `''` on error.
*   **Why**: the guard and `session-start` need the same list of open tasks.

##### 4. `packages/cli/templates/shipline/bin/session-start.mjs` (Modify)

*   **Type / Scope**: vendored SessionStart hook.
*   **Proposed Changes**: replace the inline manifest loop and git call with
    `listOpenTasks` and `currentBranch`. Its output text stays the same.
*   **Why**: removes the duplicate logic. Item 18 checks the output is
    unchanged.

##### 5. `packages/cli/templates/shipline/bin/guard.mjs` (Modify)

*   **Type / Scope**: vendored PreToolUse hook.
*   **Proposed Changes**:
    *   **Lost-task warning.** On the path where `readSession` returns
        nothing (or no `task_dir`):
        1.  If `.state/<safeId(session_id)>.lost-warned` exists, exit 0.
            (`safeId` replaces characters outside `[A-Za-z0-9_-]` with `_`.)
        2.  Call `currentBranch(root)`. If it is empty, exit 0.
        3.  Find a task from `listOpenTasks` whose `branch` equals it. If
            none, exit 0.
        4.  Write the marker file. Output `{ systemMessage: "Shipline: branch
            <b> belongs to unfinished task <dir>, but this session isn't
            tracking it, so its stage rules are not enforced. Run: node
            .shipline/bin/stage.mjs resume <dir>" }` and exit 0.

        Any error on this path ends with exit 0.
    *   **Visible warn reminder.** In warn mode, the output becomes
        `{ systemMessage: "Shipline reminder: <msg>", hookSpecificOutput: {
        hookEventName: "PreToolUse", additionalContext: "Reminder: <msg>" } }`.
    *   The deny output (block mode) is unchanged. Its reason keeps the prefix
        `Shipline (`.
*   **Why**: Goals 2 and 3.

##### 6. `packages/cli/src/yaml-emit.mjs` (Create)

*   **Type / Scope**: Node module, no dependencies.
*   **Proposed Changes**:
    *   `rawScalars(text)` scans YAML text line by line, with the same line
        rules as `parseYaml`, and returns a map from scalar path to its raw
        text on disk. Stage-list entries are keyed by `id`; other lists by
        index.
    *   `emitWorkflow(model, { header, raw })` returns text: the header, then
        the model, following the value rules in the Technical Plan. It reuses
        `raw` text for unchanged values.
    *   `emitConfig(model, { layout, raw })` returns text: the `config.yml`
        layout with each known key's value replaced in place, unchanged values
        written from `raw`, and unknown keys added as described in the
        Technical Plan.
    *   Both turn empty maps into `null`, and write empty lists as `[]`.
*   **Why**: Goal 4. No YAML writer exists today.

##### 7. `packages/cli/src/setup-schema.mjs` (Create)

*   **Type / Scope**: Node module, no dependencies.
*   **Proposed Changes**:
    *   `validateConfig(model)` and `validateWorkflow(model, { id, agents,
        existingStageIds })` return `[{ path, message }]`. They apply every
        check in the schema table, plus the line-break check on every string.
    *   `KNOWN_FIELDS` lists the keys the form edits for each file type.
        Anything else is "other fields (kept)".
    *   `headerFor(workflowId)` returns the header (the run of `#` lines from
        line 1, plus the blank line that follows it, if there is one) of
        `templates/shipline/workflows/<id>.yml`, or of `feature.yml` when that
        template doesn't exist.
    *   `configLayout()` returns the text of `templates/shipline/config.yml`.
*   **Why**: Goals 4 and 5. The form and the save path share one validator.

##### 8. `packages/cli/package.json` (Modify)

*   **Type / Scope**: package manifest.
*   **Proposed Changes**:
    *   Version `0.4.0`.
    *   `scripts.test`: `node --test test/*.test.mjs test/ui/*.test.mjs` (the
        shell expands the globs; Node 20 doesn't expand `--test` globs
        itself).
    *   `scripts.test:hooks`: `node --test test/*.test.mjs` (Phase 0 tests
        only, for Node 18).
    *   `files`: add `ui-dist`. `engines.node` stays `>=18`; `ui` checks for
        Node 20 at runtime.
    *   (Phase 1 adds `prepack` and `check:ui`; Phase 1 sets version `0.5.0`,
        Phase 2 `0.6.0`.)
*   **Why**: release version and test entry points.

##### 9. `apps/local/package.json` (Modify)

*   **Type / Scope**: package manifest.
*   **Proposed Changes**: rename to `@shipline/local`, set `"private": true`,
    and remove the `bin` entry.
*   **Why**: two workspace packages named `shipline` make `pnpm --filter`
    ambiguous and let `apps/local` be published under the CLI's name (see
    Technical Plan, Renaming `apps/local`).

##### 10. `package.json` (root) (Modify)

*   **Type / Scope**: workspace scripts.
*   **Proposed Changes**:
    *   `dev:local` and `desktop` change `--filter shipline` to
        `--filter @shipline/local`.
    *   Add `test:cli`: `pnpm --filter ./packages/cli test`. (The root package
        is also named `shipline`, so filtering by name would match it too.)
    *   Add `build:ui`: `pnpm --filter @shipline/ui build`.
*   **Why**: follows the rename, and gives one command for each new check.

##### 11. `apps/local/src/server/cli.ts`, `apps/local/src/server/paths.ts`, `apps/local/scripts/copy-plugin.mjs` (Modify)

*   **Type / Scope**: comments and error strings.
*   **Proposed Changes**:
    *   `cli.ts` line 4 comment: `` `npx shipline`: the headless local
        service `` becomes `` `pnpm dev:local`: the headless local service ``.
    *   `paths.ts` line 15: `` Run `pnpm --filter shipline build`. `` becomes
        `` Run `pnpm --filter @shipline/local build`. ``.
    *   `copy-plugin.mjs` line 1 comment: `` for `npx shipline` and the desktop
        shell `` becomes `` for the headless service and the desktop shell ``.
*   **Why**: hub text must not point at the CLI's npm name.

##### 12. `apps/web/src/components/local/local-banner.tsx`, `apps/web/src/components/local/pairing-dialog.tsx`, `apps/web/src/pages/settings/components/local-service-card.tsx`, `apps/web/src/pages/projects/settings/components/local-folder-card.tsx` (Modify)

*   **Type / Scope**: UI strings.
*   **Proposed Changes**: replace each literal `npx shipline` with
    `pnpm dev:local`. There are four occurrences in the rendered text
    (`local-banner.tsx:27`, `pairing-dialog.tsx:44`,
    `local-service-card.tsx:26`, `local-folder-card.tsx:37`) and one in a
    comment (`pairing-dialog.tsx:16`).
*   **Why**: same as item 11.

##### 13. `packages/cli/test/yaml-emit.test.mjs` (Create)

*   **Type / Scope**: unit and property tests.
*   **Proposed Changes**:
    *   For every file in `templates/shipline/**/*.yml` and every file in
        `test/fixtures/yaml/`: parse with the template `parseYaml`, emit with
        the original text as `raw` (and the layout for config), parse again,
        and deep-equal.
    *   **Templates unchanged:** emitting a shipped template with no edits
        gives exactly its bytes on disk. This includes `config.yml`'s
        comments and the quote styles in `feature.yml` and `bugfix.yml`.
    *   Table tests for each quoting case for new values: `""`, `"true"`,
        `"12"`, `"a: b"`, `"x #y"`, a leading `-`, leading or trailing spaces,
        a regex with `\b`, `|` and `'`, and inline-list items with `,`, `]`
        and quotes.
    *   Table tests for the parser-specific cases: an inline-list item with
        `"` (single-quoted), `it's #x|y` (double-quoted), and a list item with
        both `"` and `,` (written as a block list).
    *   A string with a newline is rejected by the schema, not emitted.
    *   A generated-input test: 500 random models must round-trip. The
        generator: keys from `[a-z_]{1,8}`; values are the table strings,
        booleans, integers, non-empty maps, lists of scalars, and lists of
        non-empty maps; no nested lists. `{}` is normalized to `null` on both
        sides before comparing.
*   **Why**: Goal 4.

##### 14. `packages/cli/test/fixtures/yaml/` (Create)

*   **Type / Scope**: test fixtures.
*   **Proposed Changes**: hand-edited workflows and configs:
    *   an extra unknown key at the top level and inside a stage
    *   a stage with both kinds of `blocks`
    *   `condition: ui_only`
    *   a custom `branch_type`
    *   inline comments inside a workflow (expected to be reported as removed)
    *   a team comment added to `config.yml` (expected to be reported as
        removed)
    *   a quoted numeric artifact name
    *   an empty `commands` map (expected output: a bare `commands:`)
    *   a `config.yml` missing `tracker` (expected: its line and the comment
        above it are dropped)
    *   a `config.yml` with keys in a different order (expected: layout
        order, shown as moved)
    *   a `config.yml` with an unknown top-level key (expected: at the end,
        after one blank line)
*   **Why**: covers what teams write by hand, not only what the templates
    contain.

##### 15. `packages/cli/test/setup-schema.test.mjs` (Create)

*   **Type / Scope**: unit tests.
*   **Proposed Changes**: one failing case for each check in the schema table
    (bad enforcement, duplicate or invalid stage id, an `id` that doesn't match
    the file name, `/` in an artifact, a pattern without `{slug}`, a regex that
    doesn't compile, a line break, an unknown agent giving a warning), plus a
    passing case for each template.
*   **Why**: Goals 4 and 5.

##### 16. `packages/cli/test/guard-lost-task.test.mjs` (Create)

*   **Type / Scope**: integration test with a temporary git repo.
*   **Proposed Changes**:
    *   Run `init` into a temporary repo with one commit. Create a task with
        `stage.mjs start --session s1`, then run `git switch -c <task.branch>`
        (`stage.mjs` only suggests the branch; it doesn't create it).
    *   Call `guard.mjs` with stdin JSON for session `s2` (no state file) and
        an Edit on a source file. Expect the lost-task `systemMessage` the
        first time and nothing the second time.
    *   On a branch that no task uses, expect nothing.
    *   For session `s1` (which has a task), expect no lost-task warning.
    *   With the task in a `warn` stage whose `blocks` match the call, expect
        both `systemMessage` ("Shipline reminder: ...") and
        `additionalContext`.
    *   In a `block` stage, expect the deny output unchanged, with reason
        prefix `Shipline (`.
*   **Why**: Goals 2 and 3.

##### 17. `packages/cli/test/init-version.test.mjs` (Create)

*   **Type / Scope**: integration test.
*   **Proposed Changes**: `init` writes `VERSION` with the package version and
    `INTERFACE`. `--dry-run` lists it. An existing `VERSION` file counts as a
    collision. `readRepoVersion` reports legacy when the file is deleted.
*   **Why**: Goal 1.

##### 18. `packages/cli/test/session-start.test.mjs` (Create)

*   **Type / Scope**: snapshot test.
*   **Proposed Changes**: the hook's `additionalContext` for a fixture repo
    with two open tasks is byte-equal before and after item 4's refactor.
*   **Why**: the refactor must not change Claude's resume prompt.

##### 19. `.claude/plans/shipline-local-ui-test-results.md` (Create)

*   **Type / Scope**: results document from the parallel chat test.
*   **Proposed Changes**: record the exact `claude` version tested, which
    becomes the minimum version. Each question has its answer type:
    1.  **Yes/no:** do `--session-id <uuid>` and later `--resume <uuid>` report
        the same `session_id` in `system/init` and in the hooks' stdin?
    2.  **Yes/no, two parts:** do hooks under `-p` get `CLAUDE_ENV_FILE`? In a
        Bash tool command, does `SHIPLINE_SESSION` equal the uuid, from the
        UI-set environment, from the env file, or both?
    3.  **Yes/no:** does AskUserQuestion go through
        `--permission-prompt-tool` under `-p`, and does
        `updatedInput.answers` (format in the Technical Plan) answer it?
    4.  **Count:** how many permission prompts does one Feature task in a
        sample repo produce with default settings?
    5.  **Yes/no:** does a permission-prompt call that waits 10 minutes still
        succeed? If no, record the limit and whether `MCP_TOOL_TIMEOUT` in
        `claude`'s environment raises it.
    6.  **Captured text:** the exact tool-result text Claude receives when the
        guard denies a call in block mode.
    7.  **Written answer:** the `-p` question (who was asked or which terms
        were read, and the answer: allowed or not allowed).
    8.  **Captured events:** the stream-json events, if any, that carry a
        hook `systemMessage` under `-p`, for a warn reminder and for
        `failOpen`. Commit them as `packages/cli/test/fixtures/streams/*.jsonl`.
        Consequence: if none appear, chat reminders, notices and the
        fail-open and lost-task banners are dropped from the chat, and the
        Risks table records it. This does not fail the gate.

    The gate passes when 7 is "allowed", 1 and 3 are yes, 5 is yes or records
    a limit of at least 2 minutes (see "Waiting for the answer"), 2 shows the
    uuid is visible from at least one source, and the author has reviewed 4,
    6 and 8. The gate also
    needs the written "why not Claude's own GUIs" answer and the Phase 1
    dogfood signal (Open Questions).
*   **Why**: the gate before Phase 2. The test code stays in a scratch
    directory outside the repo.

#### Phase 1: server, setup screen, Tasks panel

##### 20. `packages/cli/bin/shipline.mjs` (Modify)

*   **Type / Scope**: CLI entry.
*   **Proposed Changes**:
    *   Add the `ui` command. It checks for Node 20 or later (exit 1 with a
        message otherwise), then loads `../src/ui/server.mjs` with
        `await import()` (never a static import, so `init` on Node 18 never
        loads Node-20-only code), calls `parseUiArgs(rest)` and starts the
        server. `init` keeps its own argument handling.
    *   Add `ui [dir] [--port <n>] [--no-open]` to `HELP`.
*   **Why**: the entry point.

##### 21. `packages/cli/src/ui/server.mjs` (Create)

*   **Type / Scope**: HTTP server.
*   **Proposed Changes**:
    *   `parseUiArgs(argv)` returns `{ dir, port, open }` per the grammar in
        the Technical Plan. A missing, non-numeric or out-of-range (not
        0–65535) `--port` value exits 1 with a message.
    *   `startServer({ dir, port, open })` resolves the repo (item 23),
        calls `listen` on `127.0.0.1`, and only then creates the auth state
        with `createAuth(server.address().port)` (item 22). `EADDRINUSE`
        prints "Port <n> is in use" and exits 1. It sets
        `requestTimeout = 0` and `timeout = 0`.
    *   Request bodies are read with a 1 MB cap; over that returns 413
        (`too-large`).
    *   Routes `/api/*` to handler modules by method and path, per the API
        table, and wraps every handler so thrown errors become the error
        envelope.
    *   Serves `ui-dist/` with `Content-Type` from a fixed extension map
        (`.html`, `.js`, `.css`, `.svg`, `.png`, `.woff2`, `.json`),
        `index.html` as the fallback for unknown non-`/api` paths, and
        `Cache-Control: no-store` for `index.html`.
    *   Installs one `shutdown()` for SIGINT, SIGTERM, `uncaughtException`
        and `unhandledRejection`. It awaits each module's `close()` in reverse
        start order, catching each one's errors, with an overall limit of 7 s,
        then calls `process.exit`.
    *   Prints the URL. Calls `open-browser.mjs` unless `--no-open`.
*   **Why**: Goals 7 and 10.

##### 22. `packages/cli/src/ui/auth.mjs` (Create)

*   **Type / Scope**: request checks.
*   **Proposed Changes**:
    *   `createAuth(port)` makes a 32-byte hex token. It is called after
        `listen`, with the real port.
    *   `check(req, route)` applies the rules in the Technical Plan:
        *   Host: `127.0.0.1:<port>` only, otherwise 403 (`bad-host`).
        *   Cookie: required except on `/?t=`, static files and
            `/api/relay`; missing or wrong gives 401 (`no-session`).
        *   Origin: every POST except `/api/relay` needs the server's own
            origin or the dev origin; missing or foreign gives 403
            (`bad-origin`).
        *   `/api/relay`: any `Origin` header gives 403 (`bad-origin`), and a
            missing or wrong `X-Shipline-Relay` gives 403 (`bad-secret`). The
            secret is checked by `prompts.mjs` (item 54) against the current
            spawn's secret.
    *   `safeEqual(a, b)` returns false when the byte lengths differ and
        otherwise calls `crypto.timingSafeEqual`, as
        `apps/local/src/server/pairing.ts` does. Every cookie and secret
        comparison uses it, so a value of the wrong length gives 401 or 403,
        not a 500.
    *   A `/?t=` with a wrong token gives 403 (`bad-token`).
    *   `exchange(req, res)` handles `/?t=` by setting `shipline_ui_<port>`
        and sending a 302 to `/`.
    *   `devOrigin`: read from `SHIPLINE_UI_DEV_ORIGIN`.
*   **Why**: Goal 7.

##### 23. `packages/cli/src/ui/repo.mjs` (Create)

*   **Type / Scope**: repo access.
*   **Proposed Changes**:
    *   `resolveRepo(dir)` walks up from `dir` to the first folder with
        `.shipline/config.yml`, ignoring `CLAUDE_PROJECT_DIR`. It returns
        `{ root, lib, version, state, getConfig, reloadConfig }`.
        *   `lib` is `await import(pathToFileURL(<root>/.shipline/bin/lib.mjs))`
            and is used only for `parseYaml` and `loadConfig`.
        *   `state` is the result of `compareInterface`.
        *   `getConfig()` returns `{ cfg }`, or `{ cfg: null, error }` when
            `config.yml` doesn't parse; a parse error never stops the server.
            `reloadConfig()` re-reads it. Item 24 calls it after every config
            save, and item 27 calls it on every watch event that touches
            `config.yml`. Item 27 restarts its watch when `artifact_root`
            changes.
    *   `requireWritable()` throws 423 (`repo-newer`) when `state` is
        `'repo-newer'`.
*   **Why**: the version contract. Parsing always uses the repo's own parser.

##### 24. `packages/cli/src/ui/setup.mjs` (Create)

*   **Type / Scope**: setup API handlers.
*   **Proposed Changes**:
    *   `targetPath(kind, id)` builds the only paths that can be written
        (`config.yml`, `workflows/<id>.yml`, `rules/<id>.md`) after checking
        `id` against `^[A-Za-z0-9_-]+$`. Anything else throws a 400.
    *   `GET /api/setup` reads `config.yml`, `workflows/*.yml`, `rules/*.md`
        and the agent names. It returns, per file, either the parsed model, raw
        text and SHA-256 hash, or the raw text and the parse error.
    *   `POST /api/setup/preview` and `POST /api/setup/save` take `{ files }`
        and run the save steps in the Technical Plan on the server. They use
        items 6 and 7, re-parse with the repo `lib`, and compute the diff with
        item 25. Save calls `requireWritable`, then checks every hash before
        writing (step 4). In that same step, an entry with `baseHash: null`
        whose file already exists returns 409 (`exists`) for the whole batch,
        before any write. It then creates new files with `wx`, and logs the
        hashes before and after. After a config save it calls
        `reloadConfig()`.
    *   `POST /api/setup/workflows` copies a workflow to a new id or deletes
        one. A copy parses the source, sets `model.id` to the new id, and goes
        through the same validate, emit, re-parse and `baseHash: null` path as
        a save. A copy onto an existing id returns 409 (`exists`). A delete
        while any open task uses the workflow returns 409 (`in-use`).
    *   `impact` (workflow files only) compares each open task's stage id list
        with the new one. It returns `[{ task, added: [ids], removed: [ids],
        reordered: bool }]` for tasks whose `task.workflow` is this workflow.
    *   Rules files go through the same path, hash and atomic-write rules.
*   **Why**: Goals 4, 5 and 6.

##### 25. `packages/cli/src/ui/git.mjs` (Create)

*   **Type / Scope**: Node module, copied from `apps/local/src/server/git.ts`
    and `apps/local/src/server/diff.ts`, plus `parseUnifiedDiff` from
    `packages/shared/src/local.ts`.
*   **Proposed Changes**:
    *   `gitRun(cwd, args, okCodes)`, `git(cwd, args)` and `gitOk(cwd, args)`
        as in `git.ts`.
    *   `fileDiff(root, change)` runs `git diff --no-color HEAD -- <path>`
        for a tracked file (`git diff --no-color --cached -- <path>` in a repo
        with no commits), or `git diff --no-color --no-index -- /dev/null
        <path>` with `okCodes [0, 1]` for an untracked file. Binary detection
        uses the patch text for tracked files and `looksBinary` (copied from
        `diff.ts`) for untracked files; binary files return
        `{ binary: true }`. A deleted file's diff works, because it doesn't
        need the file on disk.
    *   `textDiff(a, b)` writes `a` and `b` to two files in
        `.shipline/.state/ui/tmp/`, runs
        `git diff --no-index --no-color -U3 -- <a> <b>` with `okCodes [0, 1]`,
        deletes the files, and returns the parsed hunks. Removed lines whose
        trimmed text starts with `#` are marked as comments.
    *   `parseUnifiedDiff(patch)` copied as is.
*   **Why**: diffs for the save preview and the Tasks panel, reusing tested
    code.

##### 26. `packages/cli/src/ui/tasks.mjs` (Create)

*   **Type / Scope**: Tasks API.
*   **Proposed Changes**:
    *   `listOpenTasks(root, cfg)`: the UI's own copy of the scan, the same as
        item 3's, used for every repo regardless of interface.
    *   `GET /api/tasks` returns `{ tasks, changes, configError? }`:
        *   `tasks`: `[{ dir, slug, title, workflow, branch, stages: [{ id,
            name, status, reason?, artifact }], files: [{ name, size, mtime }]
            }]`. Stage status and reasons come from each manifest's `stages`;
            names come from the workflow file.
        *   `changes`: `git status --porcelain=v1 -z --untracked-files=all`
            parsed per the Technical Plan to `[{ path, oldPath?, index,
            worktree }]`.
        *   `configError`: set when `config.yml` doesn't parse; `tasks` is
            then empty.
    *   `GET /api/file?path=&mode=content|diff` accepts only a path inside an
        open task's folder or listed in the current `git status`. A path that
        exists is resolved with `resolveInsideWorktree` (copied from
        `apps/local/src/server/assets.ts`), which uses `realpath`. A deleted
        path skips `realpath` and is checked with `path.relative` against the
        status list. Any refused path returns 404 (`not-found`),
        `AssetError` included. `content` over 1 MB returns 413
        (`too-large`). `diff` returns `fileDiff` (item 25).
*   **Why**: the Tasks panel (CUJ 2).

##### 27. `packages/cli/src/ui/watch.mjs` (Create)

*   **Type / Scope**: file watching, copied from
    `apps/local/src/server/watcher.ts` (`watchWorktree`).
*   **Proposed Changes**:
    *   `watchRepo(root, onChange)` applies the rules in the Technical Plan:
        a recursive watch of the repo root (ignoring `.git`, `node_modules`,
        `dist` and `.shipline/.state`), and a watch of the directory from
        `git rev-parse --git-dir`. `onChange` is called 300 ms after the last
        event.
    *   `onChange` calls a single-flight `refresh()`: if a refresh is running,
        it marks one more to run afterward. An event on `.shipline/config.yml`
        also calls `reloadConfig()` (item 23); a changed `artifact_root`
        restarts the watch.
    *   The copied `watchWorktree` swallows startup throws and `'error'`
        events. The copy instead passes them to `watchRepo`, which returns
        `{ mode, close }` and switches to polling, with a banner, on a startup
        throw or any later `'error'` event (for example `ENOSPC` on Linux).
    *   Polling, every 2 s: list `artifact_root` and each `task_dir`, stat each
        manifest and the git directory's `index` and `HEAD`, and every 10 s
        re-run `git status`. It reports `mode: 'poll'`.
    *   `watchState(root, sessionId, onBound)` (Phase 2) watches the
        `.shipline/.state/` directory non-recursively and calls `onBound`
        when `<sessionId>.json` appears or changes.
    *   `close()` stops all watches and timers.
*   **Why**: the Tasks panel updates without a reload.

##### 28. `packages/cli/src/ui/sse.mjs` (Create)

*   **Type / Scope**: server-sent events.
*   **Proposed Changes**:
    *   `createHub()` with `connect(req, res)` (headers, a 15 s heartbeat
        comment, close handling) and `send(type, data)`, using the event
        shapes in the Technical Plan.
    *   `onConnect(fn)` lets modules re-send state, such as banners and
        pending prompts, to a new connection.
*   **Why**: live updates, and re-delivering prompts after a reload.

##### 29. `packages/cli/src/ui/log.mjs` (Create)

*   **Type / Scope**: logging.
*   **Proposed Changes**:
    *   `log(event, data)` appends JSON lines to `.shipline/.state/ui.log`.
    *   At 1 MB it renames the file to `ui.log.1`, replacing any older one.
    *   `redact(obj)` replaces the value of any key whose name contains
        `secret`, `token` or `cookie` (case-insensitive) with `"[redacted]"`.
        It runs on every log entry and on the diagnostics output.
    *   `tail(n)` returns the last n lines for diagnostics.
*   **Why**: a trace for debugging saves, spawns and prompts.

##### 30. `packages/cli/src/ui/diagnostics.mjs` (Create)

*   **Type / Scope**: diagnostics API.
*   **Proposed Changes**: `GET /api/status` and `GET /api/diagnostics` return
    UI and repo versions, the version state, root, watch mode, and the
    redacted log tail. From Phase 2 they also return the `claude` path,
    version, sign-in status, and the active session and lock.
*   **Why**: the Diagnostics screen and the version banner.

##### 31. `packages/cli/src/ui/open-browser.mjs` (Create)

*   **Type / Scope**: Node module.
*   **Proposed Changes**: runs `open` on macOS or `xdg-open` on Linux, detached
    and with stdio ignored. Failure, or any other platform, prints "Open <url>
    in your browser".
*   **Why**: `npx shipline ui` opens the page.

##### 32. `packages/cli/scripts/build-ui.mjs` (Create)

*   **Type / Scope**: build script, run by `prepack`.
*   **Proposed Changes**: runs `pnpm --filter @shipline/ui build` with
    `SHIPLINE_UI_OUT` set to the absolute path of `packages/cli/ui-dist`
    (built from the script's own location, because pnpm runs the build with
    `packages/ui` as the working directory), then runs `check-ui.mjs`.
*   **Why**: the published bundle is rebuilt on every pack.

##### 33. `packages/cli/scripts/check-ui.mjs` (Create)

*   **Type / Scope**: build check.
*   **Proposed Changes**: walks `ui-dist/` recursively (Vite writes JS and
    CSS under `ui-dist/assets/`), gzips each `.js` and `.css` file in memory
    and adds up the sizes. It exits 1 if the total is over 400 KB or
    if `ui-dist/index.html` is missing.
*   **Why**: the size budget.

##### 34. `packages/cli/package.json` (Modify, Phase 1 part)

*   **Type / Scope**: package manifest.
*   **Proposed Changes**: version `0.5.0`. `scripts.prepack`:
    `node scripts/build-ui.mjs`. `scripts.check:ui`:
    `node scripts/check-ui.mjs`.
*   **Why**: wires items 32 and 33.

##### 35. `.gitignore` (Modify)

*   **Type / Scope**: repo config.
*   **Proposed Changes**: add `packages/cli/ui-dist`.
*   **Why**: build output is never committed.

##### 36. `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vite.config.ts`, `packages/ui/index.html` (Create)

*   **Type / Scope**: new private workspace package.
*   **Proposed Changes**:
    *   Name `@shipline/ui`, `"private": true`.
    *   Dependencies, at the versions in `apps/web/package.json`: `react`,
        `react-dom`, `@tanstack/react-query`, `react-markdown`, `remark-gfm`,
        and what the copied components (item 39) import: `radix-ui` (one
        package), `class-variance-authority`, `cn` (the components import
        `cn` from this npm package; there is no `lib/utils.ts`),
        `lucide-react`, `sonner`, `next-themes` (used by `sonner.tsx`). The
        `index.css` imports need `tw-animate-css`, `shadcn`,
        `@fontsource-variable/inter` and `@tailwindcss/typography`. New:
        `@dnd-kit/core`, `@dnd-kit/sortable`.
    *   Dev dependencies, same versions as `apps/web`: `vite`,
        `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`,
        `typescript`, `@types/react`, `@types/react-dom`, `@types/node`.
    *   `tsconfig.json` and `vite.config.ts` define the `@` alias to `src/`, as
        `apps/web` does. `vite.config.ts` sets `build.emptyOutDir: true`,
        because Vite doesn't empty an output folder outside its own root
        otherwise, and stale bundles would be published.
    *   Scripts:
        *   `dev:ui` (not `dev`, because the root `pnpm dev` runs `turbo dev`
            on every package that has a `dev` script): Vite, with `/api` and
            `/?t=` proxied to `SHIPLINE_UI_URL` using `changeOrigin: true`.
        *   `build`: output directory from `SHIPLINE_UI_OUT` (an absolute
            path; see item 32), defaulting to `../cli/ui-dist`.
        *   `typecheck`.
*   **Why**: the chosen packaging (prebuilt bundle).

##### 37. `packages/ui/src/main.tsx`, `packages/ui/src/app.tsx`, `packages/ui/src/index.css` (Create)

*   **Type / Scope**: React app shell.
*   **Proposed Changes**:
    *   A query client, and a `next-themes` `ThemeProvider` (attribute
        `class`, default `system`), because the copied `sonner.tsx` calls
        `useTheme`.
    *   A tab layout: Setup, Tasks, Chat (from Phase 2), Diagnostics.
    *   A banner area at the top, fed by `/api/status` and SSE `banner`
        events.
    *   `index.css` copies `apps/web/src/index.css` whole, including its
        imports (`tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`,
        `@fontsource-variable/inter`, the `@tailwindcss/typography` plugin)
        and its theme variables.
*   **Why**: the frame for every screen.

##### 38. `packages/ui/src/lib/api.ts`, `packages/ui/src/lib/events.ts`, `packages/ui/src/lib/types.ts` (Create)

*   **Type / Scope**: client data layer.
*   **Proposed Changes**:
    *   Typed fetch helpers for each endpoint (`credentials: 'same-origin'`).
        They raise the error envelope as a typed error.
    *   An `EventSource` wrapper that reconnects with backoff and routes
        `tasks`, `banner`, `chat`, `prompt` and `prompt-resolved` events into
        the query cache.
    *   Types matching the API responses and SSE events.
*   **Why**: one data path for all screens.

##### 39. `packages/ui/src/components/ui/*` (Create)

*   **Type / Scope**: copied components.
*   **Proposed Changes**: copy these from `apps/web/src/components/ui/`,
    unchanged except for import paths: `button`, `card`, `dialog`, `input`,
    `label`, `select`, `switch`, `tabs`, `textarea`, `badge`, `alert`,
    `scroll-area`, `separator`, `tooltip`, `sonner`, `collapsible`,
    `checkbox`, `radio-group`. They import `cn` from the `cn` package, so no
    utils file is copied. The copies use double quotes and no semicolons,
    while the repo `.prettierrc` sets `singleQuote` and `semi`, so each copy
    is run through `prettier --write` once when it is copied (chosen over a
    `.prettierignore` entry so the CI check covers every file).
*   **Why**: the team's existing component patterns, with no dependency on
    `apps/web`.

##### 40. `packages/ui/src/components/diff-view.tsx`, `packages/ui/src/components/markdown.tsx`, `packages/ui/src/components/banners.tsx` (Create)

*   **Type / Scope**: shared components.
*   **Proposed Changes**:
    *   A diff view that renders parsed hunks (item 25), with removed comment
        lines highlighted.
    *   A markdown component (react-markdown and remark-gfm, with raw HTML
        disabled).
    *   Banners:
        *   version (repo older, with the list of what the repo lacks; repo
            newer, with the command)
        *   fail-open
        *   lost-task
        *   usage limit
*   **Why**: used across Setup, Tasks and Chat.

##### 41. `packages/ui/src/pages/setup/setup-page.tsx`, `packages/ui/src/pages/setup/config-form.tsx`, `packages/ui/src/pages/setup/workflow-editor.tsx`, `packages/ui/src/pages/setup/stage-list.tsx`, `packages/ui/src/pages/setup/stage-editor.tsx`, `packages/ui/src/pages/setup/blocks-editor.tsx`, `packages/ui/src/pages/setup/other-fields.tsx`, `packages/ui/src/pages/setup/rules-editor.tsx`, `packages/ui/src/pages/setup/save-dialog.tsx` (Create)

*   **Type / Scope**: Setup screen.
*   **Proposed Changes**:
    *   A form for each field in the schema table.
    *   Stage list with drag-to-reorder; the id is editable only for unsaved
        new stages.
    *   Copy and delete for workflows (`/api/setup/workflows`).
    *   Blocks editor with two entry types.
    *   A read-only "other fields (kept)" list.
    *   A plain-text rules editor per stage.
    *   Files that don't parse are shown read-only with their error.
    *   A live YAML preview from `/api/setup/preview`, sent 300 ms after the
        last edit.
    *   The save dialog shows the diff, the removed comments, the impact list
        and the errors. "Save" is disabled while there are errors or the repo
        is newer. All changed files are sent in one save.
    *   After a save, a toast says "Commit these files so teammates get the
        change".
*   **Why**: Goals 4, 5 and 6, and CUJ 1.

##### 42. `packages/ui/src/pages/tasks/tasks-page.tsx`, `packages/ui/src/components/task-panel.tsx`, `packages/ui/src/components/file-viewer.tsx` (Create)

*   **Type / Scope**: Tasks screen, and the panel that the chat reuses.
*   **Proposed Changes**:
    *   `task-panel` takes a task and renders its stages with status icons
        (done, skipped with reason, in progress, pending), the artifact list,
        and the working-tree changes.
    *   `file-viewer` shows an artifact (rendered markdown, or plain text) or
        a diff.
    *   The page lists every open task, plus the working-tree changes once.
*   **Why**: CUJ 2.

##### 43. `packages/ui/src/pages/diagnostics.tsx` (Create)

*   **Type / Scope**: Diagnostics screen.
*   **Proposed Changes**: renders `/api/diagnostics`, with a "copy for a bug
    report" button that copies the redacted JSON the server returns.
*   **Why**: debugging.

##### 44. `.github/workflows/cli.yml` (Create)

*   **Type / Scope**: CI.
*   **Proposed Changes**: runs on pushes and PRs that touch `packages/cli/**`
    or `packages/ui/**`, on `ubuntu-latest` and `macos-latest`:
    *   **Node 18 job:** pnpm install, then
        `pnpm --filter ./packages/cli test:hooks`.
    *   **Node 20 job:** pnpm install, then
        `pnpm --filter ./packages/cli test`, then
        `pnpm --filter @shipline/ui typecheck`, then
        `pnpm exec prettier --check packages/ui/src packages/cli/src/ui`, then
        `node packages/cli/scripts/build-ui.mjs` (build plus size check).
*   **Why**: the size budget, and a check that the hook scripts' tests pass
    on Node 18. Prettier is limited to new code so it doesn't reformat the
    templates or fail on existing files.

##### 45. `packages/cli/test/ui/auth.test.mjs`, `packages/cli/test/ui/setup.test.mjs`, `packages/cli/test/ui/tasks.test.mjs` (Create)

*   **Type / Scope**: integration tests against a real server on a temporary
    repo.
*   **Proposed Changes**:
    *   **Auth:**
        *   A wrong Host gives 403.
        *   A POST to any route except `/api/relay` with a foreign `Origin`,
            or with no `Origin`, gives 403.
        *   No cookie gives 401. A cookie of the wrong length gives 401, not
            500.
        *   A `/?t=` with a wrong token gives 403.
        *   `--port` with a used port exits 1 with "Port <n> is in use".
        *   With port 0, the cookie name and Host check use the real port.
        *   `/?t=` sets `shipline_ui_<port>` and redirects.
        *   Two servers on different ports keep separate cookies.
        *   The token never appears in `ui.log`.
    *   **Setup:**
        *   Saving each template unchanged leaves its bytes unchanged.
        *   Editing enforcement and saving is reflected by `stage.mjs status`.
        *   An unknown key survives.
        *   A changed file on disk gives 409, and in a two-file save nothing
            is written.
        *   The impact list is correct for add, remove and reorder.
        *   A "repo newer" `VERSION` refuses the save.
        *   These targets give 400: a rules id `../x` and a workflow id
            `../../bin/guard`.
        *   An invalid model sent straight to save gives 400 with the error
            list.
        *   `baseHash: null` for an existing file gives 409 (`exists`), and
            nothing in the batch is written.
        *   Copying `feature` to `review` writes `workflows/review.yml` with
            `id: review`, and `stage.mjs start --workflow review` records
            `workflow: review`. Copying onto an existing id gives 409.
        *   A file that doesn't parse is returned with its error.
        *   With a `config.yml` that doesn't parse, the server still starts,
            and `GET /api/tasks` returns `configError` with no tasks.
        *   After saving a new `artifact_root`, `GET /api/tasks` scans the
            new folder.
        *   A request body over 1 MB gives 413.
    *   **Interchangeability:** a hand edit (simulating `/shipline-setup`),
        then a UI save, then a hand edit, loses no fields.
    *   **Tasks:**
        *   After `stage.mjs advance`, an SSE `tasks` event arrives within 1 s.
        *   Editing a source file sends a `tasks` event with the change.
        *   Writing to `.shipline/.state/` sends no event.
        *   `/api/file` rejects `../`, a symlink pointing outside the repo, and
            a path that is neither in a task folder nor changed.
*   **Why**: Goals 4, 5, 6 and 7.

#### Phase 2: chat with permission cards

##### 46. `packages/cli/src/ui/versions.mjs` (Create)

*   **Type / Scope**: Node module, copied from `packages/shared/src/versions.ts`.
*   **Proposed Changes**: `parseVersion`, `compareVersions` and
    `meetsMinVersion`, unchanged.
*   **Why**: the minimum `claude` version check.

##### 47. `packages/cli/src/ui/claude.mjs` (Create)

*   **Type / Scope**: Node module. The health check is copied from
    `apps/local/src/server/claude-cli.ts` (`claudeHealth`); the `PATH` search
    is new.
*   **Proposed Changes**:
    *   `findClaude()` is new code. It returns `SHIPLINE_CLAUDE_BIN` when set
        (tests only), otherwise the first `claude` found on `PATH`, or
        `null`.
    *   `claudeHealth()` is copied: version from `claude --version`, sign-in
        status, and `meetsMinVersion` against `MIN_CLAUDE_VERSION`.
    *   `MIN_CLAUDE_VERSION` is the version recorded in item 19.
    *   `buildArgs({ sessionId, resume, mcpConfig })` returns the exact argv
        from the Technical Plan. It throws if any forbidden flag is ever
        included.
*   **Why**: one place that owns the argv.

##### 48. `packages/cli/src/ui/stream.mjs` (Create)

*   **Type / Scope**: Node module, copied from `packages/shared/src/stream-json.ts`.
*   **Proposed Changes**:
    *   `parseLine(line)` returns `{ ok: true, event }`, `{ ok: false }` or
        `{ skip: true }` for a blank line.
    *   `userMessage(text)` builds the stdin line.
    *   Helpers: `isInit`, `isResult`, `isUsageLimit`;
        `guardDenial(toolResult)`, which matches the text captured in item 19
        question 6; and `hookSystemMessage(event)`, which extracts a hook
        `systemMessage` from the event shape captured in item 19 question 8.
        If question 8 found no such events, it always returns `null`.
*   **Why**: stream handling and how notices are shown.

##### 49. `packages/cli/src/ui/chat.mjs` (Create)

*   **Type / Scope**: chat process manager.
*   **Proposed Changes**:
    *   `startChat({ sessionId, resume })` takes the lock (item 50), writes
        the MCP config (item 54), and spawns `findClaude()` with
        `buildArgs(...)`, `detached: true` (its own process group),
        `cwd: root` and env plus `SHIPLINE_SESSION`. If item 19 question 5
        found that `MCP_TOOL_TIMEOUT` raises Claude's limit, the env also gets
        `MCP_TOOL_TIMEOUT=660000`.
    *   A `spawn` `'error'` event (for example `ENOENT`) is handled like an
        unexpected exit.
    *   Buffers stdout by line and sends each event to SSE `chat`.
    *   Tracks turn state: busy from a user message until its `result`. A
        message sent while busy returns 409 (`busy`). A message to an ended
        chat returns 409 (`chat-ended`).
    *   If a line fails to parse, it calls `stop()` and sends a `chat` event
        `{ kind: "fatal", reason: "parse", resumeCommand }`.
    *   On an unexpected exit, it marks the chat ended, releases the lock, and
        sends `{ kind: "fatal", reason: "exit", code, stderrTail }`. An exit
        before `system/init` during a resume sends
        `{ kind: "fatal", reason: "resume-failed" }`.
    *   Calls `watchState` (item 27) to fill in `task_dir` in
        `sessions.json` when `stage.mjs start` or `resume` writes
        `.state/<id>.json`.
    *   The chat `title` in `sessions.json` is the first 60 characters of
        the first user message, with line breaks replaced by spaces.
    *   `stop()` follows the order in the Technical Plan. Its promise always
        settles, and errors are logged, not thrown.
*   **Why**: Goals 8, 9 and 10, and CUJs 3 and 4.

##### 50. `packages/cli/src/ui/sessions.mjs` (Create)

*   **Type / Scope**: session index and lock.
*   **Proposed Changes**:
    *   `listChats()`, `addChat()` and `updateChat()` on `sessions.json`,
        written atomically.
    *   `acquireLock({ sessionId, port })` writes `lock.json` with the `wx`
        flag. On `EEXIST` it reads the file:
        *   If it doesn't parse and is more than 10 s old (a crash between
            creating and writing it), it is stale.
        *   If its `pid` is this process, it returns `{ heldBy: 'self',
            sessionId }`; `POST /api/chats` turns that into 409
            (`chat-active`) with the active chat id.
        *   If the hostname matches and `process.kill(pid, 0)` throws
            `ESRCH`, it is stale.
        *   A stale lock is removed and the write retried once. Otherwise it
            returns `{ heldBy: port }`, which becomes 409 (`lock-held`) with
            `heldBy`.
    *   `releaseLock()` removes the file only if its `pid` is this process.
*   **Why**: one active chat per checkout, with recovery after a crash.

##### 51. `packages/cli/src/ui/transcript.mjs` (Create)

*   **Type / Scope**: Node module, copied from `apps/local/src/server/transcript.ts`.
*   **Proposed Changes**: `readHistory(root, sessionId)` finds the session file
    (direct path, then a scan) and returns user and assistant messages plus
    tool-use summaries, skipping lines it can't parse. It returns
    `{ unavailable: true }` when nothing parses.
*   **Why**: history for reopened chats, including terminal turns (CUJ 4).

##### 52. `packages/cli/src/ui/chat-routes.mjs` (Create)

*   **Type / Scope**: chat API handlers.
*   **Proposed Changes**:
    *   `GET /api/chats` and `POST /api/chats`.
    *   `GET /api/chats/<id>` returns metadata plus `readHistory`.
    *   `POST /api/chats/<id>/message`, `/stop` and `/continue`.
    *   Request bodies: `POST /api/chats` takes `{ message }` (the first user
        message; the chat starts with it). `/message` takes `{ text }`.
        `/continue` and `/stop` take no body.
    *   Starting or continuing a chat calls `requireWritable` first (423
        `repo-newer`).
    *   `claudeHealth()` failures return 412 with `code` `claude-missing`,
        `claude-too-old` or `claude-signed-out`, and the matching notice.
*   **Why**: the API table.

##### 53. `packages/cli/src/ui/relay.mjs` (Create)

*   **Type / Scope**: standalone MCP stdio server (its own process, started by
    `claude`).
*   **Proposed Changes**: implements the JSON-RPC handling in the Technical
    Plan. `tools/call approve` POSTs the arguments to `SHIPLINE_UI_RELAY_URL`
    with header `X-Shipline-Relay: $SHIPLINE_UI_RELAY_SECRET` and no
    `Origin` header, using `node:http.request` with `setTimeout(0)` (never
    `fetch`), and returns the answer. The request options are built by an
    exported `relayRequestOptions(url, secret)` so the test can inspect them.
    It exits when stdin closes.
*   **Why**: Goal 11, with no policy in the relay.

##### 54. `packages/cli/src/ui/prompts.mjs` (Create)

*   **Type / Scope**: pending-prompt store, relay endpoint and MCP config.
*   **Proposed Changes**:
    *   `writeMcpConfig(sessionId, port)` makes the per-spawn secret and writes
        `<state>/ui/mcp-<uuid>.json` (mode 0600) in the format in the
        Technical Plan. It refuses if the repo's `.mcp.json` defines
        `shipline_ui`.
    *   `POST /api/relay` skips the cookie and `Origin` checks. It returns
        403 (`bad-origin`) if the request has any `Origin` header, and 403
        (`bad-secret`) unless `X-Shipline-Relay` matches the current spawn's
        secret by `safeEqual` (item 22: length check, then
        `timingSafeEqual`). Then it creates
        `{ id, chatId, tool, input, expiresAt }`, sends SSE `prompt`, and holds
        the response open.
    *   `POST /api/prompts/<id>` takes `{ decision: "allow" | "deny", answers? }`
        and resolves it.
        *   Allow returns `{ behavior: 'allow', updatedInput: input }`.
        *   For AskUserQuestion, it returns `updatedInput: { ...input, answers }`.
        *   Deny returns the deny message.
        *   It then sends SSE `prompt-resolved`.
    *   `PROMPT_TIMEOUT_MS` is a named constant: 600 000, or the value set by
        the rule in "Waiting for the answer" after item 19 question 5, and
        overridable with `SHIPLINE_UI_PROMPT_TIMEOUT_MS` for tests. When it
        runs out, the prompt resolves with `{ behavior: 'deny', message: 'No
        answer within <n> minutes' }` (built from the constant) and sends
        `prompt-resolved` with `outcome: "timeout"`.
    *   A `POST /api/prompts/<id>` for an unknown or already-resolved prompt
        returns 404 (`not-found`).
    *   `denyAll(chatId)` is called by `stop()`.
    *   On SSE connect, every pending prompt is re-sent. With no SSE
        connection, one line is printed to the server's stdout. Each prompt
        and its outcome is logged.
*   **Why**: Goal 11.

##### 55. `packages/ui/src/pages/chat/chat-page.tsx`, `packages/ui/src/pages/chat/chat-list.tsx`, `packages/ui/src/pages/chat/message-list.tsx`, `packages/ui/src/pages/chat/composer.tsx`, `packages/ui/src/pages/chat/tool-call.tsx`, `packages/ui/src/pages/chat/notices.tsx` (Create)

*   **Type / Scope**: Chat screen.
*   **Proposed Changes**:
    *   A list of chats (active, ended).
    *   History from `GET /api/chats/<id>`, then the live stream, with partial
        messages appended as they arrive.
    *   Collapsible tool-call blocks.
    *   A composer that is disabled while a turn is running.
    *   Notices: "Shipline blocked", "Shipline reminder", other Shipline
        notices, "You denied", usage limit, "Install Claude Code", and fatal
        with the copyable `claude --resume <id>`. A failed resume offers
        "Start a new chat".
    *   A cost and usage line from `result` events.
    *   `task-panel` (item 42) on the right.
    *   A lock-held state showing the other server's port.
*   **Why**: CUJs 3 and 4.

##### 56. `packages/ui/src/pages/chat/permission-card.tsx`, `packages/ui/src/pages/chat/question-card.tsx` (Create)

*   **Type / Scope**: chat cards.
*   **Proposed Changes**:
    *   The permission card shows the tool name and a readable summary of the
        input: the command for Bash, the path and a diff preview for Edit or
        Write, and JSON otherwise. It has Allow and Deny buttons and a
        countdown to `expiresAt`. It is removed on `prompt-resolved`.
    *   The question card renders AskUserQuestion's questions as single- or
        multi-select choices, with an "Other" text field. It sends answers in
        the format in the Technical Plan.
*   **Why**: Goal 11 and CUJ 3.

##### 57. `packages/cli/test/fixtures/fake-claude.mjs`, `packages/cli/test/fixtures/streams/*.jsonl` (Create)

*   **Type / Scope**: test double.
*   **Proposed Changes**:
    *   An executable script (`#!/usr/bin/env node`; the test setup runs
        `chmod +x` on it) that accepts the real argv and records it to the
        file named by `FAKE_CLAUDE_ARGV_OUT`.
    *   It replays a fixture stream chosen by `FAKE_CLAUDE_SCRIPT`. It can
        also emit an invalid line, exit early, exit before `system/init`, or
        hang.
    *   When the script says so, it starts the relay from the `--mcp-config`
        file and calls `approve` over MCP stdio.
*   **Why**: CI runs with no Claude credentials.

##### 58. `packages/cli/test/ui/chat.test.mjs`, `packages/cli/test/ui/lock.test.mjs`, `packages/cli/test/ui/transcript.test.mjs`, `packages/cli/test/ui/shutdown.test.mjs` (Create)

*   **Type / Scope**: integration tests.
*   **Proposed Changes**:
    *   **Chat:**
        *   The argv contains none of the forbidden flags.
        *   A new chat uses `--session-id`, and continuing uses `--resume`
            with the same id.
        *   The relay secret is not in `claude`'s environment.
        *   An invalid line gives a fatal event with the command.
        *   An early exit releases the lock.
        *   An exit before `system/init` on resume gives `resume-failed`.
        *   A message sent while a turn is running gets 409.
        *   A guard denial in the fixture is labelled "Shipline blocked".
        *   A missing `claude` returns 412 (`claude-missing`). A spawn
            `ENOENT` is handled like an early exit.
        *   When the fake claude writes `.state/<id>.json` after start, the
            chat's `task_dir` is filled in.
    *   **Lock:** a second server gets 409 (`lock-held`) with `heldBy`. A
        second chat in the same server gets 409 (`chat-active`) with the
        active chat id. A lock whose pid is dead is replaced. An empty lock
        file older than 10 s is replaced.
    *   **Transcript:** a fixture session file parses. A corrupted one gives
        `unavailable`.
    *   **Shutdown:** SIGINT on the server leaves no process from the fake
        claude's group (checked with `ps`) and no `lock.json`.
*   **Why**: Goals 8, 9 and 10.

##### 59. `packages/cli/test/ui/relay.test.mjs` (Create)

*   **Type / Scope**: integration tests.
*   **Proposed Changes**:
    *   The JSON-RPC handshake works. An unknown method gives `-32601`. Bad
        JSON gives `-32700`.
    *   A relay POST with no `Origin`, no cookie and the right secret
        succeeds.
    *   A relay POST with any `Origin` header (for example
        `http://127.0.0.1:<port>`) gets 403, even with the right secret.
    *   A wrong secret gives 403. A secret of the wrong length gives 403, not
        500.
    *   Allow and deny round-trip through the fake claude, and each sends
        `prompt-resolved`.
    *   AskUserQuestion answers arrive in `updatedInput.answers`.
    *   A timeout gives a deny whose message is built from the constant
        (with `SHIPLINE_UI_PROMPT_TIMEOUT_MS=1000`).
    *   No-timeout checks, since the 300 s limits are real-time timers inside
        Node that a test can't fast-forward:
        *   After `startServer`, `server.requestTimeout === 0` and
            `server.timeout === 0`.
        *   `relayRequestOptions(...)` (item 53) builds `node:http` options
            with a timeout of 0 and no `Origin` header, and `relay.mjs`
            contains no `fetch(` call (a source check).
    *   An SSE reconnect re-sends the pending prompt.
    *   `stop()` denies pending prompts.
    *   A colliding `.mcp.json` name refuses to start.
    *   The relay process exits when its stdin closes.
*   **Why**: Goal 11.

#### Documentation (with Phase 1, updated per phase)

##### 60. `README.md` (Modify)

*   **Type / Scope**: docs.
*   **Proposed Changes**:
    *   In "Shipline Local":
        *   `pnpm --filter shipline build` becomes
            `pnpm --filter @shipline/local build`.
        *   On the line `node apps/local/dist/server/cli.js   # headless: or,
            once published, npx shipline`, remove the `npx shipline` part.
        *   "the tray (or the `npx shipline` terminal)" becomes "the tray (or
            the `pnpm dev:local` terminal)".
        *   `pnpm --filter shipline desktop:dist` becomes
            `pnpm --filter @shipline/local desktop:dist`.
    *   In the CLI section, add `npx shipline ui`: what it does, Node 20 for
        this command, that it is optional, the banners and the
        `claude --resume` fallback.
*   **Why**: users find the command, and hub instructions stop pointing at
    the CLI's name.

##### 61. `docs/plans/shipline-v2-repo-init.md` (Modify)

*   **Type / Scope**: docs.
*   **Proposed Changes**:
    *   Under the Status line, add "Amended by
        `.claude/plans/shipline-local-ui.md` (optional local UI)."
    *   Change "There's no database and no server." to "There's no database
        and no hosted server; an optional local UI (`npx shipline ui`)
        exists."
*   **Why**: the v2 plan stays accurate.

##### 62. `packages/cli/templates/claude-md-section.md` (Modify)

*   **Type / Scope**: vendored template.
*   **Proposed Changes**: change the last bullet to "Customize with
    `/shipline-setup` or `npx shipline ui`. Requires Node 18+ (Node 20+ for
    the UI)."
*   **Why**: tells Claude and developers that the UI exists. This affects
    new repos only.

##### Not changed

*   `packages/cli/templates/shipline/bin/stage.mjs`, `prompt-submit.mjs`:
    no change.
*   `packages/cli/templates/claude/skills/shipline-setup/SKILL.md`: no
    change. It tells Claude to keep the field names and single-quote regexes,
    which the writer also does for values it hasn't changed.
*   `packages/plugin/`: no `/shipline:ui`. A foreground server started from
    Claude's Bash tool would block the session.
*   `packages/shared/`, `apps/api/`: no change.

### Verification Plan

*   **Compilation/Build**: `pnpm --filter @shipline/ui typecheck`;
    `node packages/cli/scripts/build-ui.mjs` (build plus the 400 KB gzip
    budget).
*   **Unit Tests**: `pnpm --filter ./packages/cli test:hooks` runs items 13,
    15 and 18 (and 16 and 17, which use a temporary repo), on Node 18 and 20.
*   **Integration Tests**: `pnpm --filter ./packages/cli test` adds items 45,
    58 and 59 (a real server with the fake claude), on Node 20.
*   **Static Analysis & Linting**:
    `pnpm exec prettier --check packages/ui/src packages/cli/src/ui`.
*   **Test Coverage Requirement**: every check in the schema table, every
    writer quoting rule, and every branch of the version comparison has a
    test. Line-coverage percentages are not measured (`node:test` coverage is
    experimental on Node 20).
*   **Manual checks** with the real `claude` on a real repo, before each phase
    is marked done:
    *   **Phase 0:** a `block`-mode edit before plan is denied in the terminal
        (unchanged behaviour). A lost task is warned once (Goal 2). A warn
        rule shows "Shipline reminder" in the terminal (Goal 3).
    *   **Phase 1:** CUJ 1 and CUJ 2 work end to end (Goals 4–7). A teammate's
        clone enforces the saved workflow with the UI never started (Goal 12).
    *   **Gate:** item 19 complete; the `-p` answer and the "why not Claude's
        own GUIs" answer written; the Phase 1 dogfood signal recorded.
    *   **Phase 2:** CUJ 3 with cards, CUJ 4, a tab reload during a pending
        card, and one card left to time out (Goals 8–11).
    *   **Dogfood (Goal 13):** after Phase 2, per the values in Open
        Questions.
*   Round-2 review nits (26) accepted as-is; see implementation_readiness_report.md.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
