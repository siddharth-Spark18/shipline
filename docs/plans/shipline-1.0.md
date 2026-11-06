# Shipline 1.0: ship, harden, first run

**Status:** Approved
**Context:** `.claude/research/product-retrospective-2026-11-06.md`, the retrospective of 0.14.0, with file and line evidence for every finding below.
**Starts from:** `main` @ 766dc58 (0.14.0). **Ships as:** 1.0.0, INTERFACE 1, as **one PR**. After merging, the author tags `v1.0.0`, which publishes to npm through `.github/workflows/publish.yml`.

## Problem & Goal

Shipline works end to end, but nobody else can use it yet:
- it isn't on npm and has no license;
- several guardrail claims are weaker than the README says;
- a newcomer hits CLI rough edges and a 363-line README before their first task.

The first real audience is the author's own team, soon.

**Goal:** a 1.0 that a teammate can `npx @forgeyard/shipline init` into a repo, understand in five minutes, and trust to do what the README says.

**Success:**
- `npm view @forgeyard/shipline version` prints 1.0.0, and the package is MIT-licensed.
- Every guardrail gap listed in the retrospective (`.claude/research/product-retrospective-2026-11-06.md`, committed with this plan) is closed or documented.
- A newcomer reaches a first task from the quickstart without hitting any of the CLI issues listed below.
- The hand-test checklist in Verification passes in an interactive Claude Code session before the tag.

## Scope

### In: A. Ship

1. **MIT license.** `LICENSE` at the repo root and in `packages/cli/`, copyright 2026 Siddharth Paneri. `package.json` `license: "MIT"`.
2. **CHANGELOG.** `packages/cli/CHANGELOG.md` in Keep a Changelog format, with a single `1.0.0` entry summarising what Shipline does; there's no history before 1.0. `publish.yml` fails when the CHANGELOG has no heading for the tagged version.
3. **Version 1.0.0** and a **full upgrade-history reset**:
   - **Interface and hashes:**
     - INTERFACE goes back to 1, and `MISSING_BEFORE` is emptied;
     - `known-hashes.json` holds only the 1.0.0 hashes, regenerated with `scripts/hash-templates.mjs`;
     - `known-stub-rules.mjs` keeps only the 1.0 stubs.
   - **Migrations deleted from `upgrade.mjs`, with their tests and fixtures:**
     - removed config keys (`artifact_root`, `folder_pattern`) and the move of `artifact_root` into the store (`planMigration`, `copyVerified`, `rewriteTaskDirs`);
     - the jira → ticket rename and `TICKET_DEFAULTS`;
     - the verify-regex rewrite;
     - `checks` and `sections` defaults, and the rails-off guardrail insertion with its comment;
     - the `confirmations` and `checkpoint` insertion;
     - the empty-command fill.
   - **What `upgrade` keeps:** the generic mechanism, that is the version check, the template refresh of unedited files by hash, `--force`, and preview and apply.
   - **A repo whose `VERSION` package is below 1.0.0:** `upgrade` exits 1 with "This repo was set up with a pre-1.0 Shipline (<version>). Run `npx @forgeyard/shipline uninstall --yes` then `init`; task data in ~/.shipline is kept." It writes nothing.
4. **Strict CLI** (`bin/shipline.mjs`, plus `parseUiArgs` in `src/ui/server.mjs`):
   - **Help:** `--help` and `-h` are global and per command, with usage for that command, exit 0.
   - **Version:** `--version` and `-v` print the version, exit 0.
   - **Aliases:** `-y` = `--yes`.
   - **Target folder:** given only with `--dir <path>`. A bare positional argument is an error.
   - **Unknown flags:** `shipline: unknown option --x (see shipline <cmd> --help)`, exit 2.
   - **Unknown command:** prints help, exit 2.
5. **`init --dry-run` without a terminal** previews the defaults that `--yes` would install, instead of refusing.
6. **Init warnings**, printed after the summary, never blocking:
   - when the target isn't inside a git repo: "Not a git repository: scope checks, the PR summary's code match and pushes need git. Run `git init` first.";
   - for each detected command whose first word isn't on PATH: "Detected `pytest` for test, but `pytest` isn't installed here." Check with `command -v` on POSIX and `where` on Windows; a failed lookup counts as not found.
