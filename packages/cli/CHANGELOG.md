# Changelog

All notable changes to `@forgeyard/shipline` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
