# Changelog

All notable changes to `@forgeyard/shipline` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-11-20

Fixes to enforcement: a bugfix can get past Reproduce, Verify no longer loops on checks that write files, a crashing
hook says so, and `upgrade` keeps `.shipline/bin/` at one version. **The hook contract (INTERFACE) is now 2**:
`upgrade` rewrites the hook entries in `.claude/settings.json`; restart running Claude Code sessions afterwards.

### Fixed

- **Verify could trust a stale check run after a same-size edit.** The code fingerprint copies git's index to reuse its
  stat cache, but the copy got a fresh mtime, so git trusted "racily clean" entries and missed a same-size edit made
  in the same second as the last index write. The copy now keeps the index's mtime.
- **Bugfix couldn't get past Reproduce with `fail_first: proof`.** The Root cause stage blocked every edit, including
  the failing test Reproduce asks for. At Reproduce of a workflow `fail_first` applies to, test files are now allowed
  through the stage blocks (file tools and Bash).
- **Verify looped forever when a check command wrote files git doesn't ignore** (coverage reports, `tsbuildinfo`,
  `eslint --fix`). `check` (and `check --expect-fail`) now records the code as it is after the commands ran and lists
  the files they changed.
- **A crashing hook silently turned enforcement off.** Hooks now run through `.shipline/bin/run-hook.mjs`: a crash
  (for example a syntax error in `lib.mjs`) still lets the call through, but prints "Shipline <hook> hook crashed" on
  every affected call. The node-missing warning now shows on every hook event, not only at session start.
- **`upgrade` could leave `.shipline/bin/` at mixed versions.** If any script there was edited, `upgrade` now refuses
  before writing anything (exit 1) unless `--force`. It also warns when edited hook entries in `settings.json` still
  run the scripts directly.
- **Plan and Root cause blocks could be bypassed through Bash.** `cat > src/a.js`, `sed -i`, `tee`, `mv`, `cp` and `rm`
  on repo files are now checked against stage `tools:` blocks like a Write. Indirect writes (interpreters, build
  tools) are still not detected.

### Changed

- **INTERFACE 2** (hook entries run `run-hook.mjs`; Bash writes count against stage blocks).
- The qa-bug-hunter agent runs `stage.mjs check` instead of the test, lint and build commands itself, so Verify no
  longer runs the suite twice.
- Node wording corrected: the hooks need Node 18+; the `shipline` CLI and UI need Node 22+. The dead "Node below 20"
  branch of the init wizard was removed.
- Docs: Glob isn't gated (it lists names, never contents).

## [2.1.0] - 2026-11-17

A new guardrail against slopsquatted packages, an optional fail-first test requirement for bugfixes, and a redesigned
Setup with selectable colour palettes. The hook contract (INTERFACE) is unchanged; `upgrade` refreshes the vendored
scripts and the `/shipline-setup` skill.

### Added

- **`install_packages` rail (default `ask`).** Claude Code's permission prompt now shows, naming the packages, before a
  command that adds a named package (`npm install lodash`, `pip install x`, `uv add`, `cargo add`, `go get`, ...), runs
  a package that isn't a dependency (`npx some-tool`, `pnpm dlx`, `uvx`, `pipx run`) or installs globally (`npm i -g`,
  `pipx`, `brew`, `apt`, ...). `npx vitest` in a repo that has vitest, and lockfile restores such as `npm install`,
  `npm ci` and `pip install -r requirements.txt`, never prompt. Nothing is looked up on a registry. Add your own with
  `rails_commands.install_packages`. **Existing repos get the rail at `ask` after upgrading, with no config edit**; set
  `rails.install_packages: off` to turn it off.
- **`fail_first` (off by default).** A per-repo setting that asks a bugfix to show a test that fails before the fix:
  `note` (Claude is told to write a failing test first), `section` (Reproduce needs a `## Failing test` section) or
  `proof` (`stage.mjs check --expect-fail [test file or name]` must record a failing test run before Reproduce can
  finish; it runs only `commands.test`, and unsafe extra arguments are refused). Verify and `pr-summary` then show
  "failed before, passed after"; the CI check shows it for information only. Skipping Reproduce with a reason still
  works. The built-in note is printed by `stage.mjs`, so shipped rules files are unchanged.