7. **Small fixes:**
   - init's created-file count includes `VERSION` (`init.mjs:126`);
   - the uninstall preview lists only excluded files that exist (`uninstall.mjs:190`);
   - the "needs Node" message shows only when `node` is missing (`settings-hooks.json:8`).
8. **Windows flaky tests:**
   - `test/ui/relay.test.mjs`, `test/ui/shell.test.mjs` and `test/ui/setup.test.mjs` poll for the condition, up to 10 s, instead of asserting after a fixed wait or a single check;
   - `assertTreeGone` retries `tasklist` until the tree is gone or the 10 s are up.

### In: B. Guardrail hardening

9. **Case-insensitive matching everywhere:** agent config paths (`guard.mjs:83`), credential paths (`lib.mjs:952`) and `protected_paths` globs (`lib.mjs:962`).
10. **Credential printing: any command, with a safe list.**
    - A Bash command whose arguments, after `parseCommand`, name a credential path is denied by `print_credentials`, whatever the command.
    - **The exceptions never print contents:** `ls`, `stat`, `test`, `[`, `touch`, `rm`, `mv`, `cp`, `chmod`, `chown`, `file`, `wc`, `du`, and `git add` / `git rm` / `git mv` / `git status`.
    - **Which arguments count:** only the non-flag arguments of each sub-command, after `parseCommand` splits `&&`, `;` and `|`. So `ls .env && cat .env` is denied because of the `cat`, while `ls -la .env` is allowed.
    - **`cp` and `mv` destinations:** they're safe unless their destination prints: `/dev/stdout`, `/dev/stderr`, `/dev/tty` or `-`.
    - **Git:** `git diff`, `git show`, `git log -p` (or `--patch`) and `git blame` naming a credential path are denied, since they print contents.
    - **Credential directories:** an argument inside `~/.ssh/`, `~/.aws/` or `~/.docker/` counts as a credential path, and so does the directory itself.
    - Redirection into a credential file (`> .env`) is not printing; it goes through the existing write rules.
    - **More credential files:** `.netrc`, `.git-credentials`, `.docker/config.json`, `*.p12`, `*.pfx`, `credentials.json`, `.envrc`, `.pgpass`, `.npmrc`, `.pypirc`.
11. **Grep:**
    - Add `Grep` to the PreToolUse matcher.
    - A Grep whose `path` is a credential file, or whose `glob` matches one, goes through `read_credentials`.
    - Glob stays outside the hook.
12. **`pipe_to_shell` additions:**
    - process substitution: `bash <(curl …)`, `source <(wget …)`, `. <(…)`;
    - command substitution into a shell: `sh -c "$(curl …)"`, `bash -c "$(wget …)"`.
13. **Store path forms.** `bashReachesProgress` (`guard.mjs:66-75`) also recognises `$HOME/.shipline` and `${HOME}/.shipline`.
14. **Failure modes:**
    - **Store errors:** the store-protection step is wrapped in its own try/catch. If it throws, only that step is skipped and the rails still run.
    - **A broken `config.yml`:** the rails use their built-in defaults (`DEFAULT_CONFIG` rails and protected paths) instead of turning off. Every call adds the system message "Shipline: .shipline/config.yml can't be read (<error>); guardrails are using their defaults." This applies with or without a task.
15. **CI check uses the base branch's checker and config.**
    - `templates/github/shipline.yml` checks out the PR head into `head/` (`ref: pull_request.head.sha`) and the base commit into `base/` (`ref: pull_request.base.sha`, `fetch-depth: 1`). It uses the existing `pull_request` trigger, so a PR from a fork runs with read-only permissions and the base checkout works the same.
    - When `base/.shipline/bin/ci-check.mjs` exists, it runs that script with `--config-from ../base` from `head/`. Otherwise (the PR that adds Shipline), it runs head's own script.
    - `ci-check.mjs` gains `--config-from <dir>`: `config.yml` and the workflow files are read from `<dir>/.shipline/`, while the git tree and fingerprint come from the current repo.
    - **README:** a PR can still edit the workflow file itself, so real enforcement needs branch protection (the check required) plus CODEOWNERS on `.shipline/` and `.github/`. The README gives a sample CODEOWNERS.
