# Teams Phase 1: fit any repo on day one (detected commands, default rules, setup nudge, GitHub Issues) and chat-first tasks

**Status:** Approved
**Roadmap:** `docs/plans/shipline-teams-roadmap.md`, Phase 1. Source: `.claude/research/teams-guardrails-workflows-2026-11-05.md`.
**Release:** 0.10.0, on a new branch from `main` (`733eff1`).

## Problem & Goal

After `init`, a repo has a working workflow but almost no repo knowledge:

- `config.yml` ships with empty `commands`, so Verify has nothing to run.
- All 11 `rules/*.md` files are empty stubs.
- The ticket stage only knows Jira.

`/shipline-setup` fixes most of this, but only if someone runs it.

**Goal:** a team gets useful behaviour on day one without the setup interview:

- the right commands, detected;
- sensible per-stage guidance;
- a clear nudge to tailor it;
- GitHub Issues as a tracker for teams that don't use Jira.

**Tasks in the UI.** The UI also treats a task as the container for chats:

- the sidebar groups chats under tasks;
- a separate Tasks page repeats the chat's stage panel.

In practice one chat (like a Claude Code session) works through several tasks. Today a chat only remembers the *latest* task it bound to (`chat.mjs` `bindTask` overwrites `task_dir`). So earlier tasks in the same chat lose their link, and a finished task disappears from the chat's panel, because the UI only loads unfinished tasks. The author asked to make tasks live inside the chat (2026-11-05).

**Done when** (author's criteria):
1. **Fresh init fills commands.** Running `init` on a Node, Python, Go, Rust or Make repo pre-fills the right test, lint and build commands. Interactive `init` lets the developer accept or edit them; `--yes` accepts them.
2. **GitHub Issues works end to end.** A task started from issue #123 gets the branch `feature/issue-123-…`, a `ticket.md` filled from `gh`, and `Closes #123` in the PR description.
3. **Rules are useful out of the box.** Every shipped stage has real default guidance, and the setup nudge shows until `/shipline-setup` has run.
4. **Existing repos upgrade cleanly.**
   - `upgrade` renames `jira` to `ticket`.
   - It fills empty commands and replaces untouched stub rules.
   - Open tasks keep working.
5. **Tasks are chat-first.**
   - The Tasks page and the sidebar's task grouping are gone.
   - A chat that works on two tasks lists both in order in its right panel. The current one is expanded; earlier ones are one line each, and finished ones stay visible.
   - Unfinished tasks with no chat show on the new-chat screen with a **Resume** button.

## Scope

### In

**A. Command detection**

- **A new module, `packages/cli/src/detect-commands.mjs`.** It exports `detectCommands(root) → { test, lint, build, sources: { test: 'package.json', … } }`.
  - It only checks files at the repo root, and never runs anything.
  - For each command, the first detector with an answer wins, in this order: Node, Python, Go, Rust, Make.
- **Node** (`package.json` present):
  - **Package manager:** `pnpm-lock.yaml` means `pnpm`, `yarn.lock` means `yarn`, `bun.lockb` or `bun.lock` means `bun`, otherwise `npm`.
  - **test:** `scripts.test` gives `<pm> test`. It's ignored when it contains `no test specified` (npm's placeholder).
  - **lint:** `scripts.lint` gives `<pm> run lint`.
  - **build:** `scripts.build` gives `<pm> run build`, otherwise `scripts.typecheck` gives `<pm> run typecheck`.
- **Python** (`pyproject.toml`, `requirements*.txt`, `setup.cfg` or `setup.py` present):
  - **Runner:** `uv.lock` means the prefix `uv run `, `poetry.lock` means `poetry run `, otherwise no prefix.
  - **test:** `pytest` when the word `pytest` appears in any of those files.
  - **lint:** `ruff check .` when `ruff` appears, otherwise `flake8` when `flake8` appears.
  - **build:** none.
