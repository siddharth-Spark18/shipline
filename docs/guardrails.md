# Guardrails and the pull-request check

The always-on rails, protected paths, named actions, the Verify scope check, and the CI check for pull requests.

[Back to the README](../README.md)

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
| `deploy` | ask | `kubectl apply`, `helm upgrade`, `terraform apply`, `fly deploy`, `vercel --prod`, `wrangler deploy`, `firebase deploy`, `kamal deploy`, `npm run deploy` and similar; add yours under `rails_commands.deploy` |
| `migrate` | ask | `prisma migrate deploy`, `rails db:migrate`, `alembic upgrade`, `python manage.py migrate`, `php artisan migrate`, `mix ecto.migrate`, `dotnet ef database update` and similar, also through `npx`, `uv run`, `poetry run` and other runners; add yours under `rails_commands.migrate` |
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

## The pull-request check

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