16. **Message fix.** The guard's deny message gets its missing sentence break (`guard.mjs:260`).

### In: C. First run

17. **Quickstart at the top of the README.** Install, open Claude Code, ask for a change, what a session looks like (stage list, the Plan question, Verify checks, PR summary), and the UI. The existing reference sections follow, trimmed where 1.0 removes behaviour (upgrade history, legacy notes).
18. **Example app.** `examples/todo-node/`: a tiny Node module (about 50 lines) with `npm test` (`node --test`) and `npm run lint` (`node --check`). It contains no Shipline files. Its README says to run `npx @forgeyard/shipline init --yes`, then shows a sample first session and a sample PR summary. It's not in the npm package.
19. **Tracker default `none`.**
    - `TRACKERS` becomes `['none', 'jira', 'github']`. `none` is the default for new installs, interactive init, the wizard, Setup, and a missing or empty key (`lib.mjs:194`).
    - GitHub remote detection no longer picks the default.
    - With `none`, the ticket stage is skipped automatically in `activateNext()` in `stage.mjs`, the same place that skips `ui_only` stages for non-UI work. The rule: when `cfg.tracker === 'none'` and `sameStage(ms.id, 'ticket')` is true (matched by stage id), the stage is marked `skipped` with reason "No tracker" and `skipped.via` set to `'optional'` for an optional stage or `'auto'` otherwise. There's no question. The CI check already treats both as finished. No later stage or check reads `ticket.md`, so nothing else changes.
    - An unknown value keeps today's message.
20. **`stage.mjs status` for humans.**
    - Without a session id, `status` lists the unfinished tasks for the current branch (slug, workflow, current stage) instead of failing. With a session, it behaves as now.
    - The default output is short: the stage list plus the current stage's name, artifact, checks line and next step. `--verbose` adds the rules text and full store paths.
    - `ui=null` becomes "UI work: unknown", "yes" or "no".
21. **Honest messages.**
    - The section problem reads `<heading> (too short: write at least 20 characters under it)` instead of `(empty)`.
    - The scope line no longer mentions a plan in workflows without a plan stage.
22. **Small change without asking.** `prompt-submit.mjs` says that for Small change Claude announces it and starts without waiting, matching the `shipline-workflow` skill. Other workflows still ask once.

### In: D. Hand-test (before tagging)

23. The checklist in Verification is run by the author in an interactive Claude Code session on a scratch repo. Its result is recorded in the PR description before `v1.0.0` is tagged.

### Out

- Telemetry and error reporting, a docs site, team insights.
- Phase 5 (plugin, marketplace, feedback) and Phase 6 (monorepos).
- Linear.
- Git worktree or moved-repo store keying.
- Splitting `lib.mjs`.
- Removing the duplicated `RAIL_IDS` lists, apart from the one deleted with the upgrade migrations.
- A ceiling on the `claude` CLI version, or a test against a real `claude`.
- Changing `engines` or the `@inquirer/prompts` dependency.
- `prepack` without pnpm.
- Making confirmations answerable from a terminal.
- `python3 -c` and `git checkout -- <protected>` style bypasses, which stay documented as defence in depth.
- Editing old plan documents (for example the false "published" line in `shipline-v2-repo-init.md`). They're history.
- Pushing the tag, adding the `NPM_TOKEN` secret, and the npm scope. The author does these.

## Surface Area

