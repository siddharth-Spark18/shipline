# Phase 1: publish as @forgeyard/shipline, move task data out of the repo, `shipline upgrade`

**Status:** Approved
**Roadmap:** `docs/plans/shipline-adoption-roadmap.md` · **Research:** `.claude/research/shipline-adoption-review-2026-11-04.md`
**Builds on:** `.claude/plans/shipline-local-ui.md` (current CLI, hooks and UI) and `docs/plans/shipline-v2-repo-init.md`

## Problem & Goal

Three problems block recommending Shipline to anyone:

1. **The npm name `shipline` belongs to an unrelated maintainer.** Our README, `init`'s own message and the plugin's `/shipline:init` (`npx --yes shipline init`) all point at it. Following our docs today runs a stranger's code.
2. **Task metadata is written into the repo.** `docs/shipline/<task>/` holds the manifest and the artifacts, and `.shipline/.state/` holds session state and UI data (gitignored). This adds clutter to PRs and causes merge conflicts in `manifest.json`. The author doesn't want any extra metadata in repo folders.
3. **Repos can never get fixes.** `init` refuses to run on a repo that already has Shipline, and there is no `upgrade` command. Hook fixes never reach repos set up earlier, for example `brown-bg-tracker`.

**Goal:**
- Publish as `@forgeyard/shipline`. The npm org `forgeyard` exists and the package name is free, verified 2026-11-04.
- Store all task data outside the repo, the same way Claude Code stores its chats.
- Add `shipline upgrade`. It updates installed repos safely and migrates their existing task data.

**Phase 1 is done when all three of these hold:**
1. **brown-bg-tracker upgraded.** Running `shipline upgrade` on it does all of the following:
   - moves its tasks to `~/.shipline/projects/…`;
   - stages `git rm` of the old task folder;
   - updates the files the team hasn't edited.

   After that, Claude writes artifacts to the store with no permission prompts.
2. **A fresh install leaves the repo clean.** After a new `init` and one Feature task, `git status` shows nothing written by Shipline apart from what `init` itself installed.
3. **Tests and CI pass.** The updated and new tests pass on Node 18 and 20, on Linux and macOS.

## Scope

### In

**A. npm rename and publishing**
- The package is renamed `@forgeyard/shipline`. The `bin` stays `shipline`.
- Every user-facing `npx shipline …` becomes `npx @forgeyard/shipline …`.
- The plugin's `/shipline:init` runs `npx --yes @forgeyard/shipline init`.
- A GitHub Actions workflow publishes when a `v*` tag is pushed.

**B. Task storage outside the repo**
- **Location:** `$SHIPLINE_HOME/projects/<encoded repo path>/`. `SHIPLINE_HOME` defaults to `~/.shipline`, and the path encoding is the same as Claude Code's.
- **What moves there:** tasks (manifest and artifacts), session state, and UI data (sessions, lock, log, temp files).
- **Config:** `artifact_root` and `folder_pattern` are removed from `config.yml`. Task folders are always named `{key}-{slug}`, or `{slug}` when there's no ticket.
- **Permissions:** `init` adds allow rules so Claude can read and write the store without prompts.
- **PRs:** the `pr` stage rules have Claude put a short summary of the plan and the verification in the PR body.
- **Old repos in the UI:** for a repo that hasn't been upgraded (interface 2), the UI shows an upgrade banner and keeps reading tasks from the old in-repo location.

**C. `shipline upgrade`**
- `init` records a hash of every file it installs in `.shipline/bin/VERSION`.
- `upgrade` updates everything Shipline installed: `bin/`, the hook entries and allow rules in `settings.json`, Shipline's own agents and skills, and the `CLAUDE.md` block.
- **Edited files:** files the team has changed are shown as a diff and skipped unless `--force` is passed. Repos with no hash record are compared against the hashes of known releases.
- **Workflows and rules belong to the team.** `upgrade` only removes `{artifact_root}` entries from them, and only after showing each change in the preview.
- **What `upgrade` also does:**
  - migrates the in-repo tasks and `.state/` into the store;
  - removes `artifact_root` and `folder_pattern` from `config.yml`;
  - stages `git rm` of the old task folder.