- **Setup, Guardrails, and the install stepper** have the new rail, the extra install commands and a Fail-first tests
  block (a level and the workflows it applies to; workflows with no Reproduce stage are marked). The terminal `init` asks
  "Fail-first tests for bugfixes?" after the Guardrails step (`init --yes` uses off). `/shipline-setup` covers both.
- **Setup is a task hub.** It opens on summary cards (Workflows, Guardrails, Agents & skills, CI check, Phone access,
  Project config, Appearance), each opening a focused page with its own address (`#/setup/<repoId>/workflows/<id>/...`),
  so back, forward and reload keep your place. A workflow is a short list of stages (drag, up/down, delete, Edit); a
  stage is edited on its own page in five steps (Basics, Enforcement, Blocks, Required sections, Rules). The install
  wizard reuses the same stage page. Unsaved edits are kept while moving between Setup pages, with one sticky bar to
  discard or review and save.
- **Selectable palettes.** Classic (the previous indigo), Graphite, Ink, Sage and Mocha (the new default), each in
  light and dark: quiet neutral surfaces with one muted accent. Pick one on the Appearance card (with light, dark or system). The
  choice is per machine (`$SHIPLINE_HOME/ui-preferences.json`, `GET` and `POST /api/preferences`) and applies live to
  every open window and paired phone.

### Changed

- The vendored `lib.mjs`, `guard.mjs`, `stage.mjs`, `ci-check.mjs` and the `shipline-setup` skill have new hashes;
  `upgrade` replaces them where you haven't edited them. `config.yml` is yours and isn't rewritten: a config without the
  new keys uses `install_packages: ask` and `fail_first` off.

## [2.0.0] - 2026-11-16

One UI server for every repo on the machine, and a way to design your own workflows by describing them. The hook
contract (INTERFACE) is unchanged; `upgrade` adds the new skill and scripts (see Added).

### Changed (breaking)

- **`shipline ui` is one server per machine.** Running it in a second repo, or a worktree, opens that repo in the
  server that is already running and exits, instead of starting another server on another port. The running server is
  found through `~/.shipline/server.json`; it lives as long as the terminal that started it. `--port` and a different
  Shipline version don't start a second server (you get a note and the folder is handed over), and `--remote` on a later
  run turns on phone access in the running one.
- **The UI's API paths moved.** Per-repo routes are now `/api/repos/<repoId>/...` (for example
  `/api/repos/<repoId>/chats`); `/api/remote`, `/api/events` and `/pair` are unchanged. Every SSE event a repo sends
  carries a `repoId`. Browser addresses are `#/chat/<chatId>`, `#/new`, `#/all`,
  `#/setup/<repoId>` and `#/health`; the old `#chat`, `#setup` and `#/r/<repoId>/...` redirect.
- **A repo set up before 1.0, or with a newer Shipline, is no longer served in read-only mode.** It is listed with a
  card (uninstall then `init`, or restart with the version it names) and its routes answer 409; other repos keep
  working.
- **One phone URL, one pairing, every repo.** Phone access is one `tailscale serve` mapping for the whole server. A
  paired phone reaches every registered repo.
- **The logs.** Server events (start, handoff, registry changes, phone access on or off, shutdown) go to
  `~/.shipline/ui.log`; each repo keeps its own `ui.log` in its task store.

### Added

- **`/shipline-workflow-designer`**, a skill that creates or changes a workflow from a plain-words description of your
  process: it reads the repo, interviews you, drafts the stages, gates and a rules file for each new stage, and
  validates them. In Setup, **Describe a workflow** and **Change with Claude** (on each workflow) start it in a chat and
  it leaves a draft; a **Draft ready** banner (and a notice in the chat) opens it in the usual diff dialog, where you
  Save or Discard. If the workflow changed since the draft, Save asks you to Overwrite. In a terminal it writes the
  files after you approve a summary. It only uses today's stage fields and agents already in the repo, and never changes
  `config.yml`. Repos installed earlier show "Upgrade this repo to use Describe a workflow" until `upgrade` runs.