- **Hooks** (vendored, Node 18, no dependencies): `lib.mjs`, `guard.mjs`, `stage.mjs`, `ci-check.mjs`, `prompt-submit.mjs`, `settings-hooks.json`, and templates (`config.yml`, `github/shipline.yml`).
- **CLI:** `bin/shipline.mjs`, `init.mjs`, `init-prompts.mjs`, `install.mjs`, `upgrade.mjs`, `uninstall.mjs`, `setup-schema.mjs`, `interface.mjs`, `known-hashes.json`, `known-stub-rules.mjs`, `ui/server.mjs`, and the tracker-aware server code (`ui/tracker.mjs`, `ui/chat-routes.mjs`).
- **UI:** tracker options in the wizard and the Setup config form, and the types.
- **Data:**
  - `tracker` gains the value `none`;
  - `ci-check.mjs` gains the flag `--config-from`;
  - the manifest has no new fields (the auto-skipped ticket uses the existing `skipped: { via, at, reason }`);
  - no store migration.
- **API:** no endpoint changes. Install and Setup accept `tracker: 'none'`.

## Files to Touch

| Path | Change | What |
| --- | --- | --- |
| `LICENSE` | create | MIT, 2026 Siddharth Paneri. |
| `packages/cli/LICENSE` | create | The same text, shipped in the npm package. |
| `packages/cli/CHANGELOG.md` | create | Keep a Changelog, with a `## [1.0.0] - <date>` entry. |
| `packages/cli/package.json` | modify | Version 1.0.0, `license: "MIT"`, and add `CHANGELOG.md` and `LICENSE` to `files`, since npm doesn't include a CHANGELOG automatically. |
| `.github/workflows/publish.yml` | modify | New step: fail if `CHANGELOG.md` has no `## [<version>]` heading. |
| `packages/cli/bin/shipline.mjs` | modify | The strict parser (item 4): per-command help text, `--version`/`-v`, `-y`, `-h`, `--dir`, exit 2 on unknown flags, positional arguments or commands. |
| `packages/cli/src/ui/server.mjs` | modify | `parseUiArgs` follows the same strict rules, adding `--help`, `--dir`, `--port` and `--no-open`. |
| `packages/cli/src/init.mjs` | modify | Dry-run without a terminal uses the defaults. Init warnings (item 6). File count includes `VERSION`. The tracker summary line covers `none`. |
| `packages/cli/src/init-prompts.mjs` | modify | Tracker select offers None (default), GitHub Issues and Jira. |
| `packages/cli/src/install.mjs` | modify | Default tracker `none`. `trackerDefault()` returns `'none'`, and GitHub detection is removed. `need('tracker')` accepts `none`. |
| `packages/cli/src/detect-commands.mjs` | modify | Export a `toolOnPath(command)` helper used by the init warnings. |
| `packages/cli/src/upgrade.mjs` | modify | Delete every pre-1.0 migration (item 3) and refuse repos below 1.0.0 with the message. Keep the generic refresh. |
| `packages/cli/src/uninstall.mjs` | modify | The "Kept" list only includes excluded paths that exist. |
| `packages/cli/src/interface.mjs` | modify | INTERFACE 1, `MISSING_BEFORE` empty. |
| `packages/cli/src/known-hashes.json` | modify | Regenerated: 1.0.0 hashes only. |
| `packages/cli/src/known-stub-rules.mjs` | modify | Only the 1.0 stub hashes. |
| `packages/cli/src/setup-schema.mjs` | modify | `TRACKERS = ['none', 'jira', 'github']`. |
| `packages/cli/src/ui/tracker.mjs` | modify | `none` fetches nothing and returns no ticket. |
| `packages/cli/src/ui/chat-routes.mjs` | modify | Tracker handling treats `none` as no tracker. |
| `packages/cli/templates/settings-hooks.json` | modify | The matcher adds `Grep`. The Node message shows only when `command -v node` fails. |
| `packages/cli/templates/shipline/config.yml` | modify | `tracker: none` with the options in the comment. Note on how the CI check reads the base branch. |
| `packages/cli/templates/github/shipline.yml` | modify | Two checkouts (`head/`, `base/`), running base's checker with `--config-from` and falling back to head's. |
| `packages/cli/templates/shipline/bin/lib.mjs` | modify | Case-insensitive path and glob matching. Credential detection for any command, with the safe list and the new files. Process and command substitution for `pipe_to_shell`. `DEFAULT_CONFIG.tracker = 'none'`. Section message wording. |
| `packages/cli/templates/shipline/bin/guard.mjs` | modify | Store-step try/catch. Broken config uses the default rails, with a warning. Grep → `read_credentials`. `$HOME/.shipline` forms. Deny-message sentence break. |
| `packages/cli/templates/shipline/bin/stage.mjs` | modify | Auto-skip the ticket stage in `activateNext()` when `tracker: none` (item 19). `status` without a session, short output by default, `--verbose`, the "UI work" wording. Scope line without a plan stage. |
| `packages/cli/templates/shipline/bin/ci-check.mjs` | modify | `--config-from <dir>`. |
| `packages/cli/templates/shipline/bin/prompt-submit.mjs` | modify | Small change: announce and start. |
| `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` | modify | Mention `status` without a session, and that the ticket stage is skipped with no tracker. |
| `packages/cli/templates/claude/skills/shipline-setup/SKILL.md` | modify | Tracker question includes None as the default. |
| `packages/ui/src/lib/types.ts` | modify | Tracker type includes `'none'`. |
| `packages/ui/src/lib/stages.ts` | modify | Ticket labels handle `none`. |
| `packages/ui/src/pages/install/install-wizard.tsx` | modify | Tracker radio: None (default), GitHub Issues, Jira. |
| `packages/ui/src/pages/setup/config-form.tsx` | modify | The same tracker options. |
| `README.md` | modify | Quickstart first. CI check section with branch protection and a CODEOWNERS sample. The guardrails table covers Grep and the any-command credential rule. Upgrade section for 1.0 (pre-1.0 → uninstall and init again). Remove legacy notes. Link the CHANGELOG and LICENSE. |
| `examples/todo-node/package.json` | create | `test`: `node --test`, `lint`: `node --check src/todo.js`. |
| `examples/todo-node/src/todo.js` | create | A tiny todo module. |
| `examples/todo-node/test/todo.test.js` | create | A few `node:test` cases. |
| `examples/todo-node/README.md` | create | Init steps, a sample first session, a sample PR summary. |
| `packages/cli/test/fixtures/legacy-0.6/**` | delete | Legacy upgrade fixtures. |
| `packages/cli/test/uninstall.test.mjs` | modify | Its tests that use `legacy-0.6` (about lines 262-272) are rewritten against a fresh 1.0 `init`. |
| `packages/cli/test/publish.test.mjs` | modify | Its use of `legacy-0.6` (about line 187) is rewritten against a fresh 1.0 `init`. Version 1.0.0. |
| `packages/cli/test/ui/relay.test.mjs`, `packages/cli/test/ui/shell.test.mjs`, `packages/cli/test/ui/setup.test.mjs` | modify | Windows flake fixes (item 8): poll up to 10 s. |
| `packages/cli/test/fixtures/rules-0.10/**` | delete | Legacy stub-rule fixtures. |
| `packages/cli/test/**` | create / modify / delete | Tests (test agent): drop the legacy upgrade tests, update for INTERFACE 1, 1.0.0, `none` and the strict CLI, and add tests for every item. The Windows flake fixes are in `test/ui/relay.test.mjs`, `test/ui/shell.test.mjs` and `test/ui/setup.test.mjs`. |

