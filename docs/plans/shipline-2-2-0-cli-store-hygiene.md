# Shipline 2.2.0, part E: store keys, worktrees, prune/relink, upgrade conflicts, CLI and docs hygiene

**Status:** Approved (review must-fixes applied)

Part E of the 2026-11-19 audit follow-up. Ships in **2.2.0** on `release/2-2-0` with Plans A and D, built **after D**,
in its own commit. Plan A already bumps INTERFACE to 2 and makes `.shipline/bin/*` upgrade as one unit; Plan D adds
`findRoot` from the call's cwd and leaves "tasks shared across worktrees" to this plan.

## Problem & Goal

- **Store key collisions:** the store folder is `encodePath(realpath)` (`lib.mjs:299`): every non-alphanumeric
  character becomes `-`, so `~/c/my-app` and `~/c/my/app` share a key and the second `init` fails with
  `STORE_COLLISION` (`lib.mjs:358`). Paths over ~255 characters fail to create the folder (`lib.mjs:348`).
- **Worktrees don't share tasks:** each worktree has its own absolute path and so its own store.
- **No cleanup:** stores of moved or deleted repos stay in `~/.shipline/projects` forever.
- **Moved repos:** `docs/troubleshooting.md` ("A task seems lost") says to move the store folder to the new key, which
  then hits `STORE_COLLISION` because `repo.json` still names the old root.
- **Monorepos:** `init --dir packages/web` installs into the subfolder with no warning, and command detection only
  looks at that folder (`detect-commands.mjs:28`), e.g. `npm test` in a pnpm workspace.
- **Upgrade conflicts:** edited files can only be replaced all at once with `--force` (`upgrade.mjs:328-331`).
- **CLI:** `shipline help init` prints the general help (`bin/shipline.mjs:146`); "already initialized" exits 0 with
  an unclear message.
- **Docs drift:** `install.md:66` says `--yes` installs every workflow (it installs the four defaults);
  CONTRIBUTING's CI paragraph predates the PR-only `ci` check; `configuration.md` lacks the `ci:` block; nothing
  recommends `npx ...@latest` for `upgrade`.
- **Publish safety:** `publish.yml` publishes any `v*.*.*` tag without checking the commit is on `main` or passed CI,
  and has no concurrency guard.

**Success:** two repos whose paths encode alike both install; a 300-character path installs; worktrees of one repo
see the same tasks; `shipline prune` cleans up gone repos; a moved repo gets its tasks back with one command;
monorepo installs warn and pick the right package manager; upgrade lets you resolve conflicts per file; publishing
an off-main or untested tag fails.

## Scope

### In

- E1. Collision-proof, length-capped store keys; lazy in-place migration of existing stores.
- E2. Worktrees share one store (keyed by the main repo); config/workflows still read from each worktree's checkout.
- E3. `shipline prune`: remove stores whose repo folder is gone.
- E4. `shipline relink --from <old path>`; troubleshooting doc fixed.
- E5. Monorepo/subfolder warning at init; package-manager detection from the git root.
- E6. Per-file upgrade conflicts: interactive keep / replace / write `.shipline-new` / diff; `--yes` writes
  `.shipline-new` side files.
- E7. Help: `shipline help` and `--help` print the overview plus every command's help; `help <cmd>` prints that
  command's; "already initialized" keeps exit 0 with a clear message.
- E8. Docs drift fixes; `npx @forgeyard/shipline@latest upgrade` in docs.
- E9. Publish safety: tag commit on `main`, its merged PR's `ci` check succeeded, concurrency per tag.

### Out (explicitly)

- Pruning old finished/abandoned tasks or stale session state (only missing-repo stores).
- Atomic/rollback upgrade, agent-clash backups, settings.json indent preservation.
- New stack detectors, smaller npx payload (inquirer optional), RAIL_IDS dedupe, UI `needsAnswer` sharing,
  prepack without pnpm.
- CI `merge_group`/push-to-main triggers (the path-filter fix stays on `ci/required-check`).
- Auto-detecting moved repos.