- **Go** (`go.mod`): `go test ./...`, `go vet ./...` and `go build ./...`.
- **Rust** (`Cargo.toml`): `cargo test`, `cargo clippy` and `cargo build`.
- **Make** (`Makefile` or `makefile`): `make test`, `make lint` and `make build`, each only when a line matching `^<target>\s*:` exists.
- **Unparsable `package.json`:** skip the Node detector, and log nothing to the user.

**B. Commands in `init` and `upgrade`**

- **Interactive `init`** (`init-prompts.mjs`), after the agents and skills step:
  - one prompt per detected command: "Test command [pnpm test]:", pre-filled and editable, where an empty answer means none;
  - a short line naming each source;
  - with nothing detected, the prompts start empty.
- **`init --yes`** writes the detected values.
- **`upgrade`** fills only commands that are empty or missing in `config.yml`, and never overwrites a set one.
  - It lists them in its plan output ("commands: test ← `pnpm test` (package.json)"), and `--dry-run` shows them.
  - It writes through the existing `emitConfig`, so comments and layout are kept.

**C. Default rules**

- **Every rules file gets default guidance.** Each file under `templates/shipline/rules/` keeps its header comment ("Repo-specific instructions … edit freely") and gains 5–10 bullets.
  - `jira.md` is replaced by `ticket.md`.
  - The text is generic, mentions no stack, and is written for Claude.
- **Outline for each stage:**
  - **ticket:**
    - Read the ticket read-only and save it to `ticket.md`: title, description, acceptance criteria, links and labels.
    - Never create or edit issues.
    - The skip rules for Jira and GitHub are in scope D.
  - **feasibility:** what already exists in the codebase, what's missing, the risks and dependencies, and a rough size. Cite files.
  - **questions:**
    - Only questions whose answers change the implementation, grouped.
    - Ask them with AskUserQuestion.
    - Record the answers in `questions.md`.
  - **plan:**
    - Contents: goal, scope in and out, files to touch (each marked create, modify or delete), behaviour and edge cases, verification steps and open questions.
    - No code.
  - **wireframes:** follow the existing UI's components and spacing. Show every state (empty, loading, error) and give each state a variant.
  - **implement:**
    - Follow the plan and the repo's existing patterns.
    - Keep the diff to the plan's files.
    - Note any deviation in `implementation.md`.
  - **reproduce:** exact steps, expected versus actual, and the environment. Use a failing test when practical.
  - **root_cause:** the cause with file and line evidence, why it happens, and what else it affects. No fix yet.
  - **fix:** the smallest change that fixes the cause, plus a regression test when the repo has tests.
  - **verify:**
    - Check each acceptance criterion against evidence.
    - Run the configured test, lint and build commands, and record each one's result.
    - For UI work, check it in a browser.
  - **pr:**
    - Branch per `branch_pattern`, a conventional commit message, and a PR description with a summary, a test plan and the `stage.mjs pr-summary` output.
    - Never push to the default branch.
- **The stage-specific lines move.** The 0.9.0 lines "skip when Jira isn't connected" in `jira.md` and `SKILL.md` move into `ticket.md` and the skill text from scope D.

**D. Tracker choice and the `ticket` stage**

- **Settings:**
  - `config.yml`'s `tracker` takes `jira` (the default) or `github`.
  - `setup-schema.mjs` gives a **warning**, not an error, for any other value: "not supported; the ticket stage will be skipped".
- **Stage id:**
  - The shipped workflows use stage id `ticket`, named "Ticket", with artifact `ticket.md`, in place of `jira`.
  - **One alias helper.** `lib.mjs` exports `sameStage(a, b)`, which is true when `a === b` or `{a, b}` is `{jira, ticket}`. **Every** stage-id comparison between a manifest, a workflow or a summary uses it, in both directions, so open tasks and edited files keep working. The call sites:
    - `guard.mjs` (the manifest-stage lookup for blocks, around line 155);
    - `lib.mjs` (`describeStage`, and the open-task summaries around lines 446 and 518);
    - `stage.mjs` (`stageCfg`, `activateNext`, skip, reopen, `pr-summary` and status);
    - `ci-check.mjs` (matching summary stages to workflow stages);
    - `packages/cli/src/ui/tasks.mjs` (wherever it joins manifest stages to workflow stage config).
  - **Rules files:** a stage's rules load from `rules/<id>.md`. For `ticket` or `jira`, they try `rules/ticket.md` first, then `rules/jira.md`.
  - **Config keyed by stage id:** `confirm_to_advance` and `blocks` belong to the workflow stage entry itself, so they follow it through the alias, and no other config is keyed by stage id.
