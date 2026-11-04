# Cleanup and rollout: remove the hub, a CLI-first README, Windows support

**Status:** Approved
**Roadmap:** `docs/plans/shipline-adoption-roadmap.md`, Phase 5, minus metrics. This is the first of three remaining plans; the other two are *Trust* and *Chat reliability*.
**Branch:** a new branch from `main` (`b024e21`), for example `feat/cleanup-rollout`.

## Problem & Goal

The product is now the CLI (`@forgeyard/shipline`: `packages/cli` plus `packages/ui`). The repo still carries the retired v1 hub, and that causes three problems:

- **Install weight.** `pnpm install` builds Prisma, Electron and node-pty.
- **A misleading README.** Most of it documents Postgres, Google SSO and a GitHub App.
- **Clutter.** About 250 hub files sit next to the CLI.

Separately, Shipline has never run on Windows, which many teams in an organization use.

**Goals:**
1. The repo contains only the CLI product: `packages/cli`, `packages/ui`, docs and CI.
2. A README written for teams adopting Shipline, from install to uninstall, with screenshots.
3. Full Windows support for:
   - `init`, `upgrade` and `uninstall`;
   - the hooks and `stage.mjs`;
   - `shipline ui`, including stopping a chat.

   Windows is proven by CI on `windows-latest`.

