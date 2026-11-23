# Configuration reference

`config.yml`, workflow files, checks, confirmations and rules files.

[Back to the README](../README.md)

**`.shipline/config.yml`**

```yaml
branch_pattern: "{type}/{key}-{slug}"   # {key} = PROJ-12 (Jira) or issue-123 (GitHub), dropped with no ticket
tracker: none                           # none (skip the ticket stage), github (the gh CLI) or jira (Atlassian MCP); read-only
commands:                               # filled by init from the repo; the Verify stage runs only these
  test: "pnpm test"
  lint: "pnpm run lint"
  build: "pnpm run build"
non_interactive: deny                    # deny | checks_pass: only when SHIPLINE_NONINTERACTIVE=1 (see Daily use, Headless runs)
stale_task_days: 14                      # session start lists tasks idle longer than this as a count only
confirmations: standard                 # standard | light: how often Claude asks before advancing (see Confirmations)
skills: []                              # your own .claude/skills/<name> that Claude may use at any stage
setup: done                             # written by /shipline-setup; stops the setup reminder
rails: { ... }                          # always-on guardrails, deny | ask | off each (see Guardrails)
protected_paths: [ ... ]                # globs that ask before an edit, in any stage
scope_check: { enabled: true }          # Verify: flag edits to tests, lint and CI, and files outside the plan
rails_commands:                         # extra commands that count as a deploy, a migration or a package install
  deploy: []                            #   plain prefixes, for example "make ship"
  migrate: []
  install_packages: []                  #   for example "make deps" (see the install_packages rail)
fail_first:                             # bugfixes: require a test that fails before the fix (see Guardrails)
  level: off                            #   off | note | section | proof
  workflows: [bugfix]                   #   workflows it applies to; each needs a `reproduce` stage
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
| `blocks` | What is held back until this stage is done: `{ tools: 'Edit\|Write', allow_paths: [globs] }`, `{ bash: 'regex' }` or `{ actions: [commit, pr] }` (see [Guardrails](guardrails.md)) |

**Shipped workflows.** Four are installed by default: `feature`, `bugfix`, `hotfix` and `small`. Five more are offered
but unticked in the install wizard and `init`, and listed under Setup → Add shipped workflow: `spike` (Question,
Research), `refactor` (Plan, Implement, Verify), `docs` (Outline, Write, Review; the Write stage uses
`allow_paths` so docs edits are allowed while source edits stay blocked), `deps` (Assess, Upgrade, Verify) and
`release` (Prepare, Verify, Publish; no release or deploy before Verify is done). Each has rules files for its new
stage ids (`question`, `research`, `outline`, `write`, `review`, `assess`, `upgrade`, `prepare`, `publish`). Copies of
all nine are kept in `.shipline/bin/shipped/` (Shipline-owned, refreshed by `upgrade`) so Claude can offer the ones this
repo doesn't have.

**Workflow designer.** `/shipline-workflow-designer` creates or changes a workflow from a plain-words description: it
reads the repo, interviews you, drafts `workflow.yml` plus a rules file for every new stage, and validates them. It uses
only the fields above and only agents already in `.claude/agents/`; `config.yml` stays with `/shipline-setup`. With
`--draft` (what Setup starts) it leaves a draft in the repo's task store (`<store>/drafts/<workflow id>/`) for review in
Setup; without it, in a terminal, it writes `.shipline/workflows/<id>.yml` and the rules files after you approve a
summary. `--edit <workflow-id>` changes an existing workflow. It uses these `stage.mjs` commands, which you can run
yourself:

| Command | What it does |
| --- | --- |
| `stage.mjs validate <path>` | Checks a folder with `workflow.yml` and `rules/`, a single `.yml` file, or `.shipline` (every workflow). Prints `ok` and exits 0, or one `<file>: <field>: <message>` line per error and exits 1. A stage with no rules file is a `warning:` line, not an error. |
| `stage.mjs draft --tmp` | Prints a fresh scratch folder in the store (folders over 24 hours old are removed). |
| `stage.mjs draft <id> --from <folder>` | Validates a scratch folder and stores it as the draft for that workflow, replacing an older one. Only folders inside the store's scratch area are accepted. |
| `stage.mjs workflows --shipped` | Lists the shipped workflows this repo doesn't have yet. |

**Checks and PR evidence.** `stage.mjs check` runs `commands.test`, `commands.lint` and `commands.build` itself, records each
exit code, duration and output tail in the task, and fingerprints the code it ran on (a git tree id that includes
uncommitted files; your real index is never touched). On a `checks: true` stage, `advance` refuses a missing run or a run
on code that has since changed. When a command failed, it asks you whether to finish anyway. `pr-summary` then shows a
Checks line plus the plan's scope and the verification checklist in collapsed sections. The CI check compares the
summary's fingerprint with the PR's git tree. `ci.allow_non_interactive: true` (default false) lets the PR check accept stages a headless run advanced on passing checks.
With `ci.stale_checks` in `config.yml` set to `warn` (the default) it warns
when they differ, with `fail` it fails. A command that failed and wasn't accepted fails the check either way. A hand-edited
summary can still lie: this is evidence for reviewers, not a signature.

**The `ci:` block.** Optional; it sets what the PR check (`ci-check.mjs`) does. The values shown are the defaults:

```yaml
ci:
  missing_block: fail-unless-label   # fail-unless-label | warn | fail: a PR without the Shipline summary block
  skip_label: shipline:skip          # the PR label that skips the check under fail-unless-label
  stale_checks: warn                 # warn | fail: the summary's checks ran on different code than the PR's
```

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