- **`stage.mjs start --ticket`:**
  - **`jira`:** the key is upper-cased, as today.
  - **`github`:**
    - Accepts `123`, `#123` or `issue-123`. Anything else exits with an error.
    - The key becomes `issue-123`, and `manifest.task.issue` is set to `123`.
    - The branch and task folder use the key, giving `feature/issue-123-add-export`.
- **What Claude does at the ticket stage** (the `shipline-workflow` skill, plus `describeCurrent` naming the tracker):
  - **`jira`:** as today, using the Atlassian MCP, read-only. Skip with "Jira not connected" when it's unavailable.
  - **`github`:** run `gh issue view <n> --json number,title,body,labels,url,state` (read-only) and save the result to `ticket.md`. Skip with "GitHub not connected" when `gh` is missing, not signed in, or the call fails.
  - **Pasted details:** if the developer pastes ticket details, Claude uses those.
  - **No confirmation:** the stage is optional, so skipping it needs no question.
- **`stage.mjs pr-summary`:** with tracker `github` and `task.issue` set, it prints `Closes #<n>` as the first line, before `### Shipline`. `ci-check.mjs` ignores that line.
- **Choosing the tracker:**
  - **Interactive `init`:**
    - It asks "Tracker: GitHub Issues / Jira".
    - It pre-selects GitHub Issues when `git remote get-url origin` contains `github.com`, and Jira otherwise.
    - `--yes` keeps `jira`.
  - **The Setup page's config form:** the tracker text field becomes a select (Jira or GitHub Issues).
    - An unknown value already in the file is shown as an extra option labelled "(unsupported)".
- **Chat notice:** this generalises the 0.9.0 Jira notice.
  - **Server:** `GET /api/chats/<id>` returns `ticket: { tracker: 'jira'|'github', status: 'connected'|'needs-auth'|'failed'|'missing' } | null` in place of `jira`.
  - **Jira status:** as today, from `mcp_servers`.
  - **GitHub status:** from a new `ghStatus()`, which runs `gh auth status` through `startSpec` with a 5 s timeout and caches the result for 60 s per server.
    - A spawn error with `ENOENT` gives `missing`.
    - A non-zero exit gives `needs-auth`.
    - A timeout gives `failed`.
  - **UI:** the notice shows when the chat's task is at stage `ticket` (or `jira`) and the status isn't `connected`. Notice text for GitHub:
    - **missing:** "GitHub CLI not found. Install `gh` (cli.github.com). Claude will skip the ticket stage for now."
    - **needs-auth:** "GitHub CLI isn't signed in. Run `gh auth login` in a terminal. Claude will skip the ticket stage for now."
    - **failed:** "Couldn't check the GitHub CLI. Claude will skip the ticket stage for now."
- **`{key}` in branch patterns:** `{key}` is unchanged. An empty key is still dropped.

**E. The setup nudge**

- **Marking setup as done:** `/shipline-setup`'s SKILL.md adds a last step: write `setup: done` as a top-level key in `config.yml`.
  - `setup-schema.mjs` accepts `setup` as a top-level key.
  - The Setup config form doesn't show it as an editable field.
- **While `setup` isn't `done`, the nudge appears in three places:**
  - **`init`'s final message:** "Next: tailor the rules to this repo. Run `/shipline-setup` in Claude Code, or open `npx @forgeyard/shipline ui` and use Setup → Set up with Claude."
  - **SessionStart, once per developer:** `session-start.mjs` adds `systemMessage: "Shipline is using its default rules here. Run /shipline-setup to tailor them to this repo."`
    - It reads `setup` through `loadConfig`. It writes the marker `path.join(stateDir(root), 'setup-nudged')`, using `lib.mjs`'s existing `stateDir`, and doesn't repeat while that file exists.
    - Any error here is ignored: no message, and exit 0.
  - **The Setup page:**
    - A banner says "This repo uses Shipline's default rules", with a **Set up with Claude** button.
    - The button starts a new chat with the message `/shipline-setup` and switches to the Chat tab.
    - If a chat is already active, a toast says "Finish or stop the current chat first."

