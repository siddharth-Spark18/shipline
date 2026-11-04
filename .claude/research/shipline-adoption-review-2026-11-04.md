# Shipline adoption review (2026-11-04)

Record of a feature-ideator discussion about what would stop developers and teams from adopting Shipline across the organization, and what to improve. This is a summary of the conversation, not a spec.

**Codebase state:** `main` at `a67ddf6`. Shipline CLI 0.6.0, with `init`, the hooks, `stage.mjs`, and `shipline ui` (setup, tasks, chat). Design document: `.claude/plans/shipline-local-ui.md`.

## Must fix first

- **The npm name `shipline` is taken.** It belongs to an unrelated maintainer (`afshinmeh`, version 0.1.0). The README, `init`'s success message and `packages/plugin/commands/init.md` (`npx --yes shipline init`) all point at it, so following our docs today runs a stranger's code.
- **Fix:** publish under a scoped name the organization controls, then update every reference.

## Findings by area

### Install and upgrade

1. **Not published.** The only way to run Shipline is from a checkout of this repo. Publishing needs a release process: build `ui-dist` at `prepack`, then version.
2. **Hooks need Node.** They run `node "$CLAUDE_PROJECT_DIR/.shipline/bin/…"`, so repos whose developers don't have Node 18+ get a hook error on every Edit, Write and Bash call, and enforcement stops working.
3. **`init` is all or nothing.** It vendors 31 template files and aborts on any name collision. There is no `uninstall`.
4. **No upgrade path.** `init` refuses to run on a repo that already has Shipline, and there is no `upgrade` command. Repos set up earlier never receive hook fixes. `brown-bg-tracker` is already on an older version.

### Daily friction

5. **Ceremony.** The `CLAUDE.md` block tells Claude to use the workflow for "any request to build, fix or change something". Feature tasks have 8 stages, 3 of them need confirmation, and Plan is set to `block`. The risk is that developers turn Shipline off because trivial changes trigger it.
6. **Task data in the repo.** Task folders (`docs/shipline/<task>/`) show up in PRs, and `manifest.json` conflicts in merges.
7. **No Jira in the chat.** The Atlassian connector isn't authorized in `-p` sessions, so the Jira stage is skipped for every task started from the UI.

### Trust

8. **Stage progress is self-reported.** Claude passes `stage.mjs advance --confirmed` and `skip --force` itself (`stage.mjs:204`, `:212`). The guard blocks edits and commands for real, but nothing checks the "developer confirmed" step. v2 dropped the CI-side `shipline/gates` check.
9. **The chat depends on unconfirmed `claude -p` behaviour.** The chat test (item 19) has never run, and several `UNVERIFIED` assumptions remain. Nobody has confirmed that a local app may drive `claude -p`. Stopping a chat can leave a child process running.

### Proof and rollout

10. **No usage data** to support an organization-wide recommendation.
11. **The README is still mostly about the v1 hub.** The hub apps are still in the repo.
12. **Windows has never been tested.** Linux file watching has only been proven in CI.

Measured: the guard's no-task path costs about 65 ms per gated tool call in a small repo.

## Directions the author chose

The author wants to work on **all** of the areas above, plus the two directions below.

### Choosing agents and skills

Teams pick which agents and skills to add, or bring their own, instead of receiving all of ours.

- `init` and the Setup screen list the agents and skills to choose from. `shipline-workflow` and `shipline-setup` are required.
- `init` detects the agents and skills a repo already has, and per-stage agent pickers list both. Name collisions become "keep yours / add ours / skip" instead of aborting.
- Limitations:
  - Workflow defaults must adapt when an agent isn't selected; `agent:` is only a suggestion today.
  - The UI would start writing `.claude/agents` files.
  - Upgrades must be able to tell our vendored agents apart from the team's.

### No task metadata in repo folders

Reuse Claude Code's own storage pattern. Claude stores sessions at `~/.claude/projects/<encoded-path>/`; Shipline would mirror it:

```
~/.shipline/projects/<repo path, non-alphanumerics → "-">/
  tasks/<slug>/manifest.json + artifacts
  state/<session>.json
  ui/sessions.json, lock.json, ui.log
```

- Only deliberately committed config stays in the repo: `.shipline/` config, workflows, rules, `bin/`, and the `.claude/` files.
- `artifact_root` and `folder_pattern` leave `config.yml`.
- Limitations:
  - Storage is keyed by path, so moving the repo or opening a second clone starts with no tasks (the same as Claude's chats).
  - Tasks aren't shared across people or machines.
  - Reviewers lose `plan.md` from the PR diff; the PR stage should summarize the plan and verification in the PR body instead.
- What changes:
  - The guard's artifact-write exemption.
  - `stage.mjs`.
  - Session-start resume.
  - The UI's Tasks, Artifacts and file viewer.
- This bumps `INTERFACE` and needs a migration for existing `docs/shipline/` folders, which ties in with `upgrade`.

## Expected ordering (for feature-planner to confirm)

Do the npm scoped name and the task-storage move first, because later work builds on them. Then install and upgrade (including agent and skill selection), the daily-friction fixes, trust, and the proof/rollout work.