**Done when** (author's criteria):
- **Clean install:** after a fresh clone, `pnpm install` installs no Prisma, Electron or node-pty, and the repo holds only `packages/cli`, `packages/ui`, docs and CI.
- **README read-through:** the author can follow the new README from install to uninstall.
- **CI green, including Windows:** all jobs pass, including the new `windows-latest` jobs.

## Scope

### In

**A. Remove the hub**
- **Delete:** `apps/api`, `apps/web`, `apps/local`, `packages/shared`, `packages/plugin` (the `/shipline:init` Claude Code plugin), `.claude-plugin/marketplace.json` and `turbo.json`.
- **Root config:**
  - drop the hub scripts and turbo;
  - the workspace becomes `packages/*` only;
  - `onlyBuiltDependencies` keeps only `esbuild`, which Vite needs;
  - `.gitignore` loses the hub entries;
  - the lockfile is regenerated.
- **Old docs:** `docs/plans/shipline-v1.md` and `docs/plans/shipline-guardrails-templates.md` stay, each with a one-line note at the top: "Historical: describes the v1 hub, which was removed in <commit>."
- **Code comments** in `packages/cli/src/ui/*.mjs` that say "copied from `apps/local/…`" now say "ported from the v1 hub (removed)". Behaviour is unchanged.

**B. A CLI-first README** (`README.md`, rewritten). It's written for teams adopting Shipline. The sections, in order:
1. **What Shipline is:** a few lines on the workflow, stages, guardrails and the browser UI.
2. **Requirements:**
   - Node 18+ for the hooks, `--yes` installs, `upgrade` and `uninstall`;
   - Node 20+ for `shipline ui`;
   - Node 20.17+ for interactive `init`;
   - Claude Code, and git.
3. **Install:** `npx @forgeyard/shipline init` (interactive) or `init --yes`. What gets added to the repo, what to commit, and that task data lives in `~/.shipline`.
4. **Daily use:** how Claude picks a workflow (Feature, Bugfix, Hotfix, Small change), the stages, and what `guide`, `warn` and `block` do. Then `stage.mjs` basics.
5. **The browser UI:** `npx @forgeyard/shipline ui`, with the Chat, Setup (workflows, Agents & skills) and Tasks views.
6. **Configuration reference:** `config.yml` (`branch_pattern`, `commands`, `skills`), the workflow stage fields, rules files, `VERSION`, and `SHIPLINE_HOME`.
7. **Upgrade and uninstall:** with their flags.
8. **Troubleshooting:**
   - hook warnings;
   - "already initialized";
   - "repo newer";
   - a lost task;
   - Windows notes.
9. **Contributing:** repo layout, `pnpm install`, building the UI, tests (`npm test`, `test:hooks`), CI and releasing (tag `v*`, the `NPM_TOKEN` secret).

**Screenshots:** `docs/images/setup.png` and `docs/images/agents-skills.png`, copied from the author's screenshots. The chat screenshot is added later, once the author retakes it without the local path and the usage-limit messages.

**C. Windows support**
- **Stopping a chat:** `process.kill(-pid)` doesn't exist on Windows. There, the chat stops with `taskkill /PID <pid> /T` (kill the tree), then `taskkill /PID <pid> /T /F` after the existing 5 s. POSIX behaviour is unchanged.
- **Opening the browser:** `win32` uses `cmd /c start "" <url>` instead of the "open it yourself" message.
- **Diffing against nothing:** `git diff --no-index` keeps the literal `/dev/null`. Git recognises that name on every platform, including Windows. Changed during the build: Node's `os.devNull` is `\\.\nul` on Windows, which git doesn't accept.
- **Path handling:** an audit of every place that builds or compares paths, checking:
  - every `startsWith(root + path.sep)`, `split(path.sep)` and posix conversion;
  - the store path encoding for drive letters (`C:\…` becomes `C--…`, the same as Claude Code);
  - the `repo.json` comparison, which compares `realpath` results case-insensitively on `win32`;
  - the guard's repo-relative paths.
- **`chmod`:** on Windows it's a no-op and stays one. No permission errors are expected.
- **CRLF:** the YAML parser and writer, rules files and `CLAUDE.md` block handling must accept CRLF input. The writer keeps the file's existing line ending, and new files are written with `\n`.
- **Hook commands:** the hook command stays as it is, `node "$CLAUDE_PROJECT_DIR/.shipline/bin/<x>.mjs"`. This relies on Claude Code on Windows running hooks through Git Bash, which is unverified (see Open Questions).
- **CI:**
  - `.github/workflows/cli.yml` adds `windows-latest` to both matrices (`hooks` on Node 18, `cli + ui` on Node 20).
  - The Prettier step stays on Linux only.
  - The publish workflow stays on `ubuntu-latest`.
- **Tests:** POSIX-only tests may be skipped on `win32`, but each skip must give its reason and name the Windows-specific test that covers the same behaviour. Every skip is listed in this plan under Verification. The fake `claude` is started as `node fake-claude.mjs` on Windows, through a `.cmd` shim written by the test setup, because Windows ignores shebang lines.

### Out

- **Usage metrics:** dropped by the author. No `stats` command, no Stats view and no recording of guardrail hits.
- **The chat screenshot:** added later.
- **Publishing:** left out by the author for now.
- **Trust work:** enforcement, the CI gate and the orphaned process on POSIX chat stop. That's the next plan. Windows tree-kill is in this plan only because Windows needs some way to stop a chat at all.
- **Chat reliability:** the chat test, the `UNVERIFIED` items, Jira in `-p`, the Node preflight, and the doubled usage-limit message seen in the author's screenshot. That's the third plan.
- **A manual Windows check:** nobody has a Windows machine, so CI is the only Windows verification.

## Surface Area

- **Layers:** repo structure and root config, CI, docs, the CLI's Windows code paths (`chat.mjs`, `open-browser.mjs`, `git.mjs`, `tasks.mjs`, store and path helpers), and tests.
- **Data, API and config:** no changes to data shapes, the API or config. The package version stays 0.7.0, which is unpublished.

## Files to Touch

### A. Hub removal

- `apps/api/`, `apps/web/`, `apps/local/` (**delete**, whole directories): the v1 hub.
- `packages/shared/` (**delete**): used only by the hub.
- `packages/plugin/` (**delete**): the `/shipline:init` plugin. Its job is replaced by `npx @forgeyard/shipline init`.
- `.claude-plugin/marketplace.json` (**delete**): the plugin marketplace entry. Delete the `.claude-plugin/` directory if it ends up empty.
- `turbo.json` (**delete**).
- `package.json` (**modify**):
  - **Scripts:** keep only `build:ui`, `test:cli`, and a new `test` that runs `pnpm --filter ./packages/cli test`.
  - **Remove** the `build:shared`, `dev`, `dev:api`, `dev:web`, `dev:local`, `desktop` and `db:*` scripts.
  - **devDependencies:** remove `turbo`; keep `prettier` and `typescript`.
- `pnpm-workspace.yaml` (**modify**): `packages: ['packages/*']`, and `onlyBuiltDependencies: [esbuild]`.
- `pnpm-lock.yaml` (**modify**): regenerated with `pnpm install`.
- `.gitignore` (**modify**): remove `apps/local/plugin`, `apps/local/release` and any other hub-only entries. Keep `node_modules`, `dist`, `.env*`, `packages/cli/ui-dist` and `*.log`.
- `docs/plans/shipline-v1.md` and `docs/plans/shipline-guardrails-templates.md` (**modify**): add the "Historical" note under the title.
- `docs/plans/shipline-adoption-roadmap.md` (**modify**): mark Phase 5 as covered by this plan, minus metrics (dropped). Note that the rest of Phase 2 (Node preflight) and Phase 3 (Jira in chat) move into the Chat reliability plan, and that Trust is its own plan.
- `packages/cli/src/ui/auth.mjs`, `claude.mjs`, `git.mjs`, `stream.mjs`, `tasks.mjs`, `transcript.mjs`, `versions.mjs` and `watch.mjs` (**modify**, comments only): "copied from `apps/local/…`" becomes "ported from the v1 hub (removed)".
- `packages/cli/test/publish.test.mjs` (**modify**):
  - remove the checks that read `packages/plugin` and the marketplace file;
  - keep the "no unscoped `npx shipline`" check over `packages/cli`, `packages/ui/src` and `README.md`.

### B. README

- `README.md` (**modify**): rewritten with the sections in scope B. All commands use `npx @forgeyard/shipline`.
- `docs/images/setup.png` (**create**): copied from `~/Desktop/Screenshot 2026-11-04 at 9.10.29 PM.png`.
- `docs/images/agents-skills.png` (**create**): copied from `~/Desktop/Screenshot 2026-11-04 at 9.10.43 PM.png`.

### C. Windows

- `packages/cli/src/ui/chat.mjs` (**modify**):
  - **Starting Claude on Windows:**
    - when `process.platform === 'win32'` and the `claude` binary ends in `.cmd` or `.bat` (an npm install of Claude Code, or the test shim), start it with `shell: true` and `windowsHide: true`;
    - wrap the binary path and every argument in double quotes, with any `"` inside doubled. Node refuses to run `.cmd`/`.bat` files without a shell (`EINVAL`). The arguments are only flags, UUIDs and paths; your messages go through stdin;
    - a `.exe` binary is started directly, as on other platforms;
    - `detached: true` only off Windows.
  - **Stopping a chat (`killGroup`):**
    - on Windows, spawn `taskkill /PID <child.pid> /T` for the polite stop and `taskkill /PID <child.pid> /T /F` after the existing 5 s. `child.pid` is the shell when a `.cmd` was started, and `/T` takes down the `claude` process under it;
    - elsewhere it keeps `process.kill(-pid, signal)`.
- `packages/cli/src/ui/claude.mjs` (**modify**): on `win32`, `findClaude()` resolves `claude.exe`, `claude.cmd` or `claude.bat` on `PATH` (in that order). The health checks (`--version`, auth) use the same start rule as `chat.mjs`.
- `packages/cli/src/ui/open-browser.mjs` (**modify**): the `win32` case runs `cmd /c start "" <url>` with `windowsHide: true`.
- `packages/cli/src/ui/git.mjs` and `packages/cli/src/ui/tasks.mjs` (**modify**): the `--no-index` calls use a `GIT_NULL = '/dev/null'` constant, with a comment saying why not `os.devNull`.
- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**):
  - **`encodePath`: no change expected.** It already turns every non-alphanumeric character (including `:` and `\`) into `-`, so `C:\Users\x\repo` becomes `C--Users-x-repo`, the same rule `transcript.mjs` uses. Covered by a test only.
  - **New `sameRoot(a, b, platform = process.platform)`:** with `'win32'`, it compares `path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase()`; otherwise it's an exact match. `storeDir(root)` uses it to compare the stored `repo.json` `root` with the current `realpath`. `repo.json` keeps storing the real path unchanged.
  - **New `isInside(parent, child, platform = process.platform)`:** uses `path.win32` (both paths lowercased) when `platform === 'win32'`, and `path.posix` otherwise. It returns true when the relative path is `''`, or neither starts with `..` nor is absolute. Exported for the CLI. The platform parameter lets Windows behaviour be tested on any OS.
  - **New `detectEol(text)`:** returns `'\r\n'` if the first line break in `text` is `\r\n`, otherwise `'\n'` (including when there's no line break). A mixed file follows its first line break.
  - **`parseYaml`:** splits on `/\r?\n/` (it already does) and trims a trailing `\r`.
- `packages/cli/src/yaml-emit.mjs`, `packages/cli/src/hashes.mjs` (`claudeMdBlock`, `removeClaudeMdBlock`), `packages/cli/src/init.mjs` (`CLAUDE.md` block merge) and `packages/cli/src/ui/setup.mjs` (rules saves) (**modify**):
  - accept CRLF input;
  - build the output with `\n`, then, when an existing file is being rewritten, convert every line break once to `detectEol(existingText)`;
  - new files are always written with `\n`.
- **Path containment** (**modify**, replace with `isInside`):
  - `packages/cli/src/init.mjs:298` (the parent-is-a-file loop, `p.startsWith(root)`);
  - `packages/cli/src/uninstall.mjs:221` (`d.startsWith(root + path.sep)`);
  - `packages/cli/src/ui/tasks.mjs:329` (`abs.startsWith(t.dir + path.sep)`).
- **Audited, no change:** `packages/cli/templates/shipline/bin/guard.mjs:60–63` and `packages/cli/src/ui/server.mjs:98` already use `path.relative`, `startsWith('..')` and `isAbsolute`, which is correct on Windows. `packages/cli/src/upgrade.mjs` uses `split(path.sep)` only for relative names (posix conversion), which is fine.
- `.github/workflows/cli.yml` (**modify**):
  - add `windows-latest` to both job matrices;
  - run Prettier only on `ubuntu-latest`;
  - set `git config --global core.autocrlf false` before checkout on Windows, so the fixtures keep LF line endings.
- `packages/cli/test/helpers.mjs` and `packages/cli/test/ui/chat-helpers.mjs` (**modify**):
  - on Windows, write `fake-claude.cmd` (`@node "%~dp0fake-claude.mjs" %*`) and point `SHIPLINE_CLAUDE_BIN` at it;
  - the process-tree check uses `tasklist` on Windows instead of `ps`.
- `packages/cli/test/**/*.test.mjs` (**modify**, only where needed): `win32` skips, each giving its reason and naming the covering Windows test. Every skip is listed in Verification as the builder adds it.
- `packages/cli/test/paths-eol.test.mjs` (**create**, runs on every OS):
  - `detectEol`: CRLF, LF, none, and mixed (follows the first line break);
  - a CRLF `config.yml` and workflow round-trip that stays CRLF after a save, and a mixed file saved with its first line's ending;
  - a CRLF `CLAUDE.md` block that's added and then removed cleanly;
  - `isInside` and `sameRoot` with `platform` set to `'posix'` and to `'win32'`, including drive-letter and path case (`C:\\Repo` and `c:\\repo`);
  - `encodePath('C:\\Users\\x\\repo')` is `C--Users-x-repo` and equals `transcript.mjs`'s encoding of the same string.
- `packages/cli/test/windows.test.mjs` (**create**): runs on `win32` only and is skipped elsewhere with a reason. It covers only behaviour that needs real Windows:
  - starting the `fake-claude.cmd` shim through the chat (shell start, quoting a repo path with spaces);
  - stopping a chat leaves no `fake-claude` or child process in `tasklist`;
  - a real repo on a drive-letter path: `init`, a stage, and the store folder name;
  - `git diff --no-index` against `/dev/null` (and `nul`).

## Behavior & Edge Cases

- **A fresh clone after the removal:** `pnpm install` works with no native builds except esbuild. `pnpm build:ui` and `pnpm test` work from the repo root.
- **Old links to `packages/plugin` or `/shipline:init`:** they're removed from the README, and the README's Install section says the plugin is gone.
- **Windows without Git Bash:** if Claude Code can't run the hook command, Claude Code shows the hook error. This plan doesn't add a preflight; that's the Chat reliability plan (Node preflight). The README's Windows notes say Git for Windows is required, as Claude Code itself requires it.
- **Repo paths with spaces on Windows:** the hook command quotes `$CLAUDE_PROJECT_DIR`. `taskkill` gets the PID only.
- **CRLF YAML on any OS:** parsed correctly. The writer keeps CRLF, so a save produces no line-ending noise in the diff.

## Constraints

- **No behaviour change on macOS or Linux:** all existing tests still pass there.
- **Hooks:** they stay dependency-free on Node 18.
- **No new runtime dependencies.** Process-tree killing uses `taskkill`; no `tree-kill` package.
- **UI bundle:** unchanged, since nothing in `packages/ui` changes.

## Verification

1. `rm -rf node_modules && pnpm install` on a fresh clone pulls in no Prisma, Electron or node-pty, and `git ls-files` shows only `packages/cli`, `packages/ui`, `docs`, `.github`, `.claude/{plans,research,wireframes,agent-output-config.json}` and the root files.
2. The author reads `README.md` from top to bottom and can follow it from install to uninstall, and both images render on GitHub.
3. `cli.yml` passes on `ubuntu-latest`, `macos-latest` and `windows-latest` (Node 18 hooks, Node 20 `cli + ui`). `npm test` still passes locally on macOS.
4. **Windows test skips:** the builder fills this list. Each entry has the test, the reason, and the Windows test that covers the same behaviour.

   | Test (file) | Reason on `win32` | Covered on Windows by |
   |---|---|---|
   | "SIGINT stops claude's whole process group and removes lock.json" (`test/ui/shutdown.test.mjs`) | Node can't send SIGINT/SIGTERM to a child on Windows (`child.kill` terminates it outright, no handler runs), and there are no process groups. | `windows.test.mjs` "Stop leaves no fake-claude or child process in tasklist" |
   | "SIGINT with a claude that ignores SIGTERM: SIGKILL follows and nothing is left" (`test/ui/shutdown.test.mjs`) | Same as above. | Same as above (the `/F` after 5 s) |
   | "SIGTERM does the same" (`test/ui/shutdown.test.mjs`) | Same as above. | Same as above |
   | "close() stops the process group and releases the lock" (`test/ui/shutdown.test.mjs`) | Checks the POSIX process group with `ps`. | `windows.test.mjs` "close() stops the chat's process tree and releases the lock" |
   | "prints the tokened URL, and SIGINT shuts down with exit 0" (`test/ui/auth.test.mjs`) | Node can't send SIGINT to a child on Windows, so the exit code is never 0. | **None.** Ctrl+C on `shipline ui` can't be simulated from a Windows test. |
   | "a spawn ENOENT is handled like an early exit" (`test/ui/chat.test.mjs`) | Starts a self-deleting `.mjs` directly; Windows needs the `.cmd` shim, so there is no ENOENT. | `windows.test.mjs` "a .cmd claude whose script is gone after the health checks ends the chat with a fatal exit event" |
   | The `0600` mode check inside "the relay secret is only in the MCP config env…" (`test/ui/chat.test.mjs`; only that assertion, the rest of the test runs) | Windows has no POSIX modes (`chmod` is a no-op there). | **None** (by design, plan C "chmod"). |
   | "the store key is the realpath of the repo root (a symlinked path shares the store)" (`test/store.test.mjs`, existing skip, reason reworded) | Creating symlinks needs extra rights on Windows. | `windows.test.mjs` "a repo on a drive-letter path: init, a stage, and the store folder name" |
   | "hooks fail open with "Shipline can't write its task store at <path>"" (`test/store.test.mjs`, existing skip, reason reworded) | Blocks the store with a file in its path (POSIX `ENOTDIR`). | **None yet.** Candidate to un-skip after the first Windows CI run. |
   | "an unwritable SHIPLINE_HOME stops init…" (`test/init-version.test.mjs`, existing skip, reason reworded) | Same as above. | **None yet.** Same as above. |
   | "upgrade exits 1 with "Shipline can't write its task store"…" (`test/upgrade.test.mjs`, existing skip, reason reworded) | Same as above. | **None yet.** Same as above. |
   | "if an earlier write fails, VERSION is never written and init rolls back" (`test/init-version.test.mjs`, existing skip) | `chmod 0o555` can't make a folder read-only on Windows. | **None.** The rollback logic is platform-neutral. |
   | "while writing files: VERSION, the task folders and .state stay…" (`test/upgrade.test.mjs`, existing skip) | Relies on POSIX file modes to make a write fail. | **None.** The failed-write logic is platform-neutral. |

   **Null device:** the suspected Windows bug with `os.devNull` (`\\.\nul`) was fixed by using git's own `/dev/null`. The related tests are no longer marked `todo`.

## Open Questions

- **Hooks through Git Bash:** this plan assumes Claude Code on Windows runs hook commands through Git Bash, so `"$CLAUDE_PROJECT_DIR"` expands. It can't be checked without a Windows machine and Claude Code. If it's wrong, the hook command needs a Windows form. Follow-up: whoever first runs Shipline on Windows reports back.
- **`taskkill` and grandchildren:** `taskkill /T` should kill Claude's grandchild processes (tools Claude started) on Windows, but nothing outside the fake-`claude` test confirms it.
- **Matching Claude Code's encoding:** the store path encoding on Windows should match Claude Code's own `~/.claude/projects` encoding, so the history reader finds the session files. The builder checks `transcript.mjs`'s encoding against the same rule.
- **Accepted from the plan re-review:** the non-blocking notes in `docs/plans/shipline-cleanup-rollout.review.md` are accepted as they are. For example, `encodePath` keeps letter case, so `sameRoot`'s case-insensitive comparison mainly guards against drive-letter case differences.
