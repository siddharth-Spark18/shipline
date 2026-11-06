# Teams Phase 3: guardrails — always-on rails, named actions, protected paths, Verify scope check

**Status:** Approved
**Roadmap:** `docs/plans/shipline-teams-roadmap.md`, Phase 3.
**Evidence:** `.claude/research/ai-dev-guardrails-synthesis-2026-11-05.md` (deep research, 2026-11-05).
**Release:** 0.13.0, on a new branch from `main` (`76df943`).

## Problem & Goal

Shipline's guard today only enforces what each stage holds back, with team-written regexes such as `\bgit\s+commit\b|\bgh\s+pr\s+create\b`.

- **Easy to get past:** `git -c x commit`, `cd sub && git commit`, a git alias, or `npm run release` all slip through.
- **Nothing for the dangerous actions:** force-push, pushing to the default branch, deploys, migrations, `curl | sh`, printing credentials, and the agent editing its own config are all unguarded. These are the actions the research found AI-heavy orgs block most consistently.
- **Protected paths only exist inside a stage block,** so they don't apply outside a task.
- **A green Verify can't catch gaming:** agents editing tests or wandering outside the plan, which is the most documented failure mode.

**Goal:** add the guardrails large teams rely on without adding friction:
- deny only the clearly destructive;
- ask for the rest, through Claude Code's normal permission prompt;
- catch common bypasses;
- make test, lint and CI edits and out-of-plan changes visible at Verify and in the PR.

The docs say plainly that hooks are defence in depth, and point to Claude Code's sandbox and managed settings for real enforcement.

