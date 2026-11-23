# Review: shipline-2-2-0-cli-store-hygiene (Plan E)

## 1. Verdict

**Ready after must-fixes** (5 must-fix items).

## 2. Paraphrase

**What the plan proposes.** Replace the store folder key (today `encodePath(realpath)`, which collides and can exceed filename limits) with `<last 80 chars of encoded path>-<10-char sha256>`. The key is computed from the main checkout of a git repo, so every linked worktree shares one store, while config and workflows still come from the current checkout. Existing stores are migrated lazily, by renaming on first resolve. A main checkout's old folder is renamed. A worktree's old folder is merged task by task into the shared store and then renamed `.migrated-<date>`. The CLI and UI choose old or new scheme by the repo's installed INTERFACE (2 or higher gets the new scheme), so 2.1 hooks don't split the store. Around that it adds `shipline prune` (delete stores of vanished repos), `shipline relink --from <old>` (move a store to a moved repo), a subfolder/monorepo warning at init plus package-manager detection from the git root, per-file upgrade conflict prompts (`.shipline-new` side files under `--yes`), a help overhaul, docs fixes, and publish-workflow guards (tag on main, merged PR's `ci` check green, per-tag concurrency).

**How the existing system works, according to the plan.** `lib.mjs` is vendored into each repo's `.shipline/bin`, and the CLI and UI re-export it through `src/store.mjs`. `storeDir(root)` creates `~/.shipline/projects/<encodePath(realpath)>/` and writes or validates `repo.json`, throwing `STORE_COLLISION` if it names another root. Plan A (INTERFACE 2, bin upgraded as a unit) and Plan D (cwd-first `findRoot`, per-task ownership, branch-filtered listing) are prerequisites. Upgrade replaces unedited files and skips edited ones unless `--force`. `publish.yml` publishes any `v*.*.*` tag after tag/changelog/hash checks and tests. CI runs only on PRs, with one required `ci` check.

## 3. Must-fix

1. **E1 lazy-migration trigger is wrong for worktrees (and for a store first created by a worktree).** The plan migrates "when `storeDir` resolves a new key whose folder doesn't exist". Two cases skip migration:
   - The main checkout migrated first. The new folder now exists, so a worktree's old per-worktree store is never looked at and its tasks stay stranded.
   - A worktree resolves first. `storeDir` creates the new folder fresh, so the main checkout's old store is never renamed in. The rename then fails or is skipped, and the store is split.
   - Fix: define migration as "old-scheme folder for this root or this worktree exists, has a matching `repo.json.root`, and has not yet been migrated". Check this on every resolve until a marker exists, and say how a main-checkout store merges into an already-created, empty new folder.

2. **E1 interface guard: no API is specified.** Nothing says how the scheme choice reaches `storeDir`. `storeDir(root)` is called from hooks, `guard.mjs`, `stage.mjs`, `install.mjs:683`, `ui/server.mjs`, `ui/projects.mjs` and `ui/diagnostics.mjs`, all with a single argument. "Interface-aware scheme helper exported for the CLI/UI" does not give the builder a signature. Decide:
   - whether `storeDir(root, { scheme })` or a separate `storeDirFor(root, interface)` is added;
   - what the default is for the vendored hooks (presumably always new);
   - which CLI and UI call sites must pass the scheme;
   - how `init` (new repo) and `upgrade` (1 to 2 transition) behave, and when migration runs during `upgrade`.
   - Fix: add a short signature and call-site list. Also state that `ui/transcript.mjs` and its `encodePath` stay unchanged, because that is Claude Code's own project-folder encoding and not the store key.

3. **Worktrees on branches that still carry 2.1 hooks.** A linked worktree checks out its own `.shipline/bin`. Any worktree on a branch created before the upgrade is merged still runs 2.1 hooks and writes to its old per-worktree key. The plan's guard only covers the UI and CLI, and the "hooks ≥ 2.2.0 after upgrade" claim holds only per checkout. This silently re-splits the store and leaves the old worktree store unmigrated. Say what happens (warn in `status`/session-start when a worktree's interface is 1 and the main store is v2? tell the user to merge or rebase main?). At minimum, document the limitation and the expected behaviour.

