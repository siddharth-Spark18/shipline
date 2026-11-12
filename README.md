# Shipline

Shipline installs one shared, guardrailed workflow into a git repo so that everyone using Claude Code there
works the same way: pick a workflow, move through stages, save an artifact for each stage, and let hooks
stop the steps that shouldn't happen yet (editing source before the plan is done, committing before verify).

[MIT license](LICENSE) · [Changelog](packages/cli/CHANGELOG.md)

## Quickstart

You need Node 18+, git and [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) signed in.

**1. Install it in a repo.** From the repo's root:

```bash
npx @forgeyard/shipline init            # opens the setup wizard in your browser (Node 20+)
npx @forgeyard/shipline init --terminal # or ask the same questions in the terminal (Node 20.17+)
npx @forgeyard/shipline init --yes      # or install the defaults without questions
```

Both ways ask the same things, show a review of what will be written, and end with a numbered checklist of what to do
next. Add `--dry-run` to preview only.

`init` writes `.shipline/`, some `.claude/` files, hook entries in `.claude/settings.json` and a block in `CLAUDE.md`.
It detects your test, lint and build commands, prints what it did, and warns (without stopping) if the folder
isn't a git repo or a detected command isn't installed. Commit what it added so teammates get the same flow.

Want to try it first? [`examples/todo-node`](examples/todo-node) is a tiny project made for this.

**2. Open Claude Code in the repo and ask for a change:**

```bash
claude
> Add a way to delete a todo
```

