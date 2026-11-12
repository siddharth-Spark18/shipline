# Install, upgrade and uninstall

Everything `init`, `upgrade` and `uninstall` do, and what they write.

[Back to the README](../README.md)

## Requirements

| For | You need |
| --- | --- |
| The hooks, `init --yes`, `upgrade`, `uninstall` | Node 18+ |
| `init --terminal` (it asks questions in the terminal) | Node 20.17+ |
| `shipline ui`, and `init` opening the browser wizard | Node 20+ |
| Everything | [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) signed in, and git |

## Install

Run it from the root of the repo you want to set up, or point at a folder with `--dir <path>`:

```bash
npx @forgeyard/shipline init            # opens the setup wizard in the browser (Node 20+)
npx @forgeyard/shipline init --terminal # ask the same questions in the terminal instead
npx @forgeyard/shipline init --yes      # install the defaults, no questions (-y works too)
npx @forgeyard/shipline init --dry-run  # preview only; without a terminal it previews what --yes would install
npx @forgeyard/shipline init --dir ../other-repo
npx @forgeyard/shipline ui            # in a repo without Shipline: the setup wizard in the browser (Node 20+)
```

The command line is strict: `--help` (or `-h`) works globally and per command, `--version` (or `-v`) prints the
version, the folder is only given with `--dir`, and an unknown option, command or bare argument exits with code 2.

**Installing from the browser.** `shipline ui` in a folder without Shipline opens a short wizard (workflows and
whether the repo has a UI, agents and skills, commands and tracker, the CI check, then a review of every file).
Nothing is written to the repo or to `~/.shipline` until you press **Install**; closing the page writes
nothing. After Install the page shows a "You're set up" screen with the next steps and an **Open Shipline** button
for the normal UI, without restarting the command. In a terminal, `init` starts this wizard by default (Node 20+); on
Node 18-19 it says so and asks the questions in the terminal. The wizard also asks about confirmations (Standard or
Light), the branch pattern and guardrails (on or off, one switch).

**Only the files your choices need.** The same answers give the same files from the wizard, interactive `init`
and `init --yes`. With "no UI", stages marked `condition: ui_only` (Feature's wireframes) and their rules are
left out. Agents are installed only when a stage of a chosen workflow uses them; standalone agents such as
`reviewer` are off by default. Agents that are not installed are recorded as excluded, so `upgrade` does not add
them. The CI check is written only when you pick it. Later, **Setup → Add shipped workflow** adds a workflow
Shipline ships (with its missing rules and agents).

With `init --terminal`, `init` asks in seven numbered steps: workflows and whether the repo has a UI; the test, lint
and build commands (Enter keeps the detected one, type `none` to leave it empty); the tracker; confirmations and the
branch pattern; guardrails on or off; which Shipline agents and which of your repo's own skills to use, and what to do
when one of Shipline's agent names already exists in `.claude/agents/` (keep yours, use ours, or skip); and the CI
check. It then prints a review (the settings and every file it will write) and asks `Install these files? (Y/n)`;
answering no writes nothing and exits with code 1. Guardrails off writes every rail as `off` and no protected paths;
a branch pattern must contain `{slug}`. When it finishes, `init` prints a numbered checklist: commit the setup, open
Claude Code and trust the folder, try a small change, run `/shipline-setup`, and (with the CI check) protect main and
require the check. `--yes` installs every workflow, uses detection for "has a UI", installs
only the agents those workflows use (no standalone agents) and keeps your own agent files on a clash. Without a terminal and
without `--yes` (or `--dry-run`) it refuses. If any other file name collides, it aborts with nothing written. Running it again
reports "already initialized".

`init` also detects your test, lint and build commands from the repo root (Node with npm, pnpm, yarn or bun;
Python with pytest and ruff or flake8; Go; Rust; Make targets) and asks you to confirm them, and asks which
tracker you use (None, the default, GitHub Issues or Jira). With None the ticket stage is skipped. Every stage ships with default rules; run `/shipline-setup` in Claude
Code (or **Setup → Set up with Claude** in the UI) to tailor them to the repo. Until you do, Shipline reminds
you once per developer.

**What gets added to the repo (commit all of it):**

- `.shipline/`: `config.yml`, `workflows/*.yml`, `rules/<stage>.md`, `bin/*.mjs` (the hook and stage scripts,
  dependency-free) and `bin/VERSION`.
- `.claude/agents/` and `.claude/skills/shipline-setup`, `.claude/skills/shipline-workflow`.
- Hook entries and allow rules merged into `.claude/settings.json`.
- A `<!-- shipline:start -->` block in `CLAUDE.md`.

**What stays out of the repo.** Task data (each task's `manifest.json` and artifacts, session state and UI
data) lives in `~/.shipline/projects/<repo path>/`, the way Claude Code keeps its chats. It is personal, not
shared through git. A new session resumes your unfinished tasks from there.

## Upgrade and uninstall

```bash
npx @forgeyard/shipline upgrade [--dir <path>] [--yes] [--dry-run] [--force]
npx @forgeyard/shipline uninstall [--dir <path>] [--yes] [--dry-run] [--purge]
```

**upgrade** shows a preview and asks before changing anything. `--dry-run` only previews, `--yes` skips the
question, `--force` also replaces Shipline files your team edited (they are skipped otherwise). Your `config.yml`,
workflows and rules are yours: only an untouched shipped rules file is replaced. It never commits: review and commit
the result.

**Coming from a pre-1.0 Shipline.** Versions before 1.0 were never published to npm, so `upgrade` doesn't migrate
them: it exits with an error and changes nothing. Run `npx @forgeyard/shipline uninstall --yes`, then `init` again.
Task data in `~/.shipline` is kept. (`init` on such a repo says "already initialized", so uninstall first.)

**uninstall** previews what it will remove, then asks. It removes `.shipline/`, the agents and skills Shipline
installed (agents you kept as your own are left alone), the `CLAUDE.md` block, and Shipline's hook entries and
allow rules in `.claude/settings.json`. It asks separately whether to delete this repo's task data in
`~/.shipline/projects/<repo>/`; with `--yes` that data is kept unless you also pass `--purge`. It deletes
files only and never runs git: commit the removal yourself. It refuses while a Shipline UI chat holds the
repo (stop the UI first).