- **How it runs:**
  - It shows a preview, then asks y/N.
  - `--yes` skips the question, and `--dry-run` only shows the preview.
  - If any task folder has uncommitted changes, or its name already exists in the store, it stops and changes nothing.
  - It warns about Claude sessions that are still running, but migrates anyway.

### Out (later phases or not planned)

- Interactive `init` with agent and skill selection, bring-your-own agents, `uninstall`, and a Node preflight (Phase 2).
- Reducing workflow prompts and stages, and Jira in the browser chat (Phase 3).
- Enforcement trust, the chat test and the child process left after stopping a chat (Phase 4).
- Metrics, the README rewrite beyond the rename, removing the hub, and Windows (Phase 5).
- Sharing tasks between people or machines. Tasks are personal, the same as Claude chats.
- A command that moves tasks after the repo folder is moved or renamed.
- Changing the internal `shipline` names in `apps/*`: the OAuth scope, the MCP server name and so on. These are part of the hub that is being retired and have nothing to do with the npm package.
- Rewriting historical plan and research documents in `.claude/` and `docs/plans/`, other than the v2 plan's command references.

## Surface Area

### Layers

- The CLI package: `init`, `upgrade` and the bin entry.
- The vendored hook scripts (templates).
- The UI server (`packages/cli/src/ui`).
- The browser UI (`packages/ui`).
- CI and the publishing workflow.
- Documentation.
- No database is involved.

### Store layout (new)

```
$SHIPLINE_HOME/projects/<encoded>/        # <encoded> = realpath(repo root) with every [^a-zA-Z0-9] → "-"
  repo.json                               # { "root": "<realpath of repo root>", "created": ISO }
  tasks/<key>-<slug>/manifest.json, <artifacts>
  state/<safeId(session)>.json, <safeId(session)>.lost-warned
  ui/sessions.json, lock.json, mcp-<id>.json, ui.log(.1), tmp/
```

- **`repo.json` guard:** when the store directory already exists and its `repo.json` names a different `root`, a different path has produced the same encoding. Every command then stops with an error naming both paths. Nothing silently shares a store.
- **Encoding:** the same scheme as `transcript.mjs`, which already uses it for Claude's history. Put it in one helper and reuse it.

### `VERSION` file (interface 3)

```json
{
  "package": "0.7.0",
  "interface": 3,
  "files": { "<repo-relative path>": "<sha256 of installed content>", "...": "..." }
}
```

`files` covers only Shipline-owned files:
- `.shipline/bin/*.mjs`, Shipline's `.claude/agents/*.md` and `.claude/skills/shipline-*/**`;
- two virtual entries for parts of shared files:
  - `CLAUDE.md#shipline`: the text between the markers;
  - `.claude/settings.json#shipline`: Shipline's hook entries plus its allow rules, written as canonical JSON.

Team-owned files (`.shipline/config.yml`, `.shipline/workflows/*.yml`, `.shipline/rules/*.md`) are **not** tracked. `upgrade` never replaces them; it only makes the targeted edits listed under C, shown in the preview.

**What each entry holds:** the hash of what Shipline last wrote to that file.
- Added or replaced by `init` or `upgrade`: the hash of the new content.
- Skipped because the team edited it: the previous hash is kept, so the next `upgrade` still sees the edit and skips it again.
- Replaced with `--force`: the hash of the new content.

### Interface change

- `INTERFACE` goes from 2 to 3.
- **What makes this an interface change:**
  - the state, manifest and UI paths move;
  - the config keys are removed;
  - `VERSION` gains `files`.
- **How the UI handles an interface-2 repo:**
  - It shows a banner: "Task data is still stored in this repo. Run `npx @forgeyard/shipline upgrade` to move it to ~/.shipline."
  - It reads tasks from the old `artifact_root` (default `docs/shipline`) and state from `.shipline/.state/`, read-only.
  - **Chat is disabled** until the repo is upgraded: the Chat view shows the upgrade banner and the command. Starting or continuing a chat returns 423 `needs-upgrade`. (The old hooks write state to `.shipline/.state/`, which the new chat code no longer reads.)

### API

- **`GET /api/tasks`:** each task's `dir` becomes the absolute path of its store folder.
- **`GET /api/file`:**
  - It accepts paths inside the repo root, the same as today.
  - It also accepts absolute paths inside this repo's store `tasks/` folder.
  - Anything else gets 400 `bad-path`. The path is realpath-checked, as today.