## Behavior & Edge Cases

- **Strict CLI:**
  - `shipline init some/dir` → exit 2: "unexpected argument some/dir (use --dir)".
  - `shipline --version` works with no command. `shipline init --version` prints the version too.
- **Init outside git:** installs, then warns. No refusal.
- **Missing tool:** a warning only. The command stays in `config.yml`.
- **`tracker: none` with a `--ticket` / `#123` given at task start:** the ticket stage is still auto-skipped, and the key is still used in the branch name.
- **Credential safe list:** `cat .env.example`, `.env.sample` and `.env.template` stay allowed (the existing exclusion is kept). `ls -la .env` is allowed, `sort .env` denied, `cp .env .env.bak` allowed.
- **Case-insensitivity:** `README.md` vs `readme.md` doesn't matter here, since only the agent-config, credential and protected-path checks change.
- **Broken config:** with defaults, the `agent_config` rail asks on edits to `.shipline/config.yml`, which may be the file being fixed. That's acceptable: the developer approves the prompt.
- **CI, first PR adding Shipline:** base has no checker, so head's runs, as today.
- **CI, base on an older 1.x checker without `--config-from`:** that can't happen at 1.0, since it's the first version. Later releases must keep the flag.
- **Pre-1.0 repo running `upgrade`:** the refusal message, exit 1, nothing written.
- **`init` on a repo with a pre-1.0 Shipline:** "already initialized", as today. The README says to uninstall first.
- **`status` without a session and no task on the branch:** "No unfinished tasks on <branch>." exit 0.
- **`status` without a session outside a git repo:** the branch is unknown, so it lists every unfinished task.

