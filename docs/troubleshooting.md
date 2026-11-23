# Troubleshooting

Common problems and what to do.

[Back to the README](../README.md)

- **A hook warning appears at session start or on a tool call.** Read it: it names the problem (a config
  that doesn't parse, a missing stage). A config.yml that can't be read keeps the guardrails on with their
  defaults ("guardrails are using their defaults"); fix the file shown, or run `npx @forgeyard/shipline ui` and use Setup.
- **"Shipline <hook> hook crashed: ...".** One of the hooks (`guard`, `session-start`, `prompt-submit`,
  `record-answer`) threw, usually because a file in `.shipline/bin/` was edited or half-upgraded. Claude keeps working
  but that hook's checks are off for the call, and the message repeats until it is fixed. Run
  `npx @forgeyard/shipline upgrade` (add `--force` to replace edited scripts), or fix the error it quotes.
- **`upgrade` says ".shipline/bin/ has local edits".** The scripts in `.shipline/bin/` must be upgraded together.
  Save your edits, run `upgrade --force`, then re-apply them. See [Upgrade and uninstall](install.md#upgrade-and-uninstall).
- **A tool call was denied.** A `block` stage isn't done yet, or a guardrail fired. Run
  `node .shipline/bin/stage.mjs explain`: it shows the last denial or question of the session, the rule behind it and the
  way past it. Finish that stage, use a side pass for an unrelated edit, or tell the developer; don't work around it.
- **A task started in the main checkout isn't visible in a Claude Code worktree.** Each worktree has its own task store
  until the store is shared between worktrees; start or resume the task from the worktree.
- **"Shipline is already initialized".** `init` found `.shipline/`, the `CLAUDE.md` block or the hooks. To
  change agents and skills use the UI (Setup, Agents & skills); to update use `upgrade`; to start over use
  `uninstall`, then `init`.
- **`upgrade` says "pre-1.0 Shipline".** See [Upgrade and uninstall](install.md#upgrade-and-uninstall): uninstall, then `init`.
- **"Repo newer".** The repo was set up by a newer Shipline than the one you ran. Run the newer version, for
  example `npx @forgeyard/shipline@<version> ui`, or `upgrade` with the latest.
- **`shipline ui` says "already running", or a second terminal opens the same server.** That is intended: there is one
  UI server per machine, and a later `shipline ui` hands its folder over to it. To start fresh, stop the running one
  (Ctrl+C in its terminal).
- **`shipline ui` can't find the running server, or opens a new one every time.** The running server is recorded in
  `~/.shipline/server.json` (or `$SHIPLINE_HOME`). After a crash or reboot that file is stale: a new `shipline ui` notices
  (the pid is gone or the server doesn't answer) and replaces it, so nothing needs deleting. A server from before 2.0
  writes no such file and isn't detected: stop it, or its per-repo chat lock will refuse a second chat in that repo
  ("A chat is active in another Shipline UI process").
- **A repo shows "Folder not found".** The folder (or its `.shipline/config.yml`) is gone: it was moved, renamed or
  uninstalled. It is never removed automatically; use **Remove from list** on its card in All projects (or in Health), then run
  `shipline ui` in the new location.
- **A repo shows "Newer Shipline" or "Needs reinstall".** That repo isn't served by this server; the others are. For a
  newer one, stop the server and run the version it names, for example `npx @forgeyard/shipline@<version> ui`.
- **A task seems lost.** Tasks are stored outside the repo under `~/.shipline/projects/`, keyed by the repo's main
  checkout path. If you moved or renamed the repo folder, run `npx @forgeyard/shipline relink --from <old path>` in
  it (`--dry-run` previews); it moves the old store to the new key. It refuses if the new location already has tasks.
  Also check you are on the same machine and `SHIPLINE_HOME` is unchanged.
- **Old task data piling up.** `npx @forgeyard/shipline prune` lists (and, after you confirm, removes) the stores of
  repos that no longer exist and `*.migrated-<date>` backups older than 30 days. It never touches a store whose repo
  still has Shipline, or one that a worktree you still have uses.
- **Installed in a monorepo package.** `init` warns when the folder is inside a larger git repo: Claude Code loads the
  hooks only when it starts in the folder that has `.claude/settings.json`, so start it there, or install at the repo root.
- **Windows.**
  - Install [Git for Windows](https://git-scm.com/download/win); Claude Code itself requires it.
  - The hook command is `node "$CLAUDE_PROJECT_DIR/.shipline/bin/run-hook.mjs" <hook>`, which relies on Claude Code
    running hooks through Git Bash. That is untested here; if hooks show an error, please report it.
  - `shipline ui` opens your browser with `start`, and stops a chat with `taskkill`. Stopping can take a few
    seconds.
  - Task data is in `%USERPROFILE%\.shipline`. A repo at `C:\Users\you\repo` is stored in a folder named like `C--Users-you-repo-<hash>`.
  - Existing CRLF files keep CRLF when Shipline saves them; new files use LF.