## Surface Area

- **Vendored lib (`templates/shipline/bin/lib.mjs`):** `storeDir` key scheme, main-root resolution for worktrees,
  lazy migration. Used by hooks, `stage.mjs`, the CLI and the UI (through `src/store.mjs`).
- **CLI (`packages/cli/bin`, `src/`):** new `prune` and `relink` commands, help output, init warning, detection,
  upgrade conflict flow, registry updates.
- **UI server:** uses the same `storeDir`; registry entries for worktrees keep their grouping; task lists show tasks
  from the shared store.
- **CI:** `.github/workflows/publish.yml`.
- **Data:** store folder name changes; `repo.json` gains `key_version: 2` and `main_root`; registry entries unchanged
  in shape. Side files `<file>.shipline-new` in the repo (upgrade).

## Behaviour & Edge Cases

### E1. Store keys and migration

- **Store root** (`mainRoot(root)`): for a git repo, the realpath of the parent of `git rev-parse --git-common-dir`
  (the main checkout, also for linked worktrees; bare/unusual layouts fall back to `realRoot(root)`); otherwise
  `realRoot(root)`. Cached per process.
- **New key:** `<readable>-<hash>`, where `readable` = `encodePath(mainRoot)` truncated to its **last** 80 characters
  (keeps the distinctive tail) and `hash` = first 10 hex chars of sha256 of `mainRoot` (lowercased on Windows,
  matching `sameRoot`). Total ≤ 91 characters.
- `repo.json` = `{ root: <mainRoot>, key_version: 2, created }`. The existing `STORE_COLLISION` check stays (now only
  reachable by a hash collision or a hand-copied folder).
- **Lazy migration (review must-fix 1):** on the **first** `storeDir` resolution in each process (cached afterwards),
  regardless of whether the new-key folder exists, check for the old-scheme folder of **this checkout**:
  `encodePath(realRoot(root))` whose `repo.json.root` equals that path. If found:
  - new-key folder absent → `rename` the old folder to the new key (atomic on one filesystem), then update `repo.json`;
  - new-key folder present (another checkout of the repo migrated or created it first) → **merge**: move each
    `tasks/<dir>` into the shared `tasks/` (suffix `-2`, `-3` on a name clash, as Plan D does for titles), move
    `state/` files likewise, then rename the emptied old folder to `<old>.migrated-<YYYY-MM-DD>` (kept, not deleted).
  - If a rename fails because the target appeared meanwhile (another process), fall through to the merge path.
  This way the main checkout and every worktree migrate independently, in any order, without stranding tasks.