**F. Upgrade migration**

- **Workflow files:** in every `.shipline/workflows/*.yml`, a stage `id: jira` becomes `id: ticket`.
  - Its `name` becomes `Ticket` when it was `Jira ticket`.
  - Its artifact stays `ticket.md`.
  - It's written through `emitWorkflow`, and shown in the plan output with a diff, as with the existing `artifact_root` migration in `planConfig`.
- **`rules/jira.md` becomes `rules/ticket.md`:**
  - **Unchanged from a shipped version:** replaced by the new `ticket.md`.
  - **Edited:** renamed to `ticket.md` with its content kept, and the new Jira and GitHub skip text appended under a `## Shipline defaults (0.10.0)` heading.
  - **`ticket.md` already exists:** `jira.md` is left alone, and the plan output warns about it.
- **The other rules files:** each one that still exactly matches a shipped stub is replaced with the new default.
  - A file matches when its SHA-256 equals a stub hash from any earlier version. The builder records these from `git log -p packages/cli/templates/shipline/rules` before editing.
  - Edited files are never touched.
- **Commands:** empty commands are filled, as in scope B.
- **Open tasks:** no manifest is rewritten. The `jira`/`ticket` aliasing from scope D covers them.

**G. Chat-first tasks (UI redesign)**

- **Data: a chat remembers every task it touched.**
  - Each `sessions.json` entry gains `task_dirs: string[]`: every task folder the chat's session has bound to, oldest first, with no duplicates. Re-binding to a task already in the list moves nothing.
  - `task_dir` is kept as the *current* task (the last bound one), so older UIs keep working.
  - `bindTask` in `chat.mjs` appends to `task_dirs` when the state file names a new task, and updates `task_dir`.
  - **Existing entries:** an entry with no `task_dirs` reads as `[task_dir]` (or `[]`). `sessions.mjs` normalises this on read, so no migration is written.
- **API:**
  - `GET /api/chats/<id>` gains `tasks: Task[]`. These are the chat's `task_dirs` resolved to the same `Task` shape as `GET /api/tasks`, finished tasks included, in order.
    - A folder that no longer exists, or whose manifest doesn't parse, is left out.
    - A folder outside this repo's store is never read: it must resolve inside `<store>/tasks`, using the existing `resolveInsideStore`.
    - This uses a new `readTask(root, dir)` in `tasks.mjs`.
      - `task_dirs` entries are **absolute store paths**, the same as `task_dir` today.
      - `readTask` calls the module-private `resolveInsideStore(root, dir)`: `null` (outside the store) is left out, `{ missing: true }` is left out, and `{ real }` is read.
      - An unreadable or unparsable manifest is also left out.
      - All of these are silent, with only a log line.
  - `GET /api/tasks` stays: it lists unfinished tasks plus `changes`. The UI uses it for the new-chat screen and the Changes section.
  - Each `ChatSummary` in `GET /api/chats` gains `task_dirs`.
- **Refreshing:**
  - The UI refetches `GET /api/chats/<id>` (its react-query key) on a `chat` SSE event with `kind: 'task'` for that chat, and on every SSE `tasks` event, the existing one sent when task files change.
  - In `chat-page.tsx`, the old `task` and `changes` props passed to `TaskCanvas` are replaced: `ChatTasksPanel` takes `tasks` from the chat detail, `currentDir` from `chat.task_dir`, and `changes` from the existing `GET /api/tasks` query.