## Constraints

- Hooks stay Node 18-compatible with no dependencies, and fail open on unexpected errors, except for the new rails-with-defaults path.
- Guard overhead stays at about 25 ms per call: the any-command credential check works on the already-parsed command.
- One PR. The full CI matrix (Ubuntu, macOS and Windows on Node 18 and 20) must be green twice in a row on the PR, to show the Windows flakes are fixed.
- The UI bundle stays at about 284 KB.

## Verification (done when)

1. **CI:** all suites green on the full matrix, twice in a row.
2. **Tests cover:**
   - the strict CLI;
   - dry-run without a terminal;
   - the init warnings;
   - every bypass in the retrospective now denied or asking: `.CLAUDE/settings.json`, Read of `.ENV`, Grep on `.env`, `tac .env`, `jq . .env`, `cat .netrc`, `bash <(curl …)`, `$HOME/.shipline` writes;
   - the safe-list commands allowed;
   - a store error with rails still enforced;
   - a broken config with the default rails and the warning;
   - `ci-check --config-from` using the base config while the head relaxes `ci.missing_block`;
   - `tracker: none` auto-skipping the ticket stage;
   - `status` without a session;
   - the upgrade refusal for a pre-1.0 repo.
3. **`npm pack --dry-run`** in `packages/cli` lists `LICENSE`, `CHANGELOG.md`, `ui-dist/` and no `examples/`.
4. **Hand-test** (author, interactive Claude Code, scratch repo from `examples/todo-node` after `init --yes`):
   - (a) a feature task in standard mode asks at Open questions, Plan and Verify;
   - (b) with `confirmations: light`, it asks only at Plan;
   - (c) `git push --force origin main` and `cat .env` are denied;
   - (d) editing `.claude/settings.json` asks;
   - (e) a failing `npm test` at Verify asks to accept;
   - (f) editing a test file triggers the scope question;
   - (g) `shipline ui` chat sends a message and shows the reply once.

   Results go in the PR description.
5. **After the merge and the tag:** `npm view @forgeyard/shipline version` prints `1.0.0`, and `npx @forgeyard/shipline@1 init --dry-run --yes` works in a fresh folder.

## Added during the build (author's decisions, 2026-11-06)

- **The browser UI and pre-1.0 repos.** The UI recognises a pre-1.0 repo (a `VERSION` below 1.0.0, or `.shipline/` with no readable `VERSION`) and shows the same "uninstall, then init" message as `upgrade`. Setup saves and starting a chat are refused for such a repo. The now-dead interface-2 and `artifact_root` code in `src/ui/{repo,tasks,watch}.mjs` is removed.
- **Broken config and protected paths.** With a broken config, `protected_paths` falls back to the same list the `config.yml` template ships. `lib.mjs` holds that list once, and a test keeps the template identical to it.
- **Store errors.** A store error no longer drops a rail's ask; this was a bug the test agent found.

## Open Questions

- None blocking.
- **Accepted:** a PR can still edit `.github/workflows/shipline.yml` itself. Only branch protection and CODEOWNERS close that, and the README says so.
- **Accepted:** pre-1.0 repos (the author's own, such as the brown bag tracker) must be uninstalled and initialised again. Their task data in `~/.shipline` is kept.
