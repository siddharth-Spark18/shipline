# Shipline

Shipline installs a workflow for [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) into your
repository. Claude follows stages (ticket, plan, implement, verify, pull request) and hooks stop the steps that
shouldn't happen yet: editing source before the plan is done, committing before verify, pushing to main, printing
credentials. Task data stays out of the repo, in `~/.shipline`.

## Quickstart

From the root of your repo:

```bash
npx @forgeyard/shipline init             # opens the setup wizard in your browser (Node 20+)
npx @forgeyard/shipline init --terminal  # or answer the same questions in the terminal
npx @forgeyard/shipline init --yes       # or install the defaults without questions
```

The wizard and the terminal ask for your workflows, commands, tracker, confirmations, branch pattern and
guardrails, show what will be written, and end with a checklist of what to do next. Then open Claude Code in the
folder (`claude`), trust it when asked, and ask for a small change.

## What gets installed

- `.shipline/`: config, workflows, per-stage rules and the dependency-free hook scripts.
- `.claude/`: agents, the `/shipline-setup` and workflow skills, and hook entries in `settings.json`.
- A marked block in `CLAUDE.md`.
- Optionally, a GitHub Actions check for pull requests.

Commit all of it so teammates get the same flow.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Sets Shipline up in a repo. Flags: `--terminal`, `--yes`, `--dry-run`, `--dir <path>` |
| `ui` | Opens the local web UI (the setup wizard if Shipline isn't installed). Flags: `--remote`, `--port`, `--no-open`, `--dir <path>` |
| `upgrade` | Updates the installed files to this version. Flags: `--yes`, `--dry-run`, `--force`, `--dir <path>` |
| `uninstall` | Removes what `init` installed. Flags: `--yes`, `--dry-run`, `--purge`, `--dir <path>` |

Run `npx @forgeyard/shipline <command> --help` for details.

## Use it from your phone

`npx @forgeyard/shipline ui --remote` serves the UI to your own phone over [Tailscale](https://tailscale.com), so you
can answer a waiting gate or permission prompt away from your desk. Pair the phone with the QR code in **Setup >
Phone access**. Nothing is public and there is no relay.
[How to set it up](https://github.com/siddharth-Spark18/shipline/blob/main/docs/phone-access.md).

## Requirements

- Node 18+ for the hooks, `init --yes`, `upgrade` and `uninstall`.
- Node 20+ for the UI and the browser wizard (20.17+ for `init --terminal`).
- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) signed in, and git.

## Learn more

- [Full README](https://github.com/siddharth-Spark18/shipline#readme)
- [Changelog](https://github.com/siddharth-Spark18/shipline/blob/main/packages/cli/CHANGELOG.md)
- [License (MIT)](https://github.com/siddharth-Spark18/shipline/blob/main/LICENSE)
- [Report an issue](https://github.com/siddharth-Spark18/shipline/issues)