- **Chat right panel** (it replaces today's single `TaskCanvas`):
  - **Header:** "Tasks in this chat". The tasks are listed oldest first, and the current task (`task_dir`) is expanded with:
    - its stage timeline (the existing `StageTimeline`);
    - its artifacts (the existing `ArtifactList`), each opening in the existing file viewer.
  - **Earlier tasks:** collapsed to one line, "<title> · <workflow> · <n>/<m> stages" with ✓ when complete. Clicking one expands it, and only one is expanded at a time.
  - **A chat with no task yet:** the panel shows "No task yet. Claude starts one when you ask for a change."
  - **Changes section:** a collapsible section below the tasks.
    - It shows the whole working tree, using the existing `ChangesCard` and diff viewer, with data from `GET /api/tasks` `changes`.
    - It's collapsed by default, and the header shows the count ("Changes · 2 files").
  - On narrow screens, the panel keeps today's behaviour, the drawer or toggle the chat page already uses.
- **Sidebar:**
  - Chats are listed flat, newest `last_active` first, with active chats first as today.
  - Each row shows the chat title. A muted second line names the current task's title, with its stage dots (the existing `StageDots`).
  - A chat with no task has no second line.
  - The "TASK: …" group headers and the "No task" group are removed.
- **Tasks page:**
  - `pages/tasks/tasks-page.tsx` is deleted, and the `tasks` view is removed from `app.tsx`'s `VIEWS` and from the sidebar navigation.
  - An old `#tasks` or `?view=tasks` URL falls back to Chat.
- **New-chat screen:**
  - Before the first message, if there are unfinished tasks that aren't the current task of any active chat, it shows "Unfinished tasks", one row each: title, workflow, next stage, and a **Resume** button.
  - Resume starts a new chat with the message `Resume the Shipline task <slug>` (Claude then runs `stage.mjs resume`, per the skill).
  - If a chat is already active, it shows the existing `chat-active` toast.

### Out

- **Confirmations:** no change to `confirm_to_advance` defaults, presets, approving a task's stages once up front, or risk-based questions.
- **Trackers:** Linear, and creating or updating issues in any tracker.
- **Monorepos:** per-package commands and detection below the repo root.
- **Running commands at verify:** that's Phase 2. In Phase 1, the verify rule only *tells* Claude to run them.
- **Running Claude during `init`** to draft rules. Tailored rules come from `/shipline-setup` only.
- **Tasks:**
  - "files changed since this chat started" (Changes shows the whole working tree);
  - deleting or archiving tasks from the UI;
  - moving a task between chats.

## Surface Area

- **CLI:** `init.mjs`, `init-prompts.mjs`, `upgrade.mjs`, `setup-schema.mjs`, the new `detect-commands.mjs`, `known-hashes.json` (regenerated) and `package.json` (0.10.0).
- **Vendored templates:**
  - `config.yml`, all four workflows, the `rules/*.md` files (`jira.md` deleted, `ticket.md` created);
  - `bin/stage.mjs`, `bin/ci-check.mjs` and `bin/session-start.mjs`;
  - the `shipline-workflow` and `shipline-setup` skills.
- **UI server:** `chat-routes.mjs` (`ticket` replaces `jira`), `stream.mjs` (`jiraStatus` is kept and used by the new code), and the new `tracker.mjs`.
- **Browser UI:**
  - `chat-page.tsx` and `notices.tsx` (the ticket notice);
  - `setup/config-form.tsx` (the tracker select) and `setup/setup-page.tsx` (the nudge banner and Set up with Claude);
  - `lib/types.ts` and `lib/api.ts`.
- **Data:**
  - `config.yml` gains `tracker: github` and `setup: done`;
  - the manifest gains `task.issue` (a number, optional);
  - a new store marker, `state/setup-nudged`.
  - `INTERFACE` stays 4: old UIs ignore the new fields, and the new UI handles a `jira` stage id.
- **API:**
  - `GET /api/chats/<id>`: `jira` is replaced by `ticket`, and `tasks` is added.
  - `GET /api/chats` entries gain `task_dirs`.
  - The server and UI ship together.
- **Data:** `sessions.json` entries gain `task_dirs`, normalised on read.

## Files to Touch

- `packages/cli/src/detect-commands.mjs` (**create**): `detectCommands(root)`, as in scope A.
- `packages/cli/src/init.mjs` (**modify**):
  - calls `detectCommands`;
  - writes `commands` and `tracker` into the new `config.yml`;
  - `--yes` uses detected commands and `jira`;
  - adds the final-message nudge.
- `packages/cli/src/init-prompts.mjs` (**modify**): the command prompts and the tracker prompt, with the default from `git remote get-url origin`.
- `packages/cli/src/upgrade.mjs` (**modify**): the `planConfig` additions from scope F:
  - empty-command fill;
  - `jira` → `ticket` in workflow files;
  - `rules/jira.md` → `ticket.md`;
  - replacing stub rules by known-stub hashes;
  - plan output and `--dry-run` lines.
- `packages/cli/src/setup-schema.mjs` (**modify**): `tracker` warns on values other than `jira` and `github`, and `setup` becomes an allowed top-level key.
- `packages/cli/templates/shipline/config.yml` (**modify**): a comment documenting `tracker: jira | github` and `setup`. `commands` stay empty in the template, because `init` fills them.
- `packages/cli/templates/shipline/workflows/feature.yml`, `bugfix.yml`, `hotfix.yml` and `small.yml` (**modify**): stage `jira` becomes `ticket`, named "Ticket".
- `packages/cli/templates/shipline/rules/jira.md` (**delete**).
- `packages/cli/templates/shipline/rules/ticket.md` (**create**): default ticket rules for both trackers, including the skip rules.
- `packages/cli/templates/shipline/rules/{feasibility,questions,plan,wireframes,implement,reproduce,root_cause,fix,verify,pr}.md` (**modify**): the default guidance from scope C.
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**):
  - the `jira`/`ticket` alias in stage lookups and rules loading;
  - `--ticket` parsing for GitHub and `task.issue`;
  - `pr-summary`'s `Closes #n` line;
  - `describeCurrent` naming the tracker at the ticket stage.
- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**):
  - `sameStage(a, b)`, used at its own call sites;
  - `loadConfig` passes through `tracker` (missing gives `jira`, any other value is kept as written) and `setup` (missing gives `undefined`).
- `packages/cli/templates/shipline/bin/guard.mjs` (**modify**): the stage lookup uses `sameStage`.
- `packages/cli/templates/shipline/bin/ci-check.mjs` (**modify**): the `jira`/`ticket` alias when matching summary stages to workflow stages.
- `packages/cli/templates/shipline/bin/session-start.mjs` (**modify**): the once-per-developer setup nudge as a `systemMessage`.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` (**modify**): the ticket stage for Jira and GitHub, and the skip reasons. This replaces the `jira` bullet.
- `packages/cli/templates/claude/skills/shipline-setup/SKILL.md` (**modify**): a tracker question in the interview, and writing `setup: done` at the end.
- `packages/cli/src/ui/tracker.mjs` (**create**): `ghStatus()`, with the cache, and `ticketStatus(tracker, initInfo)`.
- `packages/cli/src/ui/chat-routes.mjs` (**modify**): `GET /api/chats/<id>` returns `ticket` in place of `jira`.
- `packages/ui/src/pages/chat/chat-page.tsx` and `packages/ui/src/pages/chat/notices.tsx` (**modify**): `TicketNotice` replaces `JiraNotice`, shown at stage `ticket` or `jira`, with the texts from scope D.
- `packages/ui/src/pages/setup/config-form.tsx` (**modify**): the tracker select, and `setup` hidden from editable fields.
- `packages/ui/src/pages/setup/setup-page.tsx` (**modify**): the nudge banner and the Set up with Claude button. The button uses the existing new-chat API and tab switch, with a `chat-active` toast.
- `packages/ui/src/lib/types.ts` and `packages/ui/src/lib/api.ts` (**modify**): `TicketStatus`, `ChatDetail.ticket`, `ChatDetail.tasks`, `ChatSummary.task_dirs`, and `ConfigModel.setup`.
- `packages/cli/src/ui/sessions.mjs` (**modify**): normalise `task_dirs` on read; add `addTaskDir(root, id, dir)`.
- `packages/cli/src/ui/chat.mjs` (**modify**): `bindTask` appends to `task_dirs` and keeps `task_dir` as the current task.
- `packages/cli/src/ui/tasks.mjs` (**modify**): `readTask(root, dir)`, for any task in the store, done or not, checked with `resolveInsideStore`. Stage joins use `sameStage`, imported from the vendored `lib.mjs` the way `init.mjs` already imports it.
- `packages/cli/src/ui/chat-routes.mjs` (**modify**, in addition to the ticket change): `tasks` on `GET /api/chats/<id>`, and `task_dirs` on the list.
- `packages/ui/src/pages/tasks/tasks-page.tsx` (**delete**).
- `packages/ui/src/app.tsx` (**modify**): remove the `tasks` view, with an old `tasks` view falling back to `chat`.
- `packages/ui/src/components/app-sidebar.tsx` (**modify**):
  - flat chat list, with the current task on a second line;
  - remove `groupChats` and the Tasks nav item.
- `packages/ui/src/components/task-panel.tsx` (**modify**): a `ChatTasksPanel` (the list of tasks, the expanded current one, and the collapsible Changes section) replaces `TaskCanvas`. `StageTimeline` and `ArtifactList` are reused, and `TaskPanel` is removed if nothing else uses it.
- `packages/ui/src/pages/chat/chat-page.tsx` (**modify**, in addition to the ticket change):
  - use `ChatTasksPanel` with `chat.tasks`;
  - the new-chat screen's "Unfinished tasks" list with Resume.
- `packages/cli/src/known-hashes.json` (**modify**): regenerated with `packages/cli/scripts/hash-templates.mjs`.
- `packages/cli/package.json` (**modify**): version 0.10.0.
- `docs/plans/shipline-teams-roadmap.md` (**modify**): link Phase 1 to this plan once it's approved.

### Tests (written separately, listed here)

- **`test/detect-commands.test.mjs` (create):** fixture repos for each ecosystem, plus:
  - each of the four Node package managers;
  - the npm placeholder ignored;
  - typecheck used as the build fallback;
  - uv and poetry prefixes;
  - ruff preferred to flake8;
  - Make targets only when they exist;
  - precedence when Node and Make are both present;
  - a broken `package.json`;
  - an empty repo.
- **`test/init*.test.mjs` (modify):**
  - `--yes` writes the detected commands and `tracker: jira`;
  - the interactive prompts are pre-filled and editable (through the existing prompt test harness);
  - the remote-based tracker default;
  - the nudge appears in the final message.
- **`test/upgrade.test.mjs` (modify):**
  - empty commands are filled and set ones kept;
  - `jira` → `ticket` in workflow files, with a diff in the plan output;
  - `jira.md`: the unedited, edited and `ticket.md`-exists cases;
  - stub rules replaced, edited rules kept;
  - `--dry-run` writes nothing.
- **`test/stage*.test.mjs` (modify):**
  - GitHub `--ticket` forms (`123`, `#123`, `issue-123`, bad input);
  - the `issue-123` branch and folder;
  - `Closes #123` in `pr-summary` (GitHub only);
  - a manifest with `jira` against a workflow with `ticket`, and the reverse: advance, skip, status and rules loading.
