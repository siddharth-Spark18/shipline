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
| `install_packages` | ask | commands that fetch a package by name (see below); add yours under `rails_commands.install_packages` |
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

**`install_packages`.** About one in five packages an AI suggests doesn't exist, and attackers register those names
("slopsquatting"). The rail shows Claude Code's permission prompt, naming the packages, before a command that adds a
named package, runs a package that isn't a dependency, or installs globally. It checks the parsed command, so it also
sees through `npx`, `pnpm exec`, `bundle exec`, `python -m` and `uv run` / `poetry run`, and each part of a chain
(`npm i a && npx b`) is checked, with every package listed in the reason.

- **Adds a named package:** `npm`/`pnpm`/`bun` `add`, `install <name>` and `i <name>`; `yarn add`; `pip install <name>`
  (and `pip3`, `python -m pip`, `uv pip install`); `uv add`, `poetry add`, `pipenv install <name>`, `pdm add`,
  `rye add`; `cargo add`; `go get <path>` and `go install <path>@<version>`; `gem install`, `bundle add`,
  `composer require`, `dotnet add package`. A name that is already a dependency still asks (a version change fetches it).
- **Runs a package that isn't a dependency:** `npx`, `bunx`, `npm exec` and `pnpm exec` ask only when the package isn't
  in `dependencies`, `devDependencies` or `optionalDependencies` of a `package.json` from the command's folder up to the
  repo root and has no `node_modules/.bin/<name>`. `npx vitest` in a repo that has vitest doesn't ask; `npx -p <pkg>`
  checks `<pkg>`. `pnpm dlx`, `yarn dlx`, `uvx` and `pipx run` always ask, because they exist for one-off packages. If
  `node_modules` isn't installed yet, an `npx` of a listed tool asks until it is.
- **Global or system installs:** `npm install -g`, `pnpm add -g`, `yarn global add`, `bun add -g`, `pipx install`,
  `uv tool install`, `cargo install <name>`, `brew install`, `apt` / `apt-get`, `dnf`, `yum`, `choco` and `winget install`.
- **Never caught:** restoring from a lockfile or manifest (`npm install`, `npm ci`, `pnpm install`,
  `pip install -r requirements.txt`, `bundle install`), local paths, workspace references and tarballs
  (`npm i ./pkg`, `pnpm add workspace:*`, `pip install -e .`). Git and HTTP URLs are caught and shown as the URL.
- **Your own install commands:** `rails_commands.install_packages` takes plain prefixes (`make deps`), matched like
  `rails_commands.deploy`.

Nothing is looked up on a registry (hooks make no network calls), so the prompt asks you to check that each name is the
one meant. Existing repos get this rail at `ask` after upgrading, without editing `config.yml`; set
`rails.install_packages: off` to turn it off.

**Fail-first tests for bugfixes.** `fail_first` asks a bugfix to show a test that fails before the fix. It is off by
default:

```yaml
fail_first:
  level: off          # off | note | section | proof
  workflows: [bugfix] # each needs a stage with the id `reproduce`
```

- `note`: when Reproduce starts or is resumed, `stage.mjs` prints a built-in note, before the repo's own rules, telling
  Claude to write a test that fails on the current code and name it in `reproduction.md`.
- `section`: the note, and `reproduction.md` must have a `## Failing test` section (with text under it) before Reproduce
  can finish.
- `proof`: the note, and `node .shipline/bin/stage.mjs check --expect-fail [test file or name]` must have recorded a
  failing run. It runs only `commands.test`, with your extra words appended; each may contain only letters, digits and
  `_ . / : @ = , + -` (no spaces, quotes, shell characters or `..`), because `stage.mjs` runs without a permission
  prompt. A failing run is recorded in the task ("Failing as expected"); a passing run records nothing, since that
  test doesn't reproduce the bug. With no `commands.test`, advancing is refused rather than downgraded.
- When a failing run is recorded, Verify's output and `pr-summary` show "Fail-first: failed before (exit N on
  `<fingerprint>`), passed after (on `<fingerprint>`)", using the latest test result for the "after". The CI check shows
  it for information and never fails on it.
- At Reproduce of a workflow `fail_first` applies to, test files (`test/`, `*.test.*`, `*_test.go`, and the other
  patterns the scope check treats as tests) can be written even though the Root cause stage blocks edits, so Claude can
  write the failing test. Source files stay blocked until Root cause is done. With `fail_first: off`, or for a workflow
  not listed, nothing changes.
- Skipping Reproduce with `stage.mjs skip --reason "..."` still works (with your confirmation when the stage is
  required): that is your override. The setting is read when you advance, so it applies from the next Reproduce advance
  of a task started earlier. Listing a workflow with no `reproduce` stage gives a warning in Setup and does nothing.

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

**Stage blocks and Bash.** A stage's `tools:` blocks (for example "no source edits until Plan is done") also apply to
Bash commands that write a repo file: `>` and `>>`, `tee`, `sed -i`, `mv`, `cp` and `rm` are checked like a Write to
that path, with the same `allow_paths`. Writes outside the repo are not checked. Writes Bash makes indirectly
(`python -c`, `node -e`, `npm run <script>`, editors, build tools) are not detected. Glob isn't gated: it lists file
names, never their contents.

**Failure modes.** A hook that crashes (for example a syntax error in `.shipline/bin/lib.mjs`) doesn't block your work,
but it says so: every hook runs through `.shipline/bin/run-hook.mjs`, which prints "Shipline <hook> hook crashed: ..."
on each affected call, and the Node-missing warning appears on every hook event. If the hook had already printed its
decision before crashing, the warning goes to stderr only. If the code that protects the task store throws, only that step is skipped and the rails still run.
If `config.yml` can't be read, the rails use their defaults (and ask before edits to `.shipline/config.yml`, which may
be the file you are fixing); every call says so.

### Hooks are defence in depth

Guardrails run in Claude Code's hooks and parse the command text. They stop mistakes, not a determined user or a
determined agent. They do not see aliases, shell functions, `eval`, a script that is written and then run, another
tool that pushes (an IDE, a git GUI), or anything beyond one level of `sh -c` or package-script indirection. Parsing is
best effort and the deploy, migrate and install patterns will never be complete: extend them with `rails_commands`.

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
