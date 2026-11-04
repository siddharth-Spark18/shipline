# Shipline v2: repo-installed Claude workflow (`npx @forgeyard/shipline init`)

Status: approved 2026-11-02. Note: the package is now published as `@forgeyard/shipline` (commands below use the new name). Supersedes the hub direction in `shipline-v1.md` (hub is removed in a later phase).
Amended by `.claude/plans/shipline-local-ui.md` (optional local UI).

## Problem & Goal

Shipline is currently a hosted hub (API, DB, web UI, local service). That's heavy to adopt, and it doesn't
guarantee that everyone working with Claude in a repo follows the same process. v2 turns Shipline into a
tool that installs into a repo like graphify or code-review-graph. A team runs `init` once and defines how
Claude should work there: which workflows exist, their stages, the rules for each stage, and how strictly
each stage is enforced. Everything is committed, so **anyone who clones the repo and opens Claude Code gets
the same flow with nothing to install.**

**Success means all four of these hold:**

1. **Dogfood:** after `npx @forgeyard/shipline init` and `/shipline-setup` on a real repo, a teammate clones it and
   Claude follows the Feature flow end to end with no install.
2. **Gates work:** in `block` mode, Claude cannot edit source before the plan is done or commit/open a PR
   before verify is done. In `warn` mode it gets reminded.
3. **Resume works:** a new session finds the saved artifacts and resumes at the right stage.
4. **Existing setup is safe:** `init` on a repo that already has `CLAUDE.md` or `.claude/` content clobbers
   nothing.

## Scope

### In

- A new `packages/cli` that publishes a `shipline` bin with an `init` command.
- Vendored output committed into the target repo: `.claude/` (agents, skills, hooks, settings) plus a
  `.shipline/` folder (workflows, stage rules, config).
- Three default workflows:
  - **Feature:** Jira → feasibility → questions → plan → wireframes (only if UI) → implement → verify →
    commit/PR.
  - **Bugfix:** Jira → reproduce → root cause → fix → verify → commit/PR. This is a default the team can
    edit in setup.
  - **Hotfix:** a short path, roughly Jira → fix → verify → commit/PR. Also a default the team can edit.
- A Claude-led `/shipline-setup` interview that customizes stages, per-stage enforcement and confirmation,
  per-stage rules, and artifact locations.
- Auto-detection of the workflow type, with dev confirmation.
- Per-stage enforcement (`guide` / `warn` / `block`) implemented with hooks.
- Per-stage choice of whether advancing needs dev confirmation.
- Saved artifacts, and resume from them.
- `packages/plugin` reduced to a thin wrapper that exposes `/shipline:init`.

### Out (later)

- `shipline upgrade`.
- Roles and role policies.
- The hosted `shipline/gates` GitHub check and any CI action.
- Trackers other than Jira.
- Removing `apps/api`, `apps/web` and `apps/local`: a follow-up once the CLI is validated. They stay
  untouched in this pass.

## Surface Area

### This repo

- New `packages/cli/`:
  - The bin, which uses `npx @forgeyard/shipline init` as its entry point.
  - `templates/` holding the `.claude/` and `.shipline/` files.
  - Merge logic for existing files.
- `packages/plugin/`: reduced to a thin `/shipline:init` wrapper. The current hub-coupled agents, skill,
  hooks and `.mcp.json` move into the CLI templates as adapted versions.
- Agents are based on the existing `packages/plugin/agents/*` (planner, builder, reviewer, qa-bug-hunter,
  wireframe-proposer, researcher). Strip the hub, MCP and server references, and wire each agent to its
  stages.
- `packages/shared/`: reuse pure stage and guardrail logic where it fits. The hooks themselves must be
  standalone `.mjs` files with no dependencies.
- The README gets a CLI section. The hub docs stay until the removal phase.

### Generated in the target repo

```
.shipline/
  config.yml                      # artifact root, naming patterns, tracker = jira, test/lint/build commands (optional)
  workflows/{feature,bugfix,hotfix}.yml  # ordered stages: id, name, optional/conditional (e.g. ui_only), enforcement, confirm_to_advance, block patterns
  rules/<stage>.md                # repo-specific instructions per stage (filled by /shipline-setup)
  bin/*.mjs                       # hook + stage scripts (no deps, Node only)
  .state/                         # gitignored, per-session state
.claude/
  agents/                         # adapted: planner, builder, wireframe-proposer, qa/verifier, researcher, reviewer
  skills/shipline-setup/          # the setup interview
  skills/shipline-workflow/       # how to run a workflow (detect, stages, artifacts, advancing)
  settings.json                   # hooks merged in (SessionStart, UserPromptSubmit, PreToolUse)
CLAUDE.md                         # appended marked <!-- shipline:start/end --> section
```

### Data and API

There's no database and no hosted server; an optional local UI (`npx @forgeyard/shipline ui`) exists. State lives in two places:

- **Session state:** `.shipline/.state/<session_id>.json` records the active task and workflow. It's
  gitignored.
- **Task progress:** `<artifactRoot>/<task>/manifest.json` records stage statuses and lives next to the
  artifacts. This is what makes resume possible.

### Default naming

- The artifact folder is `docs/shipline/<JIRA-KEY>-<slug>/`, or `<slug>` when there's no ticket.
- The branch is `<type>/<JIRA-KEY>-<slug>`.
- Both patterns are configurable.

## Behavior & Edge Cases

### `init`

- Scaffolds the default workflows.
- Merges into existing files and never clobbers: it appends a marked block to `CLAUDE.md`, merges the hooks
  into `settings.json`, and adds agent and skill files next to existing ones.
- **If a name collides, it aborts with a clear message and writes nothing** (it checks everything before
  writing anything).
- It ends by telling the user to run `/shipline-setup` in Claude Code.
- Re-running `init` in an already-initialized repo reports this and exits.

### `/shipline-setup`

- Reads the repo and any existing `CLAUDE.md` or agents.
- Interviews the team about stages, enforcement, confirmation, rules and artifact locations.
- Writes `.shipline/`.
- Without setup, the defaults still work.

### Workflow start

- A `UserPromptSubmit` hook and the workflow skill have Claude classify each request: "This looks like a
  feature, so I'll follow the Feature workflow. OK?" The dev confirms or switches.
- Quick questions and non-task chatter don't start a workflow.

### Stages

- **Jira:** uses the Atlassian MCP when it's connected. Otherwise Claude says so and the stage is skipped,
  or it uses details pasted by the dev.
- **Feasibility:** a *not feasible* verdict means Claude writes `feasibility.md` (blockers plus
  alternatives) and stops for the dev to decide. *Partly feasible or uncertain* means the blockers feed into
  the questions stage.
- **Wireframes:** run only when the plan marks the work as UI-affecting.
- **Verify:**
  - Builds a requirement checklist in `verification.md` that maps each acceptance criterion to evidence.
  - For UI work, runs the app and checks it in a browser.
  - Runs the test, lint and build commands only if they're configured.
- **Commit/PR:** uses `git` and `gh` with the dev's own credentials. The PR body links the artifacts.

### Advancing

A stage has exit criteria, meaning its artifact exists and is marked done. Each stage's config sets
`confirm_to_advance`:

- `true`: Claude asks the dev, then records the advance.
- `false`: Claude auto-advances.

### Enforcement

A `PreToolUse` hook checks the active task's manifest.

- **Default block patterns:**
  - Edit/Write outside the artifact root is blocked until plan is done.
  - `git commit` and `gh pr create` are blocked until verify is done.
  - Reads, exploring and writes to artifacts are always allowed.
- **Modes:**
  - `block` denies the action with a reason that names the missing stage.
  - `warn` allows it and adds a reminder.
  - `guide` sets no hook check.
- Patterns can be overridden per stage.
- With no active task (no workflow started), the hooks do nothing.

### Resume

- The `SessionStart` hook scans the artifact root for manifests that aren't complete and injects a summary
  ("PROJ-12 add-export: plan done, next: wireframes").
- Claude offers to resume. If several tasks are open, it lists them.
- Matching the current branch to a task is a useful signal for which one to pick.

### Malformed config

The hooks fail open with a visible warning. A broken config must never brick Claude.

## Constraints

- **Node 18+ is required** on teammates' machines, because the hooks are `.mjs` scripts.
- Shipline still never handles Claude credentials.
- Jira stays read-only, through the Atlassian MCP. Shipline ships no Jira code.
- The hooks have no dependencies and must be fast, under about 100 ms, since they run on every tool call.
- Generated files must be readable and editable by teams.

## Verification

1. Run `init` on a fresh sample repo, then `/shipline-setup`, then commit. Clone it fresh and run a Feature
   request through to the PR.
2. Gates:
   - In `block` mode, an Edit before the plan is denied.
   - In `block` mode, `gh pr create` before verify is denied.
   - In `warn` mode, the same actions are allowed with a reminder.
3. Stop a session after the plan stage. In a new session, Claude offers to resume at wireframes or
   implement.
4. Run `init` on a repo with an existing `CLAUDE.md`, `.claude/settings.json` and agents. Diff to confirm
   nothing was overwritten. A colliding agent name aborts with nothing written.
5. Test the infeasible path: Claude stops with `feasibility.md`.

## Open Questions

- **npm package name:** is `shipline` available on npm? If not, which name should we use?
- **Recording confirmation:** in `block` + `confirm_to_advance` mode, the hook can't truly verify that a
  human confirmed. Claude records the advance after asking. Is that trust level acceptable?
- **Default stage lists:** the exact default stages for Bugfix and Hotfix are a suggestion. You may want to
  refine them.
- **Two sessions, one task:** if two sessions work on the same task folder at once, the manifest writes are
  last-write-wins. Is that acceptable for v1?