- **`test/ci-check*.test.mjs` (modify):**
  - a summary with `jira` against a workflow with `ticket` passes;
  - the `Closes` line is ignored.
- **The SessionStart hook test (modify):**
  - the nudge shows once, then the marker suppresses it;
  - no nudge with `setup: done`;
  - an error writing the marker still exits 0.
- **`test/ui/chat.test.mjs` (modify):** `ticket` for Jira in each state, and for GitHub through a fake `gh` on `PATH` (exit 0, exit 1, missing, slow), plus the cache.
- **`test/ui/setup*.test.mjs` (modify):** schema warnings for an unknown tracker, and `setup` accepted.
- **Chat-first tasks in `test/ui/chat.test.mjs` (modify):**
  - a chat that starts task A, then task B, then resumes A has `task_dirs` `[A, B]` and `task_dir` A;
  - `GET /api/chats/<id>` returns both tasks, including a finished one;
  - an old entry without `task_dirs` reads as `[task_dir]`;
  - a `task_dirs` entry outside the store, or whose folder is missing, is left out.

## Behavior & Edge Cases

- **No ecosystem detected:** commands stay empty, as today.
- **Both `package.json` and a `Makefile`:** Node wins for each command it has. Make fills only the ones Node lacks.
- **The developer clears a detected command in interactive `init`:** it's written empty.
- **The tracker is `github` but the remote isn't GitHub, or `gh` points to another host:** `gh issue view` fails, and Claude skips with "GitHub not connected". This is accepted.
- **The tracker is `github` and the developer gives a Jira-style key (`PROJ-12`):** `stage.mjs start` exits with "GitHub issue numbers look like 123 or #123".
- **The tracker changes after tasks exist:** existing tasks keep their key. Only new tasks use the new format.
- **`setup: done` is removed by hand:** the banner returns. The SessionStart nudge doesn't, because the per-developer marker exists.
- **A workflow has both `jira` and `ticket` stages** (hand-edited): there's no aliasing. Each matches only itself, and `upgrade` leaves that file's `jira` stage alone, with a warning.
- **A chat's task is removed from the store:** it's dropped from `tasks`, and the panel shows the remaining ones.
- **Two chats bound to the same task:** each lists it. The new-chat screen hides a task that's the current task of an active chat.
- **`ghStatus`:** it's only computed when the chat's task is at the ticket stage and the tracker is `github`, so other chats never spawn `gh`.