**3. What a session looks like.** Claude picks a workflow and says so. A typo or one-file fix is the Small change
workflow: it announces that and starts. Anything else it asks about once ("This looks like a feature, so I'll follow
the Feature workflow. OK?"). Then it works through the stages and keeps a list:

```
[-] ticket (No tracker)
[x] feasibility
[x] questions
[>] plan
[ ] implement
[ ] verify
[ ] pr
```

- **Open questions and Plan.** Claude writes `questions.md` and `plan.md` and stops to ask you ("Advance?" or "Not yet")
  at the stages that need your OK. Source files can't be edited until the plan is done.
- **Verify.** Claude runs your test, lint and build commands through `stage.mjs check` and lists the results
  (`test ✓ 1.2s · lint ✓ 0.1s`). If a command fails, or the change edits tests or files the plan didn't list, it
  tells you and asks before finishing.
- **Commit and PR.** Claude opens the PR and ends the description with the summary from `stage.mjs pr-summary`:
  the stage table, the checks line and the plan's scope.

```
### Shipline
| Stage | Status | Confirmed |
| --- | --- | --- |
| plan | done | your answer |
| verify | done | your answer |

**Checks:** test ✓ 0.2s · lint ✓ 0.1s
**Scope:** no test, lint or CI files touched, nothing outside the plan
```

While it works, hooks stop the dangerous steps: pushing to `main`, `curl ... | sh`, reading `.env`, and edits to
Claude's own configuration (those ask you first). Task files live in `~/.shipline`, not in your repo.

**4. Optional: the browser UI.** `npx @forgeyard/shipline ui` opens a local page where you can chat with Claude in
the repo, watch each task's stages, and edit the setup. Tailor the default rules to the repo with `/shipline-setup`
in Claude Code, or Setup, Set up with Claude, in the UI.

**Something wrong?** [Troubleshooting](#10-troubleshooting). To remove it again: `npx @forgeyard/shipline uninstall`.

## 1. What Shipline is

- **Workflows.** Feature, Bugfix, Hotfix and Small change. Each is a list of stages (for example Feasibility,
  Open questions, Plan, Implement, Verify, Commit and PR). Claude picks the workflow and starts it.
- **Stages and artifacts.** Each stage has rules (`.shipline/rules/<stage>.md`) and an artifact (such as
  `plan.md`) that must exist before the stage can finish. Progress is recorded with `stage.mjs`.
- **Guardrails.** Hooks in `.claude/settings.json` run on every session. A stage can only guide, warn, or block.
- **A browser UI.** `npx @forgeyard/shipline ui` is a local web app to chat with Claude in the repo, edit the
  setup (workflows, rules, agents and skills) and watch tasks.

Everything Shipline adds to the repo is plain files you commit. Teammates get it on clone, with nothing to
install beyond Node.

## 2. Requirements

| For | You need |
| --- | --- |
| The hooks, `init --yes`, `upgrade`, `uninstall` | Node 18+ |
| `init --terminal` (it asks questions in the terminal) | Node 20.17+ |
| `shipline ui`, and `init` opening the browser wizard | Node 20+ |
| Everything | [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) signed in, and git |

## 3. Install

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

## 4. Daily use

Open Claude Code in the repo and describe the work. Claude follows the `shipline-workflow` skill:

1. **Picks a workflow.** For a typo, rename, config tweak or one-file fix it says "Using the Small change
   workflow" and starts. For anything else it asks once ("This looks like a feature, so I'll follow the
   Feature workflow. OK?"). Quick questions don't start a workflow.
2. **Works stage by stage.** Default stages:

   | Workflow | Stages |
   | --- | --- |
   | Feature | Ticket (optional), Feasibility, Open questions, Plan, Wireframes (UI work only), Implement, Verify, Commit and PR |
   | Bugfix | Ticket (optional), Reproduce, Root cause, Fix, Verify, Commit and PR |
   | Hotfix | Ticket (optional), Fix, Verify, Commit and PR |
   | Small change | Ticket (optional), Implement, Verify, Commit and PR |

3. **Asks you at the gates.** Stages with `confirm_to_advance: true` need your OK before Claude moves on.

**Enforcement.** Each stage sets `enforcement`:

- `guide`: advice only; nothing is stopped.
- `warn`: Claude gets a reminder when it does something the stage holds back.
- `block`: the tool call is denied until the stage that holds it back is done. By default, editing source is
  blocked until Plan is done, and `git commit` / `gh pr create` until Verify is done.

A config.yml that can't be read doesn't lock you out or turn the guardrails off: the rails use their built-in
defaults and every call carries a warning that says so. Other unexpected hook errors fail open with a visible
warning. Hooks run inside Claude; they are not a server-side gate.

**`stage.mjs`.** Claude records progress with it; you can run it too from the repo root:

```bash
node .shipline/bin/stage.mjs workflows                 # list workflows
node .shipline/bin/stage.mjs start --workflow feature --title "Add export" [--ticket PROJ-12 | --ticket 123]
node .shipline/bin/stage.mjs status                    # where am I (--verbose adds the rules text and full paths)
node .shipline/bin/stage.mjs advance                   # finish the stage (asks you first where the stage needs your OK)
node .shipline/bin/stage.mjs skip --reason "no ticket" # optional stages
node .shipline/bin/stage.mjs check                      # run the test, lint and build commands and record the results
node .shipline/bin/stage.mjs pr-summary                # the summary to paste into the PR description
node .shipline/bin/stage.mjs reopen <stage>            # go back
node .shipline/bin/stage.mjs resume <task folder>      # pick up an unfinished task
```

Outside a Claude Code session (no session id), `status` lists the unfinished tasks on the current branch.

## 5. The browser UI

```bash
npx @forgeyard/shipline ui [--dir <path>] [--port <n>] [--no-open] [--remote]
```

It starts a server on `127.0.0.1` (a random port unless `--port`) for the repo you run it in and opens
`http://127.0.0.1:<port>/?t=<token>`. Ctrl+C stops it. The token is swapped for a cookie on first load, and
requests with a foreign `Host` or `Origin` are refused. The UI is optional: the hooks enforce the workflow
with or without it. It runs your own installed `claude` and never sees your Claude credentials.

- **Chat:** talk to Claude in the repo. Permission and question prompts appear in the page. A chat can always
  be continued in a terminal with `claude --resume <id>`. One chat can work through several tasks: its side
  panel lists every task it touched (the current one with its stages and files), plus a collapsible list of the
  working-tree changes. Unfinished tasks no chat is working on appear on the new-chat screen with **Resume**.
- **Setup:** forms for `config.yml`, each workflow and each rules file. Saving shows a diff first, keeps the
  fields it doesn't know, and lists open tasks that still use an old stage list. Commit the files after saving.

  ![Setup: workflows](docs/images/setup.png)

  The **Agents & skills** tab chooses which Shipline agents and repo skills are installed.

  ![Setup: Agents & skills](docs/images/agents-skills.png)


### Use it from your phone

A chat that stops at a gate or a permission prompt waits for you. With phone access you open the same UI on your own
phone, over your own [Tailscale](https://tailscale.com) network, and answer it from there. A paired phone can do
everything the laptop page can. It works only while your computer is awake and `shipline ui` is running, and only
for an installed repo (not in the install wizard).

1. Install Tailscale on the computer and the phone, and sign in to the same account on both.
2. In the Tailscale admin console, turn on **HTTPS certificates** (DNS page).
3. Start the UI with `--remote`, or open **Setup > Phone access** and switch it on. Shipline runs
   `tailscale serve` for you and removes it when you stop the UI or switch it off.
4. In **Setup > Phone access** press **Pair a phone** and scan the QR code with the phone. The link works once and
   expires after 5 minutes. Name the device on the phone's screen.
5. Optional: **Add to home screen** (Safari: Share > Add to Home Screen) to open Shipline full screen like an app. A
   home-screen app may not share Safari's pairing, so if it opens as "not paired", press **Enter pairing code** there and
   type the 8-character code (`XXXX-XXXX`, any case, dash optional) that **Pair a phone** shows under the QR code. The
   code and the QR link are one pairing: using either uses up both, and after 5 wrong codes in a row the pairing is
   cancelled and you make a new one.

On a phone the UI switches to a phone layout (narrower than 768 px): a tab bar with Chats, New and Setup, and a chat
that waits for you shows its question or tool approval in a bar above the message box, answered with one large tap.

Paired devices are kept in `~/.shipline/devices.json` (or `$SHIPLINE_HOME`), for every repo, and stay paired until you
**Revoke** them in the same panel (which cuts them off at once). Turning phone access off keeps the pairings.

Security notes:

- Traffic goes only through your tailnet, over HTTPS. Nothing is public and there is no relay.
- A request must come from the same Tailscale user that is signed in on the computer, and from a paired device
  (a secret cookie; only its hash is stored). Another person on your tailnet cannot use it, even on a shared machine.
- The phone can do what you can do in the UI, so treat a paired phone like a logged-in terminal. Revoke a lost phone.
- Device actions are written to the repo's `ui.log` (who, method, path, status; never message text).
- If port 443 is taken on your tailnet name, Shipline uses 8443 or 10000 and never changes a mapping it didn't make.

A repo set up by a newer Shipline is read-only in the UI and shows the `npx @forgeyard/shipline@<version> ui` command to run.

## 6. Configuration reference

**`.shipline/config.yml`**

```yaml
branch_pattern: "{type}/{key}-{slug}"   # {key} = PROJ-12 (Jira) or issue-123 (GitHub), dropped with no ticket
tracker: none                           # none (skip the ticket stage), github (the gh CLI) or jira (Atlassian MCP); read-only
commands:                               # filled by init from the repo; the Verify stage runs only these
  test: "pnpm test"
  lint: "pnpm run lint"
  build: "pnpm run build"
confirmations: standard                 # standard | light: how often Claude asks before advancing (see Confirmations)
skills: []                              # your own .claude/skills/<name> that Claude may use at any stage
setup: done                             # written by /shipline-setup; stops the setup reminder
rails: { ... }                          # always-on guardrails, deny | ask | off each (see Guardrails)
protected_paths: [ ... ]                # globs that ask before an edit, in any stage
scope_check: { enabled: true }          # Verify: flag edits to tests, lint and CI, and files outside the plan
```

**Workflow files** (`.shipline/workflows/<id>.yml`): `id`, `name`, `description` and a list of `stages`. Stage fields:

| Field | Meaning |
| --- | --- |
| `id`, `name` | The stage's id (also the rules file name) and label |
| `artifact` | File in the task folder that must exist to finish the stage |
| `optional` | The stage may be skipped |
| `condition: ui_only` | Runs only when the task is flagged as UI work |
| `agent` | Suggested subagent |
| `confirm_to_advance` | Ask the developer before moving on |
| `checkpoint: true` | With `confirm_to_advance`: the stage still asks in light mode (see Confirmations) |
| `enforcement` | `guide`, `warn` or `block` |
| `sections` | Headings the artifact must contain, each with some text under it, before the stage can finish (the defaults: Plan needs `Scope`, `Files to touch`, `Verification`; Verify needs `Checklist`; Root cause needs `Cause`, `Evidence`; Feasibility needs `Risks`) |
| `checks: true` | The stage (Verify, by default) can't finish until `stage.mjs check` has run the test, lint and build commands on the current code and they passed, or you accepted the failures |
| `blocks` | What is held back until this stage is done: `{ tools: 'Edit\|Write', allow_paths: [globs] }`, `{ bash: 'regex' }` or `{ actions: [commit, pr] }` (see [Guardrails](#7-guardrails)) |

**Checks and PR evidence.** `stage.mjs check` runs `commands.test`, `commands.lint` and `commands.build` itself, records each
exit code, duration and output tail in the task, and fingerprints the code it ran on (a git tree id that includes
uncommitted files; your real index is never touched). On a `checks: true` stage, `advance` refuses a missing run or a run
on code that has since changed. When a command failed, it asks you whether to finish anyway. `pr-summary` then shows a
Checks line plus the plan's scope and the verification checklist in collapsed sections. The CI check compares the
summary's fingerprint with the PR's git tree. With `ci.stale_checks` in `config.yml` set to `warn` (the default) it warns
when they differ, with `fail` it fails. A command that failed and wasn't accepted fails the check either way. A hand-edited
summary can still lie: this is evidence for reviewers, not a signature.

**Confirmations.** `confirmations` in `config.yml` sets how often Claude asks before moving to the next stage, for the
whole repo.

- `standard` (the default, and what a missing key means): Claude asks at every stage with `confirm_to_advance: true`.
- `light`: Claude asks only at stages that also have `checkpoint: true`, which the shipped Feature workflow sets on Plan
  and Bugfix on Root cause. The other stages advance on the deterministic checks. A workflow with no checkpoint stage
  never asks to advance in light mode; Setup shows a note when that is the case.

In both modes Claude still asks before skipping a required stage, before finishing with failed checks, and when the
Verify scope check flags something. The rule is shared by the hooks, the CI check and the UI, and a change takes effect
on the next `advance`. Pick it in Setup, in the install wizard, or in `/shipline-setup`.

**Rules files** (`.shipline/rules/<stage>.md`): plain Markdown that Claude reads before each stage. They ship
with default guidance; `upgrade` replaces a rules file only while it is still an untouched shipped version.

With `tracker: none` (the default) the ticket stage is skipped automatically, with no question; a `--ticket` given
at start still goes into the branch name. With `tracker: github`, a task started from issue #123 gets the branch `feature/issue-123-…`, the ticket stage
reads the issue with `gh issue view`, and `pr-summary` starts with `Closes #123`.

**`.shipline/bin/VERSION`**: JSON recording the package version, the interface version, a hash of each
Shipline-owned file (so `upgrade` knows what you edited) and `excluded` (agents you kept as your own).

**`SHIPLINE_HOME`**: where task data lives. Default `~/.shipline`. With a custom value Claude asks permission
for artifact writes, because the allow rules cover `~/.shipline/**`.

The config files are YAML read by a small built-in parser (a constrained subset) so hooks have no dependencies.
Line endings are kept: a CRLF file stays CRLF when Shipline saves it.

## 7. Guardrails

Stage blocks only hold back what a stage says to hold back. Guardrails are on in every stage, with or without a
task, and cover the actions teams most often forbid an AI agent. They are set in `.shipline/config.yml` or in the
browser UI under Setup, Guardrails. Each rail is `deny` (the call is refused), `ask` (Claude Code's own permission
prompt shows) or `off`; a rail left out of the file uses its default.

| Rail | New installs | What it catches |
| --- | --- | --- |
| `force_push_default` | deny | `git push --force`, `-f`, `--force-with-lease` or a `+branch` refspec to the default branch, `git push --delete origin main`, `git branch -D main` |
| `push_default` | ask | any `git push` whose target is the default branch (`main`, `HEAD:main`, or a bare `git push` while on it) |
| `pipe_to_shell` | deny | `curl` or `wget` piped into `sh`, `bash`, `zsh`, `python`, `node`, `perl`, `ruby` and the like, and the same through process substitution (`bash <(curl ...)`, `source <(wget ...)`) or command substitution (`sh -c "$(curl ...)"`) |
| `print_credentials` | deny | any command that names a credential file, except ones that never print contents (see below); `git diff`, `git show`, `git log -p` and `git blame` on one; `printenv`; `echo $GITHUB_TOKEN` |
| `read_credentials` | ask | the Read tool on credential files, and the Grep tool when its `path` is one or its `glob` matches one |
| `deploy` | ask | `kubectl apply`, `helm upgrade`, `terraform apply`, `fly deploy`, `vercel --prod`, `npm run deploy` and similar; add yours under `rails_commands.deploy` |
| `migrate` | ask | `prisma migrate deploy`, `rails db:migrate`, `alembic upgrade`, `python manage.py migrate` and similar; add yours under `rails_commands.migrate` |
| `agent_config` | ask | Edit or Write on `.claude/**`, `.shipline/**`, `CLAUDE.md` and `.mcp.json` |

Credential files are `.env` and `.env.*` (not `.env.example`, `.sample` or `.template`), `.envrc`, `*.pem`, `*.key`,
`*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `credentials.json`, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`,
`.pypirc`, `.docker/config.json`, `~/.ssh/**`, `~/.aws/**`, `~/.docker/**`, `~/.config/gcloud/**` and `~/.kube/config`.
Paths and globs match without regard to case (`.ENV`, `.CLAUDE/settings.json`).

**`print_credentials` names the file, not the command.** After the command is split at `&&`, `;` and `|`, any
non-flag argument that is a credential file (or a `< file` redirection) is denied, whatever the command: `cat`, `tac`,
`sort`, `jq . .env`. Commands that never print contents are allowed: `ls`, `stat`, `test`, `[`, `touch`, `rm`, `mv`,
`cp`, `chmod`, `chown`, `file`, `wc`, `du` (plus `cd` and `tee`), and `git add`, `git rm`, `git mv`, `git status`. So
`ls -la .env` and `cp .env .env.bak` pass, `ls .env && cat .env` is denied because of the `cat`, and `cp .env /dev/stdout`
is denied because the destination prints. Writing into a credential file (`> .env`) isn't printing; the write rules
cover it.

The default branch comes from `origin/HEAD` (else `main`, else `master`) and is cached for ten minutes in the task
store. If several rails match, the strictest wins: deny over ask over a stage `warn`.

**Protected paths.** `protected_paths` is a list of globs relative to the repo root (new installs list migrations,
infrastructure, Dockerfiles, CI config and lockfiles). Editing one asks first, in any stage, with or without a task,
through the file tools and, best effort, through Bash (`>`, `>>`, `tee`, `sed -i`, `mv`, `cp`, `rm`).

**Named actions.** A stage block can hold back `{ actions: [...] }` instead of a regex: `commit`, `push`, `pr`,
`merge`, `release`, `deploy`, `migrate`. They match the parsed command, so `git -c user.name=x commit`,
`cd sub && git commit`, `sudo git commit`, `bash -c 'git commit'` and `npm run release` are all caught. A package
script counts when its name or its `package.json` body matches. `{ bash: 'regex' }` still works as before. Shipped
verify stages use `actions: [commit, pr]`.

**Verify scope check.** `stage.mjs check` also compares the working tree with the commit the task started from
(`base_commit`) and records which changed files are tests, lint config or CI config, and which are not listed in the
plan's "Files to touch" (lockfiles, `.shipline/` and `.claude/` are ignored). If there are any, finishing the stage
asks you an extra question, and `pr-summary` shows a Scope line and the two lists. The CI check shows it for
information and never fails on it. Turn it off with `scope_check: { enabled: false }`; add globs with
`scope_check.sensitive_extra`.

**Failure modes.** If the code that protects the task store throws, only that step is skipped and the rails still run.
If `config.yml` can't be read, the rails use their defaults (and ask before edits to `.shipline/config.yml`, which may
be the file you are fixing); every call says so.

### Hooks are defence in depth

Guardrails run in Claude Code's hooks and parse the command text. They stop mistakes, not a determined user or a
determined agent. They do not see aliases, shell functions, `eval`, a script that is written and then run, another
tool that pushes (an IDE, a git GUI), or anything beyond one level of `sh -c` or package-script indirection. Parsing is
best effort and the deploy and migrate patterns will never be complete: extend them with `rails_commands`.

For limits that hold, use Claude Code's own controls: its `sandbox` settings, and managed settings that users can't
override. For example, deny rules in `.claude/settings.json` (or the managed file):

```json
{
  "permissions": {
    "deny": ["Bash(git push --force:*)", "Bash(curl:*)", "Read(./.env)", "Read(./.env.*)", "Read(~/.ssh/**)"]
  }
}
```

**Permission modes.** A rail set to `ask` returns Claude Code's `permissionDecision: "ask"`. In a check with
Claude Code 2.1.318 in headless (`claude -p`) mode, a hook that asked kept the command from running in `manual`,
`auto` and `bypassPermissions` modes alike, while the same command ran freely without the hook. So `ask` was not
skipped in `auto` or `bypassPermissions`, but headless mode can't show a prompt, so what a person sees in an
interactive `auto` or `bypassPermissions` session was not checked. If you must not rely on a prompt, set the rail
to `deny`.

## 8. The pull-request check

`init` can add `.github/workflows/shipline.yml` (the CI check, off unless you pick it). It fails a PR whose
description has no Shipline summary (paste the output of `stage.mjs pr-summary`; the `ci:` block in `config.yml`
sets whether the `shipline:skip` label can stand in) or whose summary shows a `block` stage that isn't done.

**It uses the base branch's checker and config.** The workflow checks out the PR head into `head/` and the base
commit into `base/`. When the base has `.shipline/bin/ci-check.mjs`, it runs that script from `head/` with
`--config-from ../base`: `config.yml` and the workflow files are read from the base, while the git tree and the checks'
fingerprint come from the PR. So a PR can't loosen its own check by editing `config.yml` (for example setting
`ci.missing_block: warn`). The PR that first adds Shipline has no base copy, so its own script runs. It uses the plain
`pull_request` trigger and needs no secrets, so it also works on PRs from forks.

**A PR can still edit the workflow file itself.** Real enforcement needs two things on GitHub: make the Shipline check
a required status check in branch protection, and require review from code owners for `.shipline/` and `.github/`. A
sample `.github/CODEOWNERS`:

```
# Changes to Shipline's rules and CI need an owner's review.
/.shipline/   @your-org/platform-team
/.github/     @your-org/platform-team
```

## 9. Upgrade and uninstall

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

## 10. Troubleshooting

- **A hook warning appears at session start or on a tool call.** Read it: it names the problem (a config
  that doesn't parse, a missing stage). A config.yml that can't be read keeps the guardrails on with their
  defaults ("guardrails are using their defaults"); fix the file shown, or run `npx @forgeyard/shipline ui` and use Setup.
- **A tool call was denied.** A `block` stage isn't done yet. Finish that stage or tell the developer; don't
  work around it.
- **"Shipline is already initialized".** `init` found `.shipline/`, the `CLAUDE.md` block or the hooks. To
  change agents and skills use the UI (Setup, Agents & skills); to update use `upgrade`; to start over use
  `uninstall`, then `init`.
- **`upgrade` says "pre-1.0 Shipline".** See [Upgrade and uninstall](#9-upgrade-and-uninstall): uninstall, then `init`.
- **"Repo newer".** The repo was set up by a newer Shipline than the one you ran. Run the newer version, for
  example `npx @forgeyard/shipline@<version> ui`, or `upgrade` with the latest.
- **A task seems lost.** Tasks are stored per repo path under `~/.shipline/projects/`. If you moved or renamed
  the repo folder, the store key changed and the old folder is still on disk; move it to the new key or work
  from the old path. Also check you are on the same machine and `SHIPLINE_HOME` is unchanged.
- **Windows.**
  - Install [Git for Windows](https://git-scm.com/download/win); Claude Code itself requires it.
  - The hook command is `node "$CLAUDE_PROJECT_DIR/.shipline/bin/<x>.mjs"`, which relies on Claude Code
    running hooks through Git Bash. That is untested here; if hooks show an error, please report it.
  - `shipline ui` opens your browser with `start`, and stops a chat with `taskkill`. Stopping can take a few
    seconds.
  - Task data is in `%USERPROFILE%\.shipline`. A repo at `C:\Users\you\repo` is stored as `C--Users-you-repo`.
  - Existing CRLF files keep CRLF when Shipline saves them; new files use LF.

## 11. Contributing

The repo holds only the CLI product:

```
packages/cli   the npm package: bin, src (init, upgrade, uninstall, UI server), templates (what init installs), tests
packages/ui    the React app behind `shipline ui` (built into packages/cli/ui-dist)
docs/          plans and images
.github/       CI and the publish workflow
```

```bash
pnpm install            # the only native build is esbuild
pnpm build:ui           # builds packages/ui into packages/cli/ui-dist
pnpm test               # all CLI tests (Node 20)
pnpm --filter ./packages/cli test:hooks   # the hook and init tests, which must pass on Node 18
```

After changing anything under `packages/cli/templates/`, run `node packages/cli/scripts/hash-templates.mjs` to
record the new template hashes. When a rules template changes, also keep the old text's hash in
`packages/cli/src/known-stub-rules.mjs`, so `upgrade` can still tell an untouched copy from an edited one.

**CI** (`.github/workflows/cli.yml`) runs the hook tests on Node 18 and the full suite plus the UI typecheck and
bundle-size check on Node 20, on Ubuntu, macOS and Windows.

**Releasing.** Bump the version in `packages/cli/package.json`, add a `## [<version>]` entry to
`packages/cli/CHANGELOG.md`, run the hash script, commit, then push a tag `v<version>` (for example `v1.0.0`).
`.github/workflows/publish.yml` checks that the tag matches the package version, that the CHANGELOG has the heading and
that the hashes are recorded, and publishes `@forgeyard/shipline` to npm through **trusted publishing** (GitHub's OIDC
identity, no npm token stored anywhere; the package's Settings → Trusted publishing on npmjs.com names this repo and
`publish.yml`). A version that is already on npm is skipped. 1.0.0 was published by hand to create the package, since
npm only accepts a trusted publisher for a package that already exists.

Older design documents live in `docs/plans/`; those describing the v1 hub are marked historical.

## License

[MIT](LICENSE). See the [changelog](packages/cli/CHANGELOG.md) for what changed in each release.