**Done when** (author's criteria):

1. **The dangerous ones are stopped:**
   - **denied:** `git push --force` to the default branch, `curl … | sh`, and `cat .env`;
   - **asked:** pushing to the default branch, a deploy command, and editing `.claude/settings.json`.
2. **Bypasses are caught:** `git -c x commit`, `cd sub && git commit` and `npm run release` are all caught by a stage block on `commit` or `release`.
3. **Gaming is visible:** a diff touching tests, or files outside the plan, asks at Verify and shows in the PR summary.

Protected paths asking in any stage are also in scope (scope C), verified the same way.

## Scope

### In

**A. Command parsing** (shared by everything below), in `bin/lib.mjs`: `parseCommand(text)` returns a list of simple commands.

- **Splitting:** it splits on `&&`, `||`, `;`, `|` and newlines, outside quotes. Each part becomes `{ argv: string[], redirects: [{ op: '>' | '>>', target }], pipedFrom: <previous part> | null }`.
- **Tokenising:** POSIX-style, honouring single and double quotes and backslash escapes. Variables aren't expanded, so `$VAR` stays as literal text.
- **Wrapper commands are looked through:** leading `VAR=value` assignments, `env [-i] [VAR=…]`, `sudo [-u x]`, `command`, `nohup`, `time`, `exec`, and `sh -c '<text>'` / `bash -c '<text>'` (the inner text is parsed recursively, one level deep).
- **`cd <dir>`** is kept as its own part. It doesn't change matching.
- **Git normalisation:** `git` followed by global options (`-c k=v`, `-C dir`, `--git-dir=…`, `--work-tree=…`, `--no-pager`, `-P`) becomes `{ tool: 'git', sub: '<subcommand>', args }`.
- **Unparsable text** (an unterminated quote): it falls back to matching the raw text with simple regexes. It never throws; on any error the guard fails open, as today.

**B. Always-on rails** (in any stage, with or without a task), in `bin/guard.mjs`, before the stage blocks. Each rail is `deny`, `ask` or `off`.

**Where they run in the guard:** right after the existing task-store protection, and **before** the guard's two early exits: "no session task" (around line 125) and "file path outside the repo" (around line 143).

- **Rails and protected paths (scope C) apply to every session,** with or without a task, regardless of the current stage's enforcement mode (`guide`, `warn` or `block`). They don't depend on stages at all.
- **They also check file paths outside the repo,** so the credential rails can match `~/.ssh/**`, `~/.aws/credentials` and similar. Protected paths and `agent_config` only ever match repo-relative paths.
- **If a rail or protected path decides `deny` or `ask`,** the guard outputs that decision and exits.
- **Otherwise the existing flow continues unchanged.** The early exits, and then the stage blocks, still need a task.

The rails:

| Rail id | Default (new installs) | Matches |
| --- | --- | --- |
| `force_push_default` | deny | `git push` with `--force`, `-f`, `--force-with-lease`, or a `+` refspec, when the target branch is the default branch; `git push --delete <remote> <default>`; `git branch -D <default>` |
| `push_default` | ask | `git push` whose target is the default branch: an explicit refspec `main` / `HEAD:main` / `refs/heads/main`, or no refspec while the current branch is the default |
| `pipe_to_shell` | deny | a part running `sh`, `bash`, `zsh`, `dash`, `python`, `python3`, `node`, `perl` or `ruby` with no script argument, piped from `curl` or `wget` |
| `print_credentials` | deny | `cat`, `less`, `more`, `head`, `tail`, `bat`, `xxd`, `base64`, `strings`, `grep`, `awk` or `sed` (without `-i`) reading a credential path (below); `printenv` or `env` with no command; `echo`/`printf` of `$AWS_SECRET_ACCESS_KEY`, `$GITHUB_TOKEN` or `$*_TOKEN` / `$*_SECRET` / `$*_KEY` / `$*_PASSWORD` |
| `read_credentials` | ask | the Read tool on a credential path |
| `deploy` | ask | the built-in deploy patterns below, plus `config.yml` `rails_commands.deploy` |
| `migrate` | ask | the built-in migrate patterns below, plus `config.yml` `rails_commands.migrate` |
| `agent_config` | ask | Edit, Write, MultiEdit or NotebookEdit (and `bashWriteTargets`) on `.claude/**`, `.shipline/**`, `CLAUDE.md` or `.mcp.json`. The task store keeps its own existing denial, which is unchanged. |

- **Credential paths:**
  - `.env` and `.env.*`, except `.env.example`, `.env.sample` and `.env.template`;
  - `*.pem`, `*.key`, `id_rsa*` and `id_ed25519*`;
  - `~/.ssh/**`, `~/.aws/credentials`, `~/.config/gcloud/**` and `~/.kube/config`;
  - `.npmrc` and `.pypirc`.
  
  Paths are matched after resolving against the repo root and `~`.
- **Built-in deploy patterns** (the subcommand must match exactly):
  - `kubectl apply|create|delete|rollout`;
  - `helm install|upgrade|uninstall`;
  - `terraform apply|destroy`, `pulumi up|destroy`;
  - `vercel --prod`, `vercel deploy --prod`, `netlify deploy --prod`;
  - `fly deploy`, `flyctl deploy`, `heroku` with `releases:*` or `container:release`;
  - `gcloud … deploy`, `aws … deploy`, `aws cloudformation deploy`, `serverless deploy`, `sls deploy`, `cdk deploy`;
  - package scripts (`npm run`, `pnpm`, `pnpm run`, `yarn`, `bun run`) named `deploy*` or `release*`, or whose `package.json` script body matches a deploy pattern.
- **Built-in migrate patterns:**
  - `prisma migrate deploy|reset`, `prisma db push`;
  - `rails db:migrate|db:rollback|db:drop`, `rake db:*`;
  - `alembic upgrade|downgrade`, `python manage.py migrate`, `django-admin migrate`;
  - `knex migrate:*`, `sequelize db:migrate*`, `typeorm migration:run|revert`, `drizzle-kit push|migrate`, `flyway migrate|clean`, `goose up|down`, `migrate up|down`;
  - package scripts named `migrate*` or `db:*`.
- **Configuration:** `config.yml` gets new keys.

  ```yaml
  rails:                       # deny | ask | off per rail
    force_push_default: deny
    push_default: ask
    pipe_to_shell: deny
    print_credentials: deny
    read_credentials: ask
    deploy: ask
    migrate: ask
    agent_config: ask
  rails_commands:              # extra commands that count as deploy / migrate (plain prefixes, matched on parsed argv)
    deploy: []
    migrate: []
  ```

  - A rail missing from the file uses its default. An unknown rail id or value gives a `setup-schema` warning, and the default is used.
- **The default branch:** `git symbolic-ref --short refs/remotes/origin/HEAD` (stripping `origin/`). Otherwise `main` if it exists, otherwise `master`.
  - It's cached **per repo** in its own file, `<store>/state/default-branch.json` (`{ branch, checked_at }`), and refreshed after 10 minutes. It isn't kept in the session file, which `stage.mjs start` overwrites and which sessions without a task don't have.
  - A cache file that can't be read or written is ignored, and git is asked directly.
  - If none can be found, the push rails match `main` and `master`.
- **The decision:**
  - **deny** → `permissionDecision: 'deny'`, with the reason `Shipline rail <id>: <what>. <how to do it yourself or change the rail>`;
  - **ask** → `permissionDecision: 'ask'`, with the same reason, so Claude Code shows its permission prompt.
  - If several rails or blocks match, the strictest wins: deny over ask over a stage `warn`.

**C. Protected paths** (any stage), in `bin/guard.mjs`.

- **Configuration:** `config.yml` `protected_paths:` is a list of globs, using the existing `globToRegExp`, relative to the repo root. New installs get:

  ```yaml
  protected_paths:
    - migrations/**
    - db/migrate/**
    - prisma/migrations/**
    - alembic/versions/**
    - infra/**
    - terraform/**
    - '**/*.tf'
    - k8s/**
    - helm/**
    - '**/Dockerfile*'
    - '**/docker-compose*'
    - .github/workflows/**
    - .gitlab-ci.yml
    - .circleci/**
    - Jenkinsfile
    - package-lock.json
    - pnpm-lock.yaml
    - yarn.lock
    - poetry.lock
    - Cargo.lock
    - go.sum
  ```

- **What's matched:**
  - **File tools:** Edit, Write, MultiEdit or NotebookEdit on a matching path.
  - **Bash, best-effort:** any target from the shared helper `bashWriteTargets(parts)` in `lib.mjs` matches. The same helper is used by the `agent_config` rail, so both always see the same targets.
    - **What it returns:** the paths a parsed command writes:
      - `>` and `>>` redirect targets;
      - `tee` arguments;
      - `sed -i` file arguments;
      - `mv`, `cp` and `rm` arguments after the options (for `mv` and `cp`, the destination and any source that's removed; for `rm`, every operand).
    - **Resolution:** each path is resolved against the `cd` in effect for that part, or the hook's `cwd`, and returned repo-relative. Paths outside the repo are returned absolute.
  - Either gives `ask`, with the reason `Shipline: <path> is protected in this repo (protected_paths in .shipline/config.yml)`.
- **No overlap with `agent_config`:** paths under `.claude/` and `.shipline/` are covered by that rail.

**D. Named actions in stage blocks**

- **The new block form** is `{ actions: [commit, push, pr, merge, release, deploy, migrate] }`, alongside the existing `{ tools, allow_paths }` and `{ bash: regex }`, which still work unchanged.
- **The actions,** matched on parsed parts:
  - **commit:** `git commit`, `git merge --commit`, and `git cherry-pick`/`git revert` without `--no-commit`.
  - **push:** `git push` (any target).
  - **pr:** `gh pr create`, `gh pr merge`, `hub pull-request`, `glab mr create`.
  - **merge:** `gh pr merge`, `git merge` into the default branch (current branch is default), `glab mr merge`.
  - **release:** `gh release create`, `npm publish`, `pnpm publish`, `yarn npm publish`, `cargo publish`, `twine upload`, `git tag` with `-a`/`-s` or a version-like name, and package scripts named `release*`/`publish*`.
  - **deploy / migrate:** the rail patterns from scope B, including `rails_commands`.
- **Package scripts:** when a part runs a package script, its name and its body in the nearest `package.json` are checked against these actions. The body is parsed recursively, one level deep.
- **Shipped workflows:** verify's block becomes `{ actions: [commit, pr] }`.
- **`upgrade`:** it replaces the exact shipped regex `\bgit\s+commit\b|\bgh\s+pr\s+create\b` with `actions: [commit, pr]` where unedited, with a diff. Edited regexes are left alone.
- **Setup's blocks editor** gets an "Actions" block type, with checkboxes for the seven actions.

**E. Verify scope check (anti-gaming)**

- **The base commit:** `stage.mjs start` records `task.base_commit` (`git rev-parse HEAD`, or null outside git or with no commits) in the manifest. `resume` doesn't change it.
- **What `stage.mjs check` does,** in addition to the commands: it computes `scope` and stores it in `manifest.checks.scope`:
  - **`changed`:** every path changed since `base_commit`, committed, uncommitted and untracked (not ignored). That's `git diff --name-only <base_commit>` plus `git ls-files --others --exclude-standard`.
  - **`sensitive`:** the changed paths that are tests, lint config or CI config:
    - **tests:** `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.go`, `**/test_*.py`, `**/*_test.py`;
    - **lint config:** `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `prettier.config.*`, `.stylelintrc*`, `ruff.toml`, `.ruff.toml`, `.flake8`, `setup.cfg`, `.golangci*`, `.rubocop*`, `biome.json*`, `.editorconfig`;
    - **CI config:** the CI globs from scope C.
    - `config.yml` `scope_check.sensitive_extra` can add globs.
  - **`outside_plan`:** the changed paths not listed under the plan artifact's "Files to touch" section.
    - **Listed means** a backticked path, or a path at the start of a bullet (before ` (`, ` —` or `:`). Globs are honoured.
    - **Always ignored:** lockfiles, files under `.shipline/` and `.claude/`, and the task store.
    - If the task has no plan artifact, or no "Files to touch" section, `outside_plan` is `null` (unknown), never empty.
- **`check` prints** `Scope: 2 test files, 1 file outside the plan` with the lists.
- **At `advance` on a `checks: true` stage,** after the failed-commands acceptance from Phase 2:
  - If `sensitive` or `outside_plan` is non-empty, a new confirmation kind `scope` (`CONFIRM_OPTIONS.scope = { yes: 'Finish anyway', no: 'Not yet' }`) asks: `Finish "<stage>" in task <slug>? This change edits <n> test/lint/CI files and <m> files outside the plan (run <fingerprint 8>).`
  - The acceptance is stored on the stage as `scope_accepted: { fingerprint, ran_at }`. Like Phase 2's acceptance, it's voided by a new `check` run.
  - The order of questions is: failed commands → scope → `confirm_to_advance`.
- **The PR summary:**
  - a **Scope** line: `**Scope:** edits 2 test files, 1 outside the plan (accepted)`, with the two lists in a collapsed `<details>`;
  - JSON `v: 2` gains an optional `scope: { sensitive: [...], outside_plan: [...] | null, accepted: bool }`;
  - `ci-check` shows it in the job summary as information only (never a failure).
- **Configuration:** `config.yml` `scope_check: { enabled: true, sensitive_extra: [] }`. With `enabled: false`, nothing is computed or asked.

**F. Setup UI: Guardrails section**

- **A new Setup section, "Guardrails",** with:
  - **each rail:** its name, a one-line description, and a deny/ask/off select;
  - **protected paths:** a list editor, like the allow-paths editor;
  - **`rails_commands.deploy` / `.migrate`:** list editors;
  - **`scope_check.enabled`:** a switch, and `sensitive_extra` as a list.
- It saves through the existing config save, with preview and diff. `setup-schema.mjs` validates the new keys.
- **A short notice at the top:** "These run inside Claude Code's hooks: they stop mistakes, not a determined user. For hard limits use Claude Code's sandbox and managed settings." It links to the README section.

**G. Defaults, init and upgrade**

- **New installs** (`init`, the wizard, `--yes`): the template `config.yml` contains `rails:` with the defaults above, `protected_paths:` with the default list, `rails_commands: { deploy: [], migrate: [] }` and `scope_check: { enabled: true, sensitive_extra: [] }`. Each is commented.
- **`upgrade` of an existing repo:** it adds `rails:` with **every rail set to `off`**, and `protected_paths: []`, and `rails_commands` and `scope_check` with their defaults (scope check on).
  - A comment says: `# Guardrails are off for repos set up before 0.13.0. Turn them on here or in Setup → Guardrails.`
  - `upgrade` prints `New: guardrails (off; see Setup → Guardrails)`.
  - Keys that are already present are never changed.
- **Named actions and the scope check** apply to upgraded repos too: actions through the regex rewrite in scope D, and the scope check through the default `scope_check.enabled: true`.

**H. Docs**

- **README gets a "Guardrails" section** covering:
  - the rails table and how to change them;
  - protected paths and named actions;
  - the scope check;
  - "Hooks are defence in depth": what they can't stop (aliases, scripts written then run, shell functions, other tools), plus pointers to Claude Code's `sandbox` and managed settings, with example `permissions.deny` rules for teams that want hard limits.

### Out

- Monorepo per-folder rules (Phase 6) and lighter confirmations (Phase 4).
- Network or egress controls, sandbox configuration, and managed settings generation.
- Parsing beyond one level of `sh -c` or package-script indirection. Shell functions, aliases and `eval` are out.
- Secret *scanning* of diffs or output. This phase only guards reading and printing credential files.
- Blocking MCP tools.

## Surface Area

- **Vendored hooks and scripts:**
  - `bin/lib.mjs`: `parseCommand`, matchers, the default branch, credential paths, actions, and the rails config;
  - `bin/guard.mjs`: rails, protected paths, actions, and the Read tool for `read_credentials`;
  - `bin/stage.mjs`: `base_commit`, scope in `check`, the `scope` question, and pr-summary;
  - `bin/record-answer.mjs`: unchanged if it accepts any `CONFIRM_OPTIONS` kind, otherwise it gets `scope`;
  - `bin/ci-check.mjs`: the scope display.
- **Templates:** `config.yml` (the new keys), the four workflows (verify block becomes actions), `settings-hooks.json` (the PreToolUse matcher gains `Read`, which `read_credentials` needs), and the `shipline-workflow` skill (rails, the scope question).
- **CLI:** `setup-schema.mjs`, `upgrade.mjs` (the config keys, the regex rewrite, the edited-hooks warning), `known-hashes.json` and `package.json` (0.13.0). `install.mjs` is **unchanged**, because it writes the template `config.yml`, which carries the new keys.
- **UI server:** **none.** The Guardrails section saves through the existing config save (`POST /api/setup/save`, kind `config`).
- **Browser UI:** a new Guardrails section in Setup, the Actions block type in `blocks-editor.tsx`, and `types.ts`.
- **Data:**
  - the manifest gains `task.base_commit`, `checks.scope` and per-stage `scope_accepted`;
  - `config.yml` gains `rails`, `rails_commands`, `protected_paths` and `scope_check`;
  - the summary JSON gains an optional `scope`.
- **`INTERFACE`:** 5 → 6, because the guard behaviour and the `actions` block type change what the hooks do.

## Files to Touch

- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**):
  - `parseCommand`;
  - `matchAction(part, action, ctx)`;
  - `matchRail(part, rail, ctx)`;
  - `defaultBranch(root)`, with the per-repo cache file;
  - `isCredentialPath`;
  - the built-in deploy and migrate patterns;
  - `loadConfig` normalising `rails`, `rails_commands`, `protected_paths` and `scope_check`;
  - `CONFIRM_OPTIONS.scope` and the question text;
  - `scopeOf(root, manifest, planText)`.
- `packages/cli/templates/shipline/bin/guard.mjs` (**modify**):
  - after the store protection: rails, then protected paths, then stage blocks;
  - `actions` blocks;
  - the strictest decision wins;
  - Read tool handling.
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**):
  - `base_commit` at start;
  - scope in `check`;
  - the `scope` question in `advance`;
  - the scope line and block in `pr-summary`;
  - `reopen` clears `scope_accepted`.
- `packages/cli/templates/shipline/bin/record-answer.mjs` (**modify**, only if it doesn't accept any `CONFIRM_OPTIONS` kind): accept `scope`.
- `packages/cli/templates/shipline/bin/ci-check.mjs` (**modify**): the optional `scope` in the job summary, shown for information only.
- `packages/cli/templates/settings-hooks.json` (**modify**): **required.** The PreToolUse matcher becomes `Edit|Write|MultiEdit|NotebookEdit|Bash|Read`, since today it has no `Read`.
  - **Existing repos:** `upgrade` already replaces Shipline's hook entries in `.claude/settings.json` when they're unedited, through the `settings.json#shipline` record and `known-hashes.json`, so they get `Read`.
  - **An edited entry** is left alone, and `upgrade` prints: "Your Shipline hook entries in .claude/settings.json were edited, so reading credential files (the read_credentials rail) is not guarded. Add Read to the PreToolUse matcher to enable it."
- `packages/cli/templates/shipline/config.yml` (**modify**): `rails`, `rails_commands`, `protected_paths` and `scope_check`, with comments.
- `packages/cli/templates/shipline/workflows/{feature,bugfix,hotfix,small}.yml` (**modify**): the verify block becomes `actions: [commit, pr]`, and the header comment documents `actions`.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` (**modify**): rails and protected paths (what a denial or prompt means, and never working around one), and the scope question at Verify.
- `packages/cli/src/setup-schema.mjs` (**modify**): the new config keys, the `actions` block type, and warnings for unknown rails or actions.
- `packages/cli/src/upgrade.mjs` (**modify**): adds the guardrail keys with rails `off` and `protected_paths: []`; rewrites the shipped verify regex to `actions` where unedited; output lines.
- `packages/cli/src/interface.mjs` (**modify**): INTERFACE 6, and a `MISSING_BEFORE` entry.
- `packages/ui/src/pages/setup/guardrails-section.tsx` (**create**): the rails selects, the path and command list editors, the scope check switch, and the notice.
- `packages/ui/src/pages/setup/setup-page.tsx` (**modify**): the Guardrails section in the navigation.
- `packages/ui/src/pages/setup/blocks-editor.tsx` (**modify**): the Actions block type.
- `packages/ui/src/pages/setup/draft.ts` (**modify**): carry `rails`, `rails_commands`, `protected_paths` and `scope_check` in the config draft, so they're edited and saved, not treated as unknown fields.
- `packages/ui/src/pages/setup/config-form.tsx` (**modify**): add the new keys to `TOP_KEYS` (or the equivalent), so the form doesn't list them under "other fields (kept)" now that the Guardrails section edits them.
- `packages/ui/src/lib/types.ts` (**modify**): `ConfigModel.rails`, `.rails_commands`, `.protected_paths` and `.scope_check`; `ActionsBlock`; `Task.checks.scope`.
- `packages/cli/src/known-hashes.json` (**modify**): regenerated.
- `packages/cli/package.json` (**modify**): 0.13.0.
- `README.md` (**modify**): the Guardrails section, including "Hooks are defence in depth".
- `docs/plans/shipline-teams-roadmap.md` (**modify**): link Phase 3 to this plan.

### Tests (written separately, listed here)

- **`test/parse-command.test.mjs` (create):**
  - splitting on `&&`, `||`, `;`, `|` and newlines, outside quotes;
  - quotes and escapes;
  - looking through env, sudo and `VAR=` prefixes;
  - `sh -c` one level deep;
  - git global options;
  - unterminated quotes fall back without throwing.
- **`test/rails.test.mjs` (create):** each rail's positive and negative cases, including:
  - **force_push_default:** `git push -f origin main` is denied; on a feature branch it isn't; `+main`; `--force-with-lease`; `git push --delete origin main`;
  - **push_default:** `git push` while on `main` asks;
  - **pipe_to_shell:** `curl x | sh` and `wget -qO- x | bash` are denied, and `curl x > f` isn't;
  - **credentials:** `cat .env` is denied and `cat .env.example` isn't; Read `.env` asks; `printenv` is denied;
  - **deploy and migrate:** each built-in pattern; a `package.json` script body; `rails_commands`;
  - **agent_config:** Edit `.claude/settings.json` asks, and the task store stays denied as before;
  - **config:** `off` disables a rail; an unknown rail gives a warning; strictest wins;
  - **default branch:** from `origin/HEAD`, the fallback, and the cache.
- **`test/protected-paths.test.mjs` (create):**
  - Edit on `migrations/001.sql` asks in no task and in any stage;
  - Bash `echo x > .github/workflows/a.yml` and `sed -i … go.sum` ask;
  - non-matching paths are untouched;
  - an empty list does nothing.
- **`test/guard*.test.mjs` (modify):**
  - `actions` blocks: `git -c x commit`, `cd sub && git commit`, `npm run release` (script name), and a script whose body runs `git push`;
  - regex blocks still work;
  - the order (store, then rails, then paths, then stages).
- **`test/stage-gate.test.mjs` (extend):**
  - `base_commit` recorded;
  - scope lists (tests, lint, CI, outside the plan, none when there's no plan);
  - the scope question and its order relative to failed checks and `confirm_to_advance`;
  - the acceptance voided by a new run;
  - `scope_check.enabled: false`;
  - `pr-summary`'s Scope line and block, and the JSON `scope`.
- **`test/ci-check.test.mjs` (extend):** scope shown, and never a failure.
- **`test/upgrade.test.mjs` (extend):**
  - the guardrail keys are added with every rail `off`;
  - keys already present are kept;
  - the shipped regex becomes `actions` and an edited one is kept;
  - the output line.
- **`setup-schema` and the UI setup tests:** the new keys are validated and survive a save, and the Actions block type works.

## Behavior & Edge Cases

- **Not a git repo, or no `origin`:** the push rails use the `main`/`master` fallback, and the scope check gets `base_commit: null`. Scope is then `changed: null`, so nothing is asked, with a note in `check`.
- **A task started before 0.13.0** (no `base_commit`): the scope check reports "unknown (task started before 0.13.0)" and asks nothing.
- **Claude Code permission modes:** `ask` from a hook shows the prompt in manual and acceptEdits modes. In `auto` and `bypassPermissions` modes the behaviour is **unverified**. The build checks it with a real `claude -p` run and records the result; see Open Questions.
- **A rail and a stage block both match:** deny beats ask. A stage `warn` never weakens a rail.
- **The guard's parsing throws:** it fails open, as today, with the existing visible warning.
- **Performance:**
  - parsing is in-process string work;
  - `defaultBranch` costs at most one `git` call per 10 minutes per repo;
  - reading `package.json` happens only for package-script commands.

## Constraints

- **Node 18, no dependencies,** in the vendored scripts.
- **The guard stays fast.** It adds no network and at most one cached git call.
- **The friction budget:** only the clearly destructive is denied. Everything else asks once per action, through the prompt developers already know.

## Verification

1. **On a fresh install:**
   - `git push --force origin main`, `curl https://x | sh` and `cat .env` are denied, each with a clear reason;
   - `git push` on main, `npm run deploy` and editing `.claude/settings.json` show the permission prompt.
2. **With a stage holding back `[commit, pr]`:** `git -c user.name=x commit -m y`, `cd packages/a && git commit` and `npm run release` (with a release script) are all denied with the stage reason.
3. **Protected paths:** with no task, editing `migrations/001.sql` asks.
4. **At Verify:**
   - edit a test file and one file not in the plan, then run `check`;
   - finishing Verify asks the scope question;
   - the PR summary shows the Scope line.
5. **Upgrade:**
   - on a 0.12.0 repo, `upgrade` adds every rail as `off` and an empty `protected_paths`, and turns the shipped verify regex into `actions`;
   - turning rails on in Setup takes effect.
6. **Tests:** the suite and CI are green on all three operating systems.

## Open Questions

- **Hook `ask` in Claude Code's `auto` and `bypassPermissions` modes:** whether the prompt still shows is unverified. If `bypassPermissions` skips it, the ask rails can't protect in that mode, and the docs must say so.
- **Parsing is best-effort.** Aliases, shell functions, `eval`, scripts written and then run, and other tools that push (IDEs, git GUIs) aren't covered. The README states this, and points to the sandbox and managed settings.
- **The definition of a deploy pattern will grow.** Teams extend it with `rails_commands`, and a feedback path is Phase 5.
- **Detecting the default branch** relies on `origin/HEAD`, which some clones don't set. The fallback is `main`/`master`.