## Constraints

- **No new dependencies.** The hooks stay Node 18 and dependency-free.
- **Detection only reads files.** It never runs project scripts or package managers.
- **`upgrade` never overwrites edited team files.** Every change shows in the plan output and in `--dry-run`.
- **Windows:** `gh` is started through `startSpec`, and paths go through `path.join`.

## Verification

1. **Fresh init:**
   - Run `init --yes` in a pnpm repo, a uv Python repo, a Go repo and a Rust repo. `config.yml` has the expected commands.
   - Interactive `init` shows them pre-filled.
2. **GitHub Issues:** on a GitHub repo with `tracker: github`, ask the browser chat to "work on issue #123". Then check:
   - the branch is `feature/issue-123-…`;
   - `ticket.md` has the issue;
   - `pr-summary` starts with `Closes #123`;
   - with `gh auth logout`, the chat shows the sign-in notice and Claude skips the stage.
3. **Rules and nudge:**
   - A fresh repo's rules files contain guidance.
   - The first `claude` session shows the setup nudge once.
   - The Setup page shows the banner, and Set up with Claude opens a chat running `/shipline-setup`.
   - After setup, `setup: done` is in `config.yml` and the banner is gone.
4. **Upgrade:**
   - Run `upgrade` on a 0.9.0 repo (for example brown-bg-tracker) that has an open task at the `jira` stage.
   - The plan shows the rename, the filled commands and the replaced stub rules.
   - Afterwards the open task still advances, skips and shows status.
5. **Chat-first tasks:**
   - In one chat, ask for a small fix (task A), let it finish, then ask for a feature (task B).
   - The right panel lists A (collapsed, ✓) and B (expanded). Opening A shows its stages and files.
   - The sidebar shows the chat once, with B on its second line, and there's no Tasks page.
   - A task started in a terminal `claude` shows on the new-chat screen, and Resume continues it in a new chat.
   - Changes is collapsed and shows the working tree.
6. **Tests:** the suite, `test:hooks` and CI are green on all three operating systems.

## Open Questions

- **Default rule wording:** the outlines above set the content, but the exact text is the builder's to write. The author reviews it in the PR.
- **`gh` on GitHub Enterprise hosts:** this isn't handled. `gh` uses its own default host.
- **Python detection by word match** (`pytest` or `ruff` appearing in files) can give false positives, for example a comment that mentions pytest. This is accepted, because the developer confirms in interactive `init`.