- **New `stage.mjs` commands:** `validate <path>` (checks a workflow folder, a `.yml` file or `.shipline`), `draft --tmp`,
  `draft <id> --from <folder>` and `workflows --shipped`. The workflow validator moved into the vendored
  `.shipline/bin/workflow-check.mjs`, shared with the Setup screen. `upgrade` adds it and `.shipline/bin/shipped/*.yml`
  (read-only copies of the shipped workflows).
- **Five more shipped workflows:** Spike / Research, Refactor, Docs (source edits blocked while docs edits stay
  allowed), Dependency bump and Release, with rules files for their new stages. They are offered but not ticked in the
  install wizard and `init` (`init --yes` still installs the four defaults), and listed under **Setup → Add shipped
  workflow**.
- **A machine-wide project list**, `~/.shipline/projects.json`. `init`, `ui` and `upgrade` add a repo, `uninstall`
  removes it, and the first run fills it from the repos that already have task data. A write failure is a warning,
  never a failed command.
- **Chat-first navigation.** One flat chat list across every project (newest first, each row with its project, workflow,
  stage dots and a waiting dot), under items that are always shown: New chat, All projects (with the number of chats
  waiting for you), Setup and Health. The phone's tab bar has the same items. There is no project switcher: New chat and
  Setup have a project dropdown, and a chat's header names its project. Remove from list forgets a project without
  touching its folder or task data; a repo whose folder is gone shows "Folder not found".
- **All projects** (`#/all`, and the **All** tab on a phone): what needs you, one card per project (worktrees grouped
  under their repo, with a health dot, New chat here, Setup and Remove from list), unfinished tasks per project and a
  health summary. It never opens a repo, so it stays fast with many.
- **Health** (`#/health`) replaces the Status row and the Diagnostics sheet: the machine (server and CLI versions,
  Claude, Node, port, phone access, server log) and one row per project (state, setup, config error, chat lock,
  warnings, expandable diagnostics).
- **`upgrade --all`** upgrades every registered repo (each with its own preview and confirmation, or `--yes` /
  `--dry-run` / `--force`), reports a failure and goes on, prints a summary, and exits 1 if any repo failed. It can't be
  combined with `--dir`.
- **The setup wizard inside the running server.** `shipline ui` in a folder without Shipline opens the wizard in the
  server that is running; the folder is listed as "Not set up" until you press Install.

## [1.3.0] - 2026-11-13

Better coverage of stacks beyond Node, and a full setup stepper in the browser. The hook contract (INTERFACE) is
unchanged.

### Added