- **Interface guard (review must-fixes 2 and 3):** `storeDir(root)` keeps its single-argument signature, so no call
  site changes. Internally it reads **the given checkout's** `.shipline/bin/VERSION` (`readRepoVersion`, cached per
  root per process): interface ≥ 2 → new key (+ migration); missing/1 → the old key for that checkout, never migrate.
  - The vendored hooks of an upgraded checkout are ≥ 2.2.0 (Plan A's bin-as-unit rule), so they always use the new key.
  - A worktree whose branch still carries 2.1 hooks keeps using its own old-key store, exactly as in 2.1 (tasks not
    shared). When that checkout's hooks become ≥ 2 (upgrade or merge), its first resolution merges the old store
    into the shared one (must-fix 1 path). The UI shows such a worktree with the note "Older Shipline hooks: tasks
    aren't shared with other worktrees until this branch is upgraded."
  - `encodePath` stays exported and unchanged: `ui/transcript.mjs` uses it for Claude Code's own project folder names,
    which must not change.
- Store paths in `~/.shipline/projects.json` (registry) are not keys, so the registry needs no migration; the UI's
  per-repo `ui/` folder moves with the store.

### E2. Worktrees

- All worktrees of a repo resolve to the same store (E1), so tasks, sessions, approvals and state are shared.
- Config and workflows are read from the **current checkout's** `.shipline/` (`findRoot`, Plan D cwd-first), not the
  main checkout's: a branch that edits its workflows is tested in its own worktree.
- A task's `task.branch` ties it to a branch; Plan D's auto-bind and session-start listing already filter by branch,
  so a worktree on branch X sees X's task first. `stage.mjs status --all` shows every task with its branch.
- Two worktrees on different branches can each work on their own task at the same time (Plan D ownership is per
  task).
- The UI: registry entries stay per worktree (grouped as today); each worktree's task list shows the shared store's
  tasks, with the branch shown on each.
- Fingerprints/checks (`stage.mjs check`) run in the current checkout (unchanged).

### E3. `shipline prune`

- `shipline prune [--dry-run] [--yes]`: lists every store under `~/.shipline/projects` whose `repo.json.root` no longer
  exists (or has no `.shipline/config.yml`) **and** to which no registered checkout that still exists resolves (review
  must-fix 4: a shared store whose main checkout is gone but whose worktrees are registered and present is kept), with
  task counts and size. Without `--yes` asks once to confirm (terminal);
  non-TTY without `--yes` behaves as `--dry-run` and says so. Removes those folders and their registry entries.
- Also lists `*.migrated-<YYYY-MM-DD>` folders whose name date is more than 30 days ago as removable (age from the
  folder name, not mtime).
- Never touches a store whose root exists. Exit 0; nothing to prune → "Nothing to prune."
- Refuses (exit 1) while a UI server is running and has that repo's chat active (checks `server.json`/the registry's
  running state; if unknown, warns and continues).

### E4. `shipline relink --from <old path>`

- Run in (or `--dir`) the moved repo. Computes the store key(s) the old path would have had (old scheme and new
  scheme), finds the one whose `repo.json.root` equals `<old path>`, and moves it to this repo's key, updating
  `repo.json.root`, `main_root` and the registry entry (old entry removed, new one registered).
