# Review: shipline-cleanup-rollout

Re-review. The four earlier must-fixes are all closed. The plan now says encodePath needs no change, names storeDir and the exact compare rule, lists init.mjs, uninstall.mjs and ui/tasks.mjs for containment, and defines detectEol (first line break wins, helper in lib.mjs).

## 1. Verdict
Ready after must-fixes (2 must-fix items).

## 2. Paraphrase
**What the plan proposes.** Delete the v1 hub (apps/*, packages/shared, packages/plugin, marketplace file, turbo) and shrink root config to `packages/*`. Rewrite README.md as a nine-section CLI adoption guide with two screenshots. Add Windows support: taskkill tree-kill for stopping a chat, `cmd /c start` to open the browser, `os.devNull` for `git diff --no-index`, case-insensitive repo.json and containment checks on win32, CRLF-preserving YAML/CLAUDE.md/rules writes, and `windows-latest` in the CI matrices. A new win32-only test file and a `.cmd` shim for the fake `claude` provide the Windows tests. Metrics, trust work, chat reliability and publishing are out.

**How the system works, according to the plan.** The product is `@forgeyard/shipline` (packages/cli plus packages/ui). Hooks and `stage.mjs` are dependency-free Node scripts run as `node "$CLAUDE_PROJECT_DIR/.shipline/bin/x.mjs"`. Task data lives in `~/.shipline/projects/<encoded path>`, with `repo.json` guarding against collisions. Chat spawns `claude` detached and stops it with `process.kill(-pid)`, then SIGKILL after 5 s. CI currently runs on Linux and macOS.

## 3. Must-fix
1. **Files to Touch C (chat.mjs, helpers) and Surface Area: the `.cmd` shim cannot be spawned as planned.** `chat.mjs:246` calls `spawn(bin, argv, { cwd, env, detached, stdio })` with no `shell`. On Windows, Node 18.20.2+/20.12.2+ refuses to spawn `.cmd`/`.bat` files without `shell: true` (it throws EINVAL, the CVE-2024-27980 fix). The plan points `SHIPLINE_CLAUDE_BIN` at `fake-claude.cmd`, so every Windows chat test would fail at spawn. Setting `shell: true` also changes the `taskkill` PID (it would be cmd.exe's, with args needing quoting). The builder would have to choose. This also affects the real `claude`, which an npm install exposes on Windows as `claude.cmd`. Fix: state the spawn approach for win32. For example, use `shell: true` only when `bin` ends in `.cmd`/`.bat`, rely on `taskkill /T` to kill the cmd.exe tree, and say whether real-`claude` spawning is covered or left to the Chat reliability plan. Or have the test point `SHIPLINE_CLAUDE_BIN` at `process.execPath` with the script as an arg, if that is supported.
2. **Files to Touch C, windows.test.mjs, vs Behavior ("CRLF YAML on any OS").** The plan says CRLF handling must work on every OS, but the CRLF, `detectEol` and `isInside` tests live in a file that runs on `win32` only. Nobody has a Windows machine, so these would never run locally and could only fail in CI after the fact. Fix: split the file. Platform-independent logic (`detectEol`, CRLF round-trips, the CLAUDE.md CRLF block, the `isInside` and `storeDir` compare logic via injectable platform or pure-function inputs) runs everywhere, and only the `tasklist`, `taskkill` and drive-letter tests are win32-only. Alternatively, name the mechanism that lets the win32-branch logic be tested on macOS.

## 4. Optional (non-blocking)
- `encodePath` is case-preserving, so `C:\Repo` and `c:\repo` encode to different store dirs. The case-insensitive `repo.json` compare is therefore reached only on a case-variant that happens to collide, which is nearly never. It is harmless, but the test "repo.json matching across drive-letter case" may not mean what the plan thinks. Consider whether the store dir name should also be lowercased on win32 (that is a behaviour decision, so surface it).
- `taskkill /PID <pid> /T` without `/F` often fails on console-less processes ("can only be terminated forcefully"). The 5 s then-force path covers it, but a chat stop on Windows will usually take the full 5 s. State that this is accepted.
- `detached: true` off Windows only: on Windows without it the child shares the console. Say whether `windowsHide: true` should be set on spawn and on the taskkill calls.
- Verification 1 lists the allowed tracked files. Confirm `.claude/settings.local.json` is untracked or add it.
- The existing test "diffs an untracked file against /dev/null" (tasks.test.mjs) is not named in the plan. Only rename it if it is referenced by the skip list.
- Hook-through-Git-Bash is unverifiable by CI. The README Windows notes should say "untested" rather than assert it works.

## 5. Files-to-touch check
- Paths checked and present: `packages/cli/src/ui/chat.mjs`, `open-browser.mjs`, `git.mjs`, `tasks.mjs`, `server.mjs`, `packages/cli/src/init.mjs`, `uninstall.mjs`, `yaml-emit.mjs`, `hashes.mjs`, `upgrade.mjs`, `templates/shipline/bin/lib.mjs`, `guard.mjs`, `test/helpers.mjs`, `test/ui/chat-helpers.mjs`.
- Line references confirmed: `init.mjs:298`, `uninstall.mjs:221`, `ui/tasks.mjs:329`, `git.mjs:102`, `ui/tasks.mjs:129`, `guard.mjs:60-63`, `server.mjs:98`.
- `chat.mjs` should also be listed as touching the `spawn` call at line 246 (see must-fix 1). It is listed, but the plan only describes the `detached` change.
- Not checked: the hub delete targets (`apps/*`, `packages/shared`, `packages/plugin`), the Desktop screenshots, `publish.test.mjs`, `cli.yml`, and the historical plan files.
