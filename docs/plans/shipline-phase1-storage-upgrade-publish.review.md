# Re-review: shipline-phase1-storage-upgrade-publish

## 1. Verdict

Ready to build. 0 must-fix items.

All three earlier must-fix items are closed:
1. Closed. State `task_dir` and `sessions.json` `task_dir` rewriting is specified (C step 5), and migrated folder names are kept (C step 5). A test covers it.
2. Closed. Chat is disabled (423 `needs-upgrade`) for interface-2 repos. The routes, banner and `needsUpgrade` status are all specified.
3. Closed. The "Interface 3 `VERSION`" section defines what each `files` entry holds. Team-owned files are untracked, and skipped files keep their old hash.

## 2. Paraphrase

**What the plan proposes.** Rename the package to `@forgeyard/shipline` (0.7.0) and publish it from a `v*.*.*` tag workflow with a tag/version check. Move all task data (manifests, artifacts, session state, UI data) out of the repo into `$SHIPLINE_HOME/projects/<encoded repo path>/`. The encoding is the same as Claude's, and a `repo.json` guard catches collisions. `init` adds `Read` and `Edit` allow rules for `~/.shipline/**`. Add `shipline upgrade`. It uses a per-file hash map in `VERSION` (interface 3), with `known-hashes.json` as a fallback for old repos. It replaces unedited Shipline files, diffs and skips edited ones (unless `--force`), and removes `artifact_root` and `folder_pattern` from config and workflows. It migrates tasks and state into the store with rewritten paths, stages `git rm` of the old folder, and writes `VERSION` last. The UI shows an upgrade banner for interface-2 repos, reads their old tasks read-only, and disables chat.

**How the system works today, according to the plan.** `init` copies hooks, rules, workflows, agents and skills into the repo and refuses to run on an already-installed repo. Tasks live in `docs/shipline/<task>/` (set by `artifact_root` and `folder_pattern`). Session state and UI data live in gitignored `.shipline/.state/`. Hooks read these paths through `lib.mjs`. The UI server reads tasks and state from there, and `/api/file` serves only paths inside the repo. `VERSION` holds only package and interface numbers. `transcript.mjs` already uses Claude's path encoding. The npm name `shipline` belongs to someone else.

## 3. Must-fix

None.

## 4. Optional (non-blocking)

- Publish workflow: "also checks that `hash-templates` was run" does not say how. A builder will probably check that `known-hashes.json` has an entry for the package version, but this is a guess. Also, `actions/setup-node` with `registry-url` and the pnpm setup are not mentioned. Both are routine.
- Seeding `known-hashes.json` uses a local absolute path (`/Users/siddharth/Projects/pocs/brown-bg-tracker`) and git commit `a67ddf6`. A builder on another machine can't do the first one. Say whether the author supplies the 0.3.x hashes or the builder is expected to run a script.
- Everything under `artifact_root` is treated as task folders, and `git rm -r` removes it. If non-task files live there, they are migrated or removed without being mentioned. A one-line statement would remove the guess.
- A failure after `git rm` and before `VERSION` leaves the removal staged. The plan says only that the store copies stay and "no repo file is deleted", which is not quite true at that point. Say that the staged removal is left as is.
- The `~/` allow-rule assumption is unverified. The fallback ("options include writing through `stage.mjs`") is vague. Consider a 5-minute manual check before building.
- A custom `SHIPLINE_HOME` is documented as causing permission prompts. Fine.

## 5. Files-to-touch check

- All "modify" paths I checked exist. This covers `packages/cli/src/*`, `src/ui/*`, `templates/**` (including `templates/shipline/gitignore`, which is to be deleted), the test files and fixtures named, `packages/ui/src/...` (`app-sidebar`, `banners`, `task-panel`, `api.ts`, `queries.ts`, `types.ts`, `chat-page.tsx`, `config-form.tsx`), and `.github/workflows/cli.yml`.
- `cli.yml` already has the Node 18 and Node 20 jobs, each on ubuntu and macOS. Success criterion 3 is covered without changes.
- `packages/cli/src/ui/setup.mjs` has no `artifact_root` or `folder_pattern` references (checked). Its omission from the list is fine. The three source files that do reference them (`setup-schema.mjs`, `tasks.mjs`, `watch.mjs`) are all listed.
- Not individually verified: `packages/plugin/*`, `.claude-plugin/*`, `README.md`, the root `package.json` and `docs/plans/shipline-v2-repo-init.md`. These are likely present.
- Create paths (`upgrade.mjs`, `hashes.mjs`, `known-hashes.json`, `scripts/hash-templates.mjs`, `publish.yml`, the new tests, `fixtures/legacy-0.3/`) don't exist yet, as expected.