- Refuses if this repo's store already has tasks (message tells you to `prune`/merge by hand) or if the old store's
  root still exists (it isn't moved).
- `--dry-run` shows what it would do.
- `docs/troubleshooting.md` "A task seems lost" is rewritten around `relink`.

### E5. Monorepo/subfolder init

- `init` compares the target's realpath with `git rev-parse --show-toplevel`. If they differ: print "This folder is
  inside the git repo at <toplevel>. Shipline's hooks only load when Claude Code starts in <target>; most teams install
  at the repo root." Then ask "Install here anyway?" (default No); `--yes` continues; non-TTY without `--yes` stops
  with exit 1 and the same text.
- Detection: when the target has no lockfile, `detect-commands` also checks the git toplevel for `pnpm-lock.yaml`,
  `yarn.lock`, `bun.lock(b)`, `package-lock.json` to pick the package manager; scripts still come from the target's
  `package.json` (commands run in the target folder).

### E6. Per-file upgrade conflicts

- **Scope (review must-fix 5):** the per-file prompt applies to Shipline-owned template files outside
  `.shipline/bin/` (rules, workflows, agents, skills, `config.yml` template parts it owns) and the optional CI workflow
  (`.github/workflows/shipline.yml`; a `.shipline-new` there isn't loaded by GitHub, which reads only `.yml`/`.yaml`).
  - `.shipline/bin/` stays all-or-nothing (Plan A).
  - The CLAUDE.md block and the `.claude/settings.json` hook entries keep today's behaviour: skipped with a message
    when edited, replaced by `--force`; no side files.
  - Files no longer shipped that the team edited: prompt **Keep** / **Delete**; `--yes` keeps them and lists them.
  - `upgrade --all`: never prompts; behaves like `--yes` per repo (side files), unless `--force`.
- Interactive (TTY, no `--yes`): for each edited file, in order: show its path and a short diff summary, then ask
  **Keep mine** / **Replace with new** / **Write .shipline-new** / **Show full diff** (re-asks after showing). The
  plan's writes happen only after all answers (and the final confirm).
- `--yes` (or non-TTY): for each edited file, write `<file>.shipline-new` next to it with the new version and list them
  at the end ("Merge these by hand, then delete the .shipline-new files").
- `--force`: unchanged (replace all edited files).
- Kept files keep their recorded hash in `VERSION.files` (so the next upgrade still sees them as edited); replaced
  files record the new hash. `.shipline-new` files are not recorded; `uninstall` removes any `*.shipline-new` next to
  Shipline-owned paths. They don't match any loader (`*.yml`, `*.md` patterns), so they're inert.
- `--dry-run` lists the per-file choices it would ask about.

### E7. Help and init exit

- `shipline help` and `shipline --help`: the overview followed by each command's full help (same text as
  `<cmd> --help`), separated by headings.
- `shipline help <cmd>` and `shipline <cmd> --help`: that command's help only. `help <unknown>` → error + overview, exit
  2.
- "Already initialized": exit 0, message "Shipline is already set up in <dir> (version X). To update it, run:
  npx @forgeyard/shipline@latest upgrade".

### E8. Docs

- `docs/install.md:66`: `--yes` installs the four default workflows (feature, bugfix, hotfix, small); others via
  Setup or `/shipline-setup`. Upgrade instructions use `npx @forgeyard/shipline@latest upgrade` and explain npx
  caching.
- `CONTRIBUTING.md`: CI runs on pull requests only, one required `ci` check, tests skipped when no CLI/UI code changed.
- `docs/configuration.md`: document the `ci:` block (`missing_block`, `skip_label`, `stale_checks`) with the example.
- `docs/troubleshooting.md`: relink (E4), prune (E3), monorepo note (E5).
- `docs/usage.md`: worktrees share tasks (E2); `prune`, `relink` in the command table; README command table too.

### E9. Publish safety

- `publish.yml` gains, before publishing:
  - `actions/checkout` with `fetch-depth: 0`; fail unless `git merge-base --is-ancestor $GITHUB_SHA origin/main`.
  - Find the merged PR for the tag commit (`gh api repos/{repo}/commits/{sha}/pulls`), take its head SHA, and fail
    unless that SHA's check run named `ci` concluded `success` (`gh api .../commits/{head}/check-runs?check_name=ci`).
    (CI runs on pull requests only, so the main commit itself has no `ci` run.) If no merged PR is found (direct push
    to main), fail with a message.
  - `concurrency: { group: publish-${{ github.ref_name }}, cancel-in-progress: false }`.
  - `permissions` add `pull-requests: read`, `checks: read`.
- The existing tag/version/changelog/hash checks and the test run stay.

## Constraints

- Vendored lib stays Node 18+, dependency-free; one extra `git rev-parse --git-common-dir` per process (cached).
- Migration must be safe with concurrent processes (rename-based, re-resolve on conflict) and never delete task data
  (old worktree folders are renamed, not removed).
- Windows: case-insensitive hashing input, paths under 260 chars where possible (the capped key helps).
- All template changes need `hash-templates.mjs` and the INTERFACE 2 `MISSING_BEFORE` text extended ("shared store
  for worktrees").

## Files to Touch

- `packages/cli/templates/shipline/bin/lib.mjs` — **modify**: `mainRoot`, new key, `repo.json` v2, lazy migration,
  interface-aware scheme helper exported for the CLI/UI.
- `packages/cli/src/store.mjs` — **modify**: re-export the new helpers; scheme choice by installed interface.
- `packages/cli/src/registry.mjs` — **modify**: entry updates for relink/prune.
- `packages/cli/src/prune.mjs` — **create**: `shipline prune`.
- `packages/cli/src/relink.mjs` — **create**: `shipline relink`.
- `packages/cli/bin/shipline.mjs` — **modify**: `prune`, `relink` commands; help behaviour (E7).
- `packages/cli/src/init.mjs` — **modify**: subfolder warning; already-initialized message.
- `packages/cli/src/detect-commands.mjs` — **modify**: lockfile at the git root.
- `packages/cli/src/upgrade.mjs` — **modify**: per-file conflict prompts, `.shipline-new` writes, dry-run listing.
- `packages/cli/src/uninstall.mjs` — **modify**: remove `*.shipline-new` next to owned paths; store lookup via
  `storeDir` instead of `encodePath` (line 26).
- `packages/cli/src/install.mjs`, `packages/cli/src/ui/server.mjs`, `packages/cli/src/ui/diagnostics.mjs`,
  `packages/cli/src/ui/projects.mjs` — **check/modify**: they call `storeDir`; signature unchanged, so modify only where
  they also build store paths by hand or display the key (diagnostics); `projects.mjs` also shows the older-hooks
  worktree note.
- `packages/cli/src/interface.mjs` — **modify**: extend `MISSING_BEFORE` text.
- `packages/cli/src/ui/tasks.mjs` — **modify** only if it computes store paths itself instead of via `store.mjs`.
- `packages/cli/src/ui/transcript.mjs` — **no change** (keeps `encodePath` for Claude's folders; listed so the builder
  doesn't touch it).
- `packages/cli/src/known-hashes.json` — **modify**: regenerate (with A and D).
- `.github/workflows/publish.yml` — **modify**: E9.
- `packages/cli/CHANGELOG.md` — **modify**: add E to the 2.2.0 entry.
- `README.md`, `packages/cli/README.md` — **modify**: command table (`prune`, `relink`), `@latest` upgrade.
- `docs/install.md`, `docs/usage.md`, `docs/configuration.md`, `docs/troubleshooting.md`, `CONTRIBUTING.md` —
  **modify**: E8.
- Tests — **create/modify** under `packages/cli/test/`: `store.test.mjs` (keys, collision case, long path, migration
  incl. concurrent rename, interface guard), `store-worktree.test.mjs` (**create**: `git worktree add` shares tasks,
  config from the worktree), `prune.test.mjs` (**create**), `relink.test.mjs` (**create**), `init-interactive.test.mjs`
  / `install.test.mjs` (subfolder warning), `detect-commands.test.mjs` (root lockfile), `upgrade.test.mjs` (per-file
  prompts, `.shipline-new`, `--yes`), `cli.test.mjs` (help output, already-initialized message),
  `uninstall.test.mjs` (`.shipline-new` removal), `publish.test.mjs` (the new guard steps, if it covers the workflow).

## Verification

- `node:test` cases as listed under Files to Touch.
- **Manual (user):** upgrade one of your real 2.1 repos that has existing tasks; confirm the store folder was renamed
  to the new key, tasks are listed by `stage.mjs status --all` and in the UI, and a `git worktree add` of it sees them.

## Open Questions

- **Bare repositories / unusual git layouts** (`--separate-git-dir`, submodules): E1 falls back to the checkout's own
  realpath when the common dir's parent isn't a working tree; the builder confirms the fallback with a test for a
  submodule.
- **UI registry for worktrees:** entries stay per worktree; if showing the same tasks under several worktree entries is
  confusing in practice, a later UI change can filter by branch (not in this plan).
- Review (`shipline-2-2-0-cli-store-hygiene.review.md`): must-fixes 1–5 applied above; re-review skipped by the
  user. Optional notes are for the builder, in line with this plan.

## Build-time decisions (2026-11-23)

- **E3 prune scope:** the plan contradicted itself ("or has no `.shipline/config.yml`" vs "never touches a store whose
  root exists"). Decided with the user: prune removes only stores whose repo folder is gone. A repo that still exists
  keeps its store even without Shipline (uninstall keeps it on purpose; `uninstall --purge` removes it).
- Builder deviations accepted: `install.mjs` opens the store with `storeDirFor(root, INTERFACE)` (VERSION doesn't exist
  yet at init); `mainRoot` uses the main checkout only for linked worktrees whose common dir is `.git` (subfolder
  installs, submodules, bare and separate-git-dir repos keep their own path); `upgrade` migrates the store right after
  writing VERSION; prune's running-UI check reads each store's `ui/lock.json`; `uninstall --purge` keeps a store another
  existing checkout still uses; `relink` renames a non-empty target store aside instead of deleting it.