4. **E3 prune can delete live shared tasks.** The test is `repo.json.root` (the main checkout) no longer existing. If the main checkout is moved or deleted while linked worktrees still exist, prune removes a store that active worktrees still use. It would also remove the registry entries of those worktrees. Fix: also treat a store as live if any registered worktree entry for that main root still exists. Alternatively, state that this case is out of scope and warned about. Also state how age is measured for `*.migrated-*` ("older than 30 days"), either from the date in the name or from mtime.

5. **E6 scope is ambiguous with shared (non-file) items.** `planShared` in `upgrade.mjs` also handles the CLAUDE.md block, `settings.json` and the CI workflow. These are "edited" and skipped today, but `.shipline-new` side files make no sense for a CLAUDE.md block or a settings fragment. The plan says "edited files outside `.shipline/bin/`" without saying whether these are included. It also doesn't cover:
   - files that are "no longer shipped" and edited (`removed` skips);
   - `upgrade --all` (`runUpgradeAll`), which would prompt per file across many repos.
   - Fix: list which edit-conflict types get the four-way prompt and which keep today's skip/`--force` behaviour. Say what `upgrade --all` does with prompts (probably per repo, in sequence).

## 4. Optional (non-blocking)

- **E4 relink on a non-empty target.** `storeDir` auto-creates the new store folder, so the target usually exists and is empty. Say that relink removes or merges into an empty folder instead of failing a rename. Also say what happens when the moved repo is still at interface 1 (old key) and which key relink targets.
- **Fingerprint/guard use.** `guard.mjs` calls `isProtectedStorePath(storeDir(root), ...)`. Confirm the protection covers the migrated and shared store. It should be fine, but it is not mentioned.
- **Migration cost.** `git rev-parse` runs once per process, which is fine. The old-folder lookups would now run on every resolve (see must-fix 1). Say they are cached after the first success.
- **E9.** `gh api` in Actions needs `GH_TOKEN: ${{ github.token }}` in `env`. State it. `commits/{sha}/pulls` can return several PRs, so say which one to pick (the merged one with base `main`). A squash-merged PR gets a different SHA than its head, which the plan handles correctly by reading the PR's head SHA.
- **E9 rollout.** Say whether the hotfix flow in the hotfix plan also tags from `main` only. Otherwise the guard could block a hotfix release.
- **E7.** `help` prints every command's help. Keep it from becoming very long, or say it is fine.
- **Tests.** Add one for the two migration orders in must-fix 1.

## 5. Files-to-touch check

- Existing paths confirmed: `templates/shipline/bin/lib.mjs`, `src/store.mjs`, `registry.mjs`, `init.mjs`, `detect-commands.mjs`, `upgrade.mjs`, `uninstall.mjs`, `interface.mjs`, `known-hashes.json`, `bin/shipline.mjs`, `.github/workflows/publish.yml`, the docs and CONTRIBUTING/README, and the test files named (`store`, `uninstall`, `upgrade`, `cli`, `init-interactive`, `install`, `detect-commands`, `publish`).
- Create targets `prune.mjs`, `relink.mjs`, `store-worktree.test.mjs`, `prune.test.mjs` and `relink.test.mjs` don't exist yet, as expected.
- **Missing from the list:**
  - `packages/cli/src/install.mjs` (calls `storeDir` at line 683; init is where the scheme and interface for a new repo is decided).
  - `packages/cli/src/ui/server.mjs` and `ui/diagnostics.mjs` (both call `storeDir`).
  - `packages/cli/src/uninstall.mjs` is listed. Its `encodePath(real)` store lookup at line 26 must use the new helper, and it also needs the old-key fallback for interface 1 repos.
  - `ui/projects.mjs` is listed as "only if", but it calls `storeDir` itself (line 139). It is not a conditional change; check it.
  - `packages/cli/templates/shipline/bin/guard.mjs` or `stage.mjs`, only if the `storeDir` signature changes.
  - A test for a `mainRoot` submodule fallback (named in Open Questions) is not in the test list.