- **`GET /api/status`:** gains `storeDir`, and `needsUpgrade` (true when the repo's interface is below 3).
- **Chat routes** (`POST /api/chats`, `/message`, `/continue`): return 423 `needs-upgrade` when `needsUpgrade` is true.

### Settings (`.claude/settings.json`)

`init` and `upgrade` add these entries to `permissions.allow`, leaving existing entries alone and adding no duplicates:
- `Read(~/.shipline/**)`
- `Edit(~/.shipline/**)`

## Files to Touch

### A. npm rename and publishing

- `packages/cli/package.json` (**modify**):
  - name becomes `@forgeyard/shipline`;
  - version becomes `0.7.0`;
  - add `publishConfig.access: public`, `repository`, `license` and `description`;
  - keep `bin.shipline`.
- `package.json` (**modify**): workspace filters change from `shipline` to `@forgeyard/shipline` (`test:cli` and similar).
- `.github/workflows/cli.yml` (**modify**): `--filter ./packages/cli` stays. Only the package-name references change, if there are any.
- `.github/workflows/publish.yml` (**create**):
  - **Trigger:** a `v*.*.*` tag push.
  - **Permissions:** `contents: read`, `id-token: write`.
  - **Steps:**
    1. Fail unless the tag equals `v` + the version in `packages/cli/package.json`.
    2. `pnpm install`.
    3. CLI tests.
    4. UI typecheck.
    5. `npm publish --access public --provenance` from `packages/cli`. `prepack` builds `ui-dist`.
  - **Auth:** `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}`.
- `packages/cli/bin/shipline.mjs` (**modify**): help text shows `npx @forgeyard/shipline …` and adds the `upgrade` command (see C).
- `packages/cli/src/init.mjs` (**modify**): the success message reads "set it up in the browser: `npx @forgeyard/shipline ui`" (other `init` changes are in B and C).
- `packages/cli/src/ui/repo.mjs` and `packages/cli/src/ui/server.mjs` (**modify**): the "repo newer" message uses `npx @forgeyard/shipline@<v> ui`.
- `packages/cli/src/setup-schema.mjs` (**modify**): any `npx shipline` text uses the new name (other schema changes are in B).
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**): the "Run `npx shipline init` first" text uses the new name (other changes are in B).
- `packages/cli/templates/claude-md-section.md` (**modify**): uses the new name, and moves to the store wording in B.
- `packages/cli/templates/claude/skills/shipline-setup/SKILL.md` (**modify**): uses the new name, and drops `artifact_root` and `folder_pattern` from the questions it asks.
- `packages/plugin/commands/init.md` (**modify**): runs `npx --yes @forgeyard/shipline init`, with `allowed-tools` updated to match.
- `packages/plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (**modify**): descriptions name `@forgeyard/shipline`.
- `packages/ui/src/lib/api.ts`, `packages/ui/src/components/banners.tsx` and `packages/ui/vite.config.ts` (**modify**): user-facing `npx shipline` text uses the new name.
- `README.md` (**modify**): every install and run command uses `npx @forgeyard/shipline`. Add a short "Install" section above the hub documentation (the full README rewrite is Phase 5).
- `docs/plans/shipline-v2-repo-init.md` (**modify**): add a note under Status saying the package is now `@forgeyard/shipline`.

### B. Task storage outside the repo

- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**):
  - **Add:**
    - `encodePath(p)`;
    - `storeDir(root)`, which reads `SHIPLINE_HOME` or uses `~/.shipline`, creates the directory and runs the `repo.json` guard;
    - `tasksDir(root)` and `stateDir(root)`.
  - **Change:**
    - `statePath` and `manifestPath` resolve inside the store;
    - `listOpenTasks` scans `tasksDir`;
    - task `dir` values become absolute store paths.
  - **Remove:** the `artifact_root` and `folder_pattern` defaults from `DEFAULT_CONFIG`.
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**):
  - `start` creates the task in `tasksDir/<key>-<slug>`, or `<slug>` without a ticket, and drops the `folder_pattern` fill;
  - `resume <task>` accepts a folder name or an absolute store path;
  - output prints the absolute task path.
- `packages/cli/templates/shipline/bin/guard.mjs` (**modify**):
  - remove the "writes under `artifact_root` are allowed" exemption (store writes are outside the repo and were already ignored);
  - `{artifact_root}` in `allow_paths` becomes an empty, never-matching pattern, so old workflows keep loading;
  - the lost-task warning uses the store.
- `packages/cli/templates/shipline/bin/session-start.mjs` and `prompt-submit.mjs` (**modify**): read state and tasks from the store. The output text is unchanged, except that task paths are now absolute.
- `packages/cli/templates/shipline/config.yml` (**modify**): remove `artifact_root` and `folder_pattern` and their comment lines.
- `packages/cli/templates/shipline/workflows/feature.yml` and `bugfix.yml` (**modify**): remove `allow_paths: ["{artifact_root}/**"]` and update the header comment.
- `packages/cli/templates/shipline/gitignore` (**delete**): nothing is written to `.shipline/.state/` any more. `init` stops creating `.shipline/.gitignore`, and `upgrade` leaves existing copies alone.
- `packages/cli/templates/shipline/rules/pr.md` (**modify**): add "Summarize the plan and the verification result in the PR description. Don't link task files; they're local."
- `packages/cli/templates/claude-md-section.md`, `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` and `packages/cli/templates/claude/agents/planner.md` (**modify**): replace the "task folder in `docs/shipline/…`" wording with "the task folder that `stage.mjs` prints (outside the repo, under `~/.shipline`)".
- `packages/cli/templates/settings-hooks.json` (**modify**): add `permissions.allow` with `Read(~/.shipline/**)` and `Edit(~/.shipline/**)`.
- `packages/cli/src/init.mjs` (**modify**):
  - merge the allow rules into `.claude/settings.json` without duplicates;
  - stop copying `gitignore`;
  - write the `files` hash map into `VERSION`, computed on the content actually written.
- `packages/cli/src/interface.mjs` (**modify**):
  - `INTERFACE = 3`;
  - `readRepoVersion` returns `files`;
  - add a "store" entry for interface 3 to `MISSING_BEFORE`.
- `packages/cli/src/setup-schema.mjs` (**modify**):
  - remove `artifact_root` and `folder_pattern` from `KNOWN_FIELDS`, the validation and `configLayout`;
  - when they're still present (interface 2), they are kept as unknown keys.
- `packages/cli/src/ui/tasks.mjs` (**modify**):
  - list tasks from the store, or from the old `artifact_root` for an interface-2 repo, read-only;
  - `/api/file` allows the store `tasks/` folder.
- `packages/cli/src/ui/watch.mjs` (**modify**):
  - watch the store `tasks/` and `state/` folders instead of `artifact_root` and `.shipline/.state`;
  - the repo-tree watch no longer needs to ignore `.shipline/.state`, but keep ignoring it for interface-2 repos.
- `packages/cli/src/ui/sessions.mjs`, `chat.mjs`, `log.mjs` and `git.mjs` (**modify**):
  - `sessions.json`, `lock.json`, `mcp-*.json`, `ui.log` and the temp files move to the store's `ui/` folder;
  - `chat.mjs` watches `state/<id>.json` in the store.
- `packages/cli/src/ui/chat-routes.mjs` (**modify**): return 423 `needs-upgrade` for chat start, message and continue when the repo's interface is below 3.
- `packages/ui/src/pages/chat/chat-page.tsx` (**modify**, also listed below): when `needsUpgrade` is true, show the upgrade banner and command in place of the chat.
- `packages/cli/src/ui/diagnostics.mjs` (**modify**): `/api/status` and diagnostics report `storeDir` and `needsUpgrade`.
- `packages/ui/src/lib/types.ts` (**modify**): add `Status.storeDir` and `Status.needsUpgrade`, and note that `Task.dir` is absolute.
- `packages/ui/src/components/banners.tsx` (**modify**): show the upgrade banner when `needsUpgrade` is true.
- `packages/ui/src/pages/setup/config-form.tsx` (**modify**): remove the `artifact_root` and `folder_pattern` fields.
- `packages/ui/src/components/task-panel.tsx`, `packages/ui/src/components/app-sidebar.tsx`, `packages/ui/src/lib/queries.ts` and `packages/ui/src/pages/chat/chat-page.tsx` (**modify**):
  - artifact links pass the absolute store path to `/api/file`;
  - task matching uses `dir` as an opaque id.

### C. `shipline upgrade`

- `packages/cli/src/upgrade.mjs` (**create**): `runUpgrade({ target, yes, dryRun, force })`.
  1. **Check versions:**
     - repo newer than the CLI → refuse;
     - same interface and every file up to date → "Already up to date";
     - no `.shipline/` → "run init".
  2. **Build the file plan.** For each Shipline-owned file in the new templates:
     - **missing** → add;
     - **unedited** → replace. Unedited means its hash matches `VERSION.files`, or matches any hash in `known-hashes.json` for that path when `VERSION.files` is missing;
     - **edited** → shown as a diff and skipped, unless `--force`;
     - **a Shipline file the new version removes** → delete only if it's unedited.
  3. **Plan the shared files:**
     - the `CLAUDE.md` block is replaced if its text hash matches the record, otherwise diffed and skipped;
     - the settings hook entries and allow rules are re-merged. Shipline's own entries are replaced and other entries are left alone.
  4. **Plan the config and workflows:**
     - `config.yml` drops `artifact_root` and `folder_pattern`, written through `emitConfig` so the team's other content is kept;
     - each workflow that has an `{artifact_root}` allow_path gets that entry removed, through `emitWorkflow`.

     Both are shown in the preview.
  5. **Plan the migration** (interface below 3):
     - each task folder under the old `artifact_root`, and each `.shipline/.state/*.json`, goes to the store;
     - `.shipline/.state/ui/*` goes to the store's `ui/`.
     - **Folder names are kept as they are** (even ones made by a custom `folder_pattern`); only new tasks use `{key}-{slug}`.
     - **Paths are rewritten:** each moved state file's `task_dir` (today repo-relative, for example `docs/shipline/LL-12-export`) is set to the task's absolute store path. Manifests don't store their own path and need no change. `ui/sessions.json` entries' `task_dir` are rewritten the same way.
  6. **Preflight:**
     - stop with a list of the problems if any task folder has uncommitted or untracked changes (`git status --porcelain -- <dir>`), or if a target store folder already exists;
     - list sessions whose state was modified in the last 30 minutes, and whether a UI chat lock is held, as a warning.
  7. **Print the preview:** files to add, replace, skip (with diff) and remove; config and workflow diffs; tasks to move; warnings. Then:
     - `--dry-run` → exit 0;
     - otherwise prompt y/N, which `--yes` skips. Without a TTY and without `--yes`, it refuses.
  8. **Apply,** in this order: copy tasks and state to the store and verify each copy by hash; write the files; `git rm -r -q` the old task folder (staged, not committed); remove `.shipline/.state/` from disk; write `VERSION` last (interface 3, new `files` map).
     - If anything fails before `VERSION` is written, the store copies are left in place, no repo file is deleted, and the error names the step.
  9. **Print next steps:** commit the changes, and restart any Claude sessions.
- `packages/cli/src/known-hashes.json` (**create**): `{ "<template path>": ["sha256", …] }` for every released template version. Seed it with:
  - the 0.3.x copies vendored in `/Users/siddharth/Projects/pocs/brown-bg-tracker` (`.shipline/bin/*`, `.claude/agents/*`, `.claude/skills/*`, workflows, rules, config) and its `CLAUDE.md` block;
  - the current templates at 0.6.0, read from git at commit `a67ddf6`.
- `packages/cli/scripts/hash-templates.mjs` (**create**): appends the current templates' hashes to `known-hashes.json` under the package version. Run it before each release; the publish workflow also checks that it was run.
- `packages/cli/src/hashes.mjs` (**create**): shared helpers used by `init` and `upgrade`:
  - `sha256(text)`;
  - `canonicalSettingsPart(settings)`, which returns Shipline's hook entries and allow rules as sorted JSON;
  - `claudeMdBlock(text)`.
- `packages/cli/bin/shipline.mjs` (**modify**): add `upgrade [dir] [--yes] [--dry-run] [--force]`.
- `packages/cli/src/init.mjs` (**modify**): use `hashes.mjs` for the `files` map (the rest of `init` is in B).

### Tests

- `packages/cli/test/helpers.mjs` (**modify**): every temp repo gets its own `SHIPLINE_HOME` temp dir, which is removed afterwards.
- `packages/cli/test/ui/chat-helpers.mjs` (**modify**): the same, and the fake claude's state goes to the store.
- `packages/cli/test/guard-lost-task.test.mjs`, `session-start.test.mjs`, `init-version.test.mjs`, `setup-schema.test.mjs` and `yaml-emit.test.mjs` (**modify**): update for store paths, the removed config keys and the `VERSION.files` map.
- `packages/cli/test/ui/auth.test.mjs`, `setup.test.mjs`, `tasks.test.mjs`, `chat.test.mjs` and `transcript.test.mjs` (**modify**): store paths, `/api/file` on store paths, `needsUpgrade`, and chat routes returning 423 `needs-upgrade` on an interface-2 repo.
- `packages/cli/test/fixtures/yaml/*` and `fixtures/yaml/expected/*` (**modify**): drop `artifact_root` and `folder_pattern` from the config fixtures, and keep one fixture that still has them for the "kept as unknown key" case.
- `packages/cli/test/fixtures/streams/stage-start.jsonl` and `fixtures/sessions/session.jsonl` (**modify**): use store paths.
- `packages/cli/test/fixtures/session-start/session-start.v1.mjs` (**unchanged**): a historical copy.
- `packages/cli/test/store.test.mjs` (**create**):
  - `encodePath` gives the same result as `transcript.mjs`;
  - `SHIPLINE_HOME` is honoured;
  - the `repo.json` collision check;
  - after a Feature task in a fresh `init`, `git status` shows no Shipline task files.
- `packages/cli/test/upgrade.test.mjs` (**create**):
  - repo newer → refused;
  - already up to date;
  - unedited files replaced;
  - edited files skipped, and replaced with `--force`;
  - a legacy repo with no `files` matched through `known-hashes.json` (use a copy of brown-bg-tracker's vendored files as a fixture under `test/fixtures/legacy-0.3/`);
  - migration moves tasks and state, verifies hashes and stages `git rm`;
  - stops on uncommitted task changes and on a name clash in the store;
  - session warning;
  - `--dry-run` writes nothing;
  - no TTY without `--yes` → refused;
  - `VERSION` is written last, so a simulated failure leaves the repo files untouched;
  - after migration, a session bound to a task (state with a repo-relative `task_dir`) has an absolute store path and `stage.mjs status` still finds the task; migrated folder names are unchanged;
  - running `upgrade` twice: the second run reports "Already up to date"; a team-edited Shipline file is skipped on both runs; `config.yml`, workflows and rules never appear in `VERSION.files`;
  - config and workflow keys removed while team content is kept.
- `packages/cli/test/fixtures/legacy-0.3/` (**create**): a snapshot of brown-bg-tracker's Shipline files (`.shipline/`, `.claude/agents`, `.claude/skills/shipline-*`, `CLAUDE.md`, `.claude/settings.json`), with no task data.
- `packages/cli/test/publish.test.mjs` (**create**):
  - `package.json` name, `bin` and `files` are correct;
  - `npm pack --dry-run` includes `ui-dist/index.html`, the templates and `src/known-hashes.json`;
  - no file in the package refers to an unscoped `npx shipline`.

## Behavior & Edge Cases

- **No `SHIPLINE_HOME` and no writable home directory:** hooks fail open with a visible `systemMessage` ("Shipline can't write its task store at <path>"), following the existing `failOpen` pattern. `init`, `upgrade` and `ui` exit 1 with the same message.
- **`SHIPLINE_HOME` set to somewhere other than `~/.shipline`:** the committed allow rules don't cover it, so Claude asks for permission on artifact writes. This is documented in the README and accepted.
- **Repo moved or renamed:** the store key changes, so the tasks appear to be gone. The old store folder stays on disk. Out of scope for Phase 1, and noted in the README.
- **Two clones or worktrees of the same repo:** each has its own store, like Claude's chats.
- **Encoding collision:** stopped by the `repo.json` guard.
- **A Claude session running during `upgrade`:** it is warned about and its state is moved. Its next hook call finds the state in the store, because the hooks read the store as soon as `bin/` is updated, which happens in the same `upgrade`. If the session was bound to a task, it may need `stage.mjs resume`, and the lost-task warning will say so.
- **An interface-2 repo opened in the new UI:** an upgrade banner, plus old tasks read from the repo, read-only. Saving the setup still works (the config keeps `artifact_root` as an unknown key). Chat is disabled until the upgrade.
- **An interface-3 repo opened by an older UI (0.6.0):** already handled. The repo is newer, so the old UI refuses to save and points at `npx @forgeyard/shipline@0.7.0 ui`.
- **`upgrade` on a repo with no `docs/shipline`:** the migration step is skipped.
- **A custom `artifact_root`:** the migration reads it from `config.yml` before removing it.
- **A non-git repo:** `git rm` and the uncommitted-changes check are skipped. The old folder is deleted after the copy is verified, and the preview says so.
- **Publishing:**
  - the tag/version mismatch check fails the job;
  - a missing `NPM_TOKEN` fails at publish with npm's error;
  - re-publishing an existing version fails at npm, and the job reports it.

## Constraints

- **Node versions:** the vendored hooks stay dependency-free on Node 18. `ui` needs Node 20; `upgrade` and `init` need Node 18.
- **Untested assumption:** that Claude Code honours `~/`-prefixed `Read` and `Edit` allow rules in a project's `.claude/settings.json`. The brown-bg-tracker success criterion checks this. If it turns out to be false, stop and revisit the decision about how artifacts are written; options include writing them through `stage.mjs`.
- **No deletion before verification:** nothing in the repo is deleted before its copy in the store has been verified by hash.
- **`upgrade` never commits.** It only stages.
- **The publish workflow** has `id-token: write` for npm provenance. The author adds the `NPM_TOKEN` secret, a granular token with publish rights on `@forgeyard`.

## Verification

1. `cd packages/cli && npm test`, all green. CI passes on Node 18 and 20, on Linux and macOS.
2. **Fresh install:**
   1. `git init` a temp repo.
   2. Run `init` from the local build.
   3. Run a Feature task through two stages in Claude Code.
   4. `git status` shows only the files `init` installed.
   5. `~/.shipline/projects/<encoded>/tasks/<slug>/` holds `manifest.json` and the artifacts.
   6. There were no permission prompts for artifact writes.
3. **brown-bg-tracker:**
   1. `shipline upgrade --dry-run`: check the preview lists the file replacements, any skipped edited files, the config and workflow key removals, and the tasks to move.
   2. `shipline upgrade`: check the tasks are in the store, `git status` shows `docs/shipline` staged for deletion, `.shipline/.state/` is gone, and `VERSION` shows interface 3 with `files`.
   3. Open `shipline ui`: the tasks show up, and the chat writes an artifact to the store with no prompt.
4. **Old repo in the new UI:** before the upgrade, open brown-bg-tracker in the new `shipline ui`. The upgrade banner shows, and the old tasks are listed.
5. **Publishing:**
   1. Locally, `npm pack --dry-run` in `packages/cli` lists `ui-dist`, the templates and `known-hashes.json`.
   2. Push the tag `v0.7.0`; the workflow publishes.
   3. `npx @forgeyard/shipline@0.7.0 --help` works on a clean machine or in a container.

## Open Questions

- **The `~/` allow rules:** does Claude Code honour them in project settings? If not, the artifact-write decision needs revisiting (see Constraints). Verified by success criterion 1.
- **Intermediate versions:** `known-hashes.json` can only be seeded with 0.3.x (from brown-bg-tracker) and 0.6.0 (`a67ddf6`). Repos initialized from 0.4.0 or 0.5.0 checkouts will see their files as edited. No such repos are known apart from local test sandboxes, so this is accepted.
- **First publish:** it needs the `NPM_TOKEN` secret added by the author. The version will be `0.7.0`.
- **Accepted from the plan re-review (optional items, not blocking):**
  - **Publish workflow:** how it checks that `hash-templates.mjs` was run is unspecified. Builder default: fail the job if `known-hashes.json` has no entry for the version being published.
  - **Seeding `known-hashes.json`:** it relies on the local brown-bg-tracker checkout and commit `a67ddf6`. The author's machine has both; the seed is generated once and committed.
  - **Non-task files under `artifact_root`:** files other than task folders (for example a README in `docs/shipline/`) aren't covered. Builder default: leave them in place and list them in the preview.
  - **A failure after `git rm`:** the removal stays staged. The error message must say so and tell the developer to run `git restore --staged <dir>` to undo it.
  - **The `~/` allow-rule fallback is vague:** if success criterion 1 shows the rule isn't honoured, stop and re-plan the artifact-write approach instead of improvising.
