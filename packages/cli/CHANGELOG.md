# Changelog

All notable changes to `@forgeyard/shipline` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