- **Two ways to set up from the browser.** `shipline ui` in a repo without Shipline now starts with a choice:
  **Set up with Claude** installs the defaults and opens a chat with `/shipline-setup` already sent (it needs Claude
  Code installed and signed in); **Set up here** is a seven-step stepper: workflows, stages and rules (the Setup
  page's stage editor: add, remove and reorder stages, enforcement, confirmation, agent and rules text), agents and
  skills, project settings, every guardrail, and the CI check. Nothing is written until Install, and a problem the
  server finds is listed on Review under the step that fixes it, with a **Go to step** button. `init --terminal` and
  `init --yes` are unchanged.
- **Mark setup as done.** The Setup page's default-rules banner now has this button next to **Run setup with
  Claude**, for a team that tailored everything by hand. It writes `setup: done` into `config.yml`, keeping its
  comments.
- **A working indicator in chats.** While Claude works, the last row of the messages shows an animated mark, what it
  is doing (running a command, editing a file, writing), and how long the turn has run. It survives a reload and
  shows on a second device.
- **Esc interrupts the current turn.** On desktop, Esc stops the turn without ending the chat, and any waiting
  prompts are denied; you can type the next message straight away. **Stop** still ends the chat.
- **Questions and approvals dock above the message box on desktop**, as they already did on a phone, instead of
  sitting in the scrolled history. An answered question stays in the history as one line.

### Changed

- **Deploy, migrate and release rails know more tools.** Commands run through `uv run`, `poetry run`, `pipenv run`,
  `hatch run`, `pdm run`, `rye run`, `npm exec`, `yarn exec` and `bun x` are now matched on the tool behind them
  (`uv run alembic upgrade head` asks first, as `alembic upgrade head` already did). New migrate tools: Laravel
  `artisan migrate`, Ecto, EF Core `dotnet ef database update`, sqlx, diesel, `supabase db push`, Liquibase, Atlas
  and dbmate. New deploy tools: wrangler, firebase, Elastic Beanstalk, SAM, Kamal, Railway, Capistrano and `az`.
  New release tools: `uv`, `poetry`, `hatch`, `pdm`, `flit` and `bun publish`, `gem push`, `mvn deploy`, Gradle
  `publish` tasks and `dotnet nuget push`.
- **More lockfiles are protected by default:** `bun.lock`, `bun.lockb`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`
  and `composer.lock` join the shipped `protected_paths`. `config.yml` is yours, so an existing repo keeps its list:
  add them in **Setup > Guardrails** or by hand.
- **The Verify scope check knows more test and lint files:** RSpec, Minitest, ExUnit, JUnit/Kotlin, xUnit, PHPUnit
  and XCTest tests, and pylint, mypy, pyright, rustfmt, clippy, SwiftLint, PHP_CodeSniffer, PHPStan, Checkstyle,
  detekt, Credo and clang-format/clang-tidy configs.
- **"Does this repo have a UI?" is detected better.** Rails, Laravel, Phoenix, ASP.NET, Twig, Jinja and Astro
  templates, iOS storyboards and Flutter apps count. HTML in generated folders (`target`, `coverage`, `htmlcov`,
  `.venv`, `.next`, `out`, `_build` and the like) no longer does, so a Rust or Python repo that built its docs or a
  coverage report isn't given the Wireframes stage.

### Fixed

- **The "default rules" banner no longer stays after an in-app setup.** Finishing the stepper writes `setup: done`
  (so the Setup page banner and the Claude Code session-start reminder stop), as `/shipline-setup` does.

## [1.2.0] - 2026-11-12

Use the Shipline UI from your phone over your own Tailscale network. The hook contract (INTERFACE) is unchanged.

### Added

- **Phone access.** `shipline ui --remote`, or the new **Setup > Phone access** switch, serves the running UI at
  your machine's `*.ts.net` address through `tailscale serve` (installed repos only). Shipline adds the mapping and
  removes it on exit; a mapping left by a crash is cleaned at the next start.
- **Pairing by QR code.** The link is single use and expires after 5 minutes. The phone names itself, and a paired
  phone can use every page and action the laptop can. Paired devices are global (`~/.shipline/devices.json`), never
  expire and are listed in the panel with Revoke, which cuts a device off at once.
- **Same-Tailscale-user check, and an audit log.** Remote requests must carry the Tailscale identity of the user
  signed in on the computer. Device actions are written to `ui.log` without request bodies.
- The permission relay stays laptop-only.
- **Phone layout.** Below 768 px the UI becomes a phone layout: a bottom tab bar (Chats, New, Setup) with a count of
  chats waiting for an answer, a full-screen chat list with waiting chats first, a compact chat header with the stage,
  and a one-line message box with the model, effort and mode controls behind a + button. A gate question or tool
  approval waits in a bar above the message box, answered with one tap (long questions and full commands or diffs open
  in a bottom sheet). Code blocks and diffs scroll sideways with a Wrap toggle, the message box follows the on-screen
  keyboard, and Setup gets a scrolling section strip and a sticky save bar. The desktop layout is unchanged.
- **Add to home screen.** A web app manifest and an "S" app icon let the phone install the UI as a full-screen app.
- **Short pairing code.** "Pair a phone" also shows an 8-character code (`XXXX-XXXX`) for the phone's new "Enter
  pairing code" form, for a home-screen app that does not share Safari's pairing. The link and the code are one pairing
  (using either uses up both); 5 wrong codes in a row cancel the open pairings.

### Changed

- **Node 22 or newer.** `engines.node` is now `>=22` (was `>=18`), since Node 18 and 20 are end of life. CI tests
  Node 22, 24 and 26. The hook scripts installed in a repo are unchanged and still run on Node 18.

## [1.1.0] - 2026-11-09

Setup is the same everywhere and ends with a clear next step. The hook contract (INTERFACE) is unchanged.

### Added

- **`init` opens the setup wizard in the browser by default** (a terminal, Node 20+). `init --terminal` asks the
  questions in the terminal instead. On Node 18-19 `init` says the wizard needs Node 20+ and asks in the terminal.
  `--yes` and `--dry-run` behave as before.
- **Guardrails and branch pattern at setup.** The wizard and the terminal questions ask for confirmations (Standard or
  Light, new in the terminal), a guardrails switch (off writes every rail as `off` and no protected paths) and the
  branch pattern. The install selection gains optional `guardrails` and `branchPattern` fields.
- **A terminal review before writing.** `init --terminal` prints the settings and the file list, then asks
  `Install these files? (Y/n)`. No writes nothing and exits 1.
- **A numbered next-steps checklist** after install, in the terminal and on the wizard's new "You're set up"
  screen (copy buttons, and an Open Shipline button).
- **An npm README** for the package page.
- **`/shipline-setup` covers guardrails** (rails, `protected_paths`, `rails_commands`, `scope_check`) and describes
  stage blocks with named `actions`.

### Changed

- The terminal questions are grouped into seven numbered steps. A command is left empty by typing `none`.

## [1.0.0] - 2026-11-06

First public release. Shipline installs a Claude Code workflow into a repository with
`npx @forgeyard/shipline init`: stages, rules, enforcement hooks, and task artifacts kept outside the repo.

### Added

- **Workflows.** Feature, Bugfix, Hotfix and Small change, each a list of stages (ticket, feasibility, questions,
  plan, wireframes, implement, verify, pr) defined in `.shipline/workflows/*.yml`, with per-stage rules in
  `.shipline/rules/*.md` and settings in `.shipline/config.yml`.
- **Stage tracking.** `stage.mjs` records progress in a manifest in `~/.shipline`, so task data never lands in the
  repo. Tasks can be resumed in a new session.
- **Confirmations.** Stages marked `confirm_to_advance` need the developer's own answer to a fixed question,
  recorded by a hook. The `light` preset asks only at checkpoint stages.
- **Verify checks.** `stage.mjs check` runs the configured test, lint and build commands, ties the result to the
  code it ran on, and records the scope of the change (test, lint and CI files edited, files outside the plan).
- **Guardrails.** Always-on rails (force-push and push to the default branch, piping a download into a shell,
  printing or reading credentials, deploys, migrations, edits to agent configuration), `protected_paths`, and named
  actions for stage blocks. Each rail is `deny`, `ask` or `off`. The guard covers Edit, Write, Bash, Read and Grep.
- **Pull-request check.** An optional GitHub workflow that fails a PR without a Shipline summary or with an
  unfinished block stage. It runs the base branch's checker and config, so a PR can't relax its own check.
  `stage.mjs pr-summary` produces the summary.
- **Local UI.** `npx @forgeyard/shipline ui` serves a web UI for installing, editing the setup, and following
  tasks and chats (Node 20 or newer).
- **Trackers.** `tracker: none` (the default), `github` or `jira`. With `none` the ticket stage is skipped.
- **CLI.** `init`, `upgrade`, `uninstall` and `ui`, with strict options, per-command `--help`, `--version`, `-y`
  and `--dir <path>`. `init --dry-run` previews the defaults without a terminal, and warns when the folder isn't a
  git repository or a detected command isn't installed.
- **Example.** `examples/todo-node/`, a small Node project to try Shipline on.

### Notes

- Repos set up with a pre-1.0 Shipline (never published to npm) must run `npx @forgeyard/shipline uninstall --yes`,
  then `init`. Task data in `~/.shipline` is kept.

[1.0.0]: https://github.com/siddharth-Spark18/shipline/releases/tag/v1.0.0
