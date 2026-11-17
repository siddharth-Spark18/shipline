# Guardrails 2.1: install_packages rail and fail-first tests

**Status:** Approved
**Release:** 2.1.0, on a new branch from `main` (e.g. `feat/2-1`), built **after** `docs/plans/shipline-setup-redesign-and-palettes.md` on the same branch. The changelog entry also covers that redesign.
**Sources:**
- Memory "Guardrails expansion backlog" (from the 2026-11-13 review of the user's "Guardrails in Software
  Development & AI Coding Agents" doc).
- Planning interview 2026-11-17.

## Problem & Goal

- **Slopsquatting.** About 20% of AI-suggested packages don't exist, and attackers register those names. Today
  Shipline only catches edits to lockfiles (`protected_paths`), not the commands that fetch and run new packages.
- **Bugfixes without a failing test.** Bugfixes can land with no test that showed the bug. Bugfix's Reproduce rules
  only say "use a failing test when that is practical".

**Goal:**
- A new **`install_packages` rail** (default `ask`) shows Claude Code's permission prompt, naming the packages,
  before any command that adds a named package, runs a package that isn't a dependency, or installs globally.
- A per-repo **`fail_first`** setting (off by default) lets a team require, at a level it chooses, a test that fails
  before the fix.

**Success:**
- Asking Claude to "add lodash" or to run `npx some-unknown-tool` brings up the prompt with the package names.
  `npx vitest` in a repo that has vitest doesn't.
- With `fail_first.level: proof` on Bugfix, Reproduce can't finish until `stage.mjs check --expect-fail` has
  recorded a failing test run, and Verify shows that it failed before the fix and passed after.

## Scope

**In:**
- The `install_packages` rail: the matcher, its default, its config, Setup, the install stepper, `/shipline-setup`
  and docs.
- `rails_commands.install_packages` for team-specific install commands.
- The `fail_first` setting and built-in Reproduce stage notes printed by `stage.mjs`.
- The `section` and `proof` enforcement, and `stage.mjs check --expect-fail`.
- Setup, the install stepper (terminal and wizard) and `/shipline-setup` support for `fail_first`.
- New tests for both features, plus docs and changelog (2.1.0).

**Out (explicitly):**
- Backlog item 2 (PR size signal) and item 3 (ticket prompt-injection note): later.
- Checking whether a package exists on a registry (no network calls from hooks).
- Bare lockfile restores (`npm install`, `pnpm install`, `pip install -r requirements.txt`, `bundle install` with no
  new name): never caught.
- Fail-first for workflows without a Reproduce stage. Listing one in `fail_first.workflows` gives a validation
  warning; the team adds a Reproduce stage if it wants this.
- A general "built-in notes" framework: notes exist only for the fail-first Reproduce stage.
- Changing any shipped rules file. Shipped 1.0 rules stay byte-identical (`known-stub-rules`).
- Sandbox, network egress, isolation, MCP governance and managed policy (out of scope by design).

## Surface Area

### 1. `install_packages` rail

**Config** (`.shipline/config.yml`):

```yaml
rails:
  # npm/pnpm/yarn/bun add, pip install <pkg>, uv add, cargo add, go get, npx of a package that isn't a dependency,
  # global installs (npm i -g, pipx, brew, apt) and the like.
  install_packages: ask
rails_commands:
  install_packages: []   # extra commands that install packages (plain prefixes, e.g. "make deps")
```

- Added to `RAIL_IDS` and `RAIL_DEFAULTS` (`ask`) in `lib.mjs`. A config without the key uses `ask`, so existing
  repos get the rail on upgrade with no config edit. The changelog says so.
- `rails_commands.install_packages` is parsed like `deploy` and `migrate` (`strList`).

**What it catches.** Each case is matched on the parsed command after `effective()` unwrapping. That covers `npx`,
`pnpm exec`, `bundle exec`, `python -m` and `uv run`/`poetry run`.

- **Adding a named package:**
  - `npm install|i|add <name…>` (any positional that isn't a path or URL) and `npm ci`: never; bare `npm install`:
    never.
  - `pnpm add <name>`, `pnpm install <name>` (pnpm treats `install <name>` like add).
  - `yarn add <name>`, `bun add|install <name>`.
  - `pip install <name>`, `pip3`, `python -m pip install <name>`. `-r` / `-e .` / `.` / paths alone don't count.
  - `uv add <name>`, `uv pip install <name>`, `poetry add <name>`, `pipenv install <name>`, `pdm add <name>`,
    `rye add <name>`, `hatch` (none).
  - `cargo add <name>`, `go get <path>`, `go install <path>@<ver>`.
  - `gem install <name>`, `bundle add <name>`, `composer require <name>`, `dotnet add package <name>`.
- **Running a package that isn't a dependency:**
  - `npx`, `bunx` or `pnpm exec`… Unwrapping already resolves the tool name. The package is "listed" if it's in
    `dependencies`, `devDependencies` or `optionalDependencies` of any `package.json` from the command's directory
    up to the repo root, or if `node_modules/.bin/<tool>` exists in one of those directories. Listed means no prompt.
  - `npx -p <pkg>` / `--package <pkg>` checks `<pkg>`.
  - `pnpm dlx`, `yarn dlx`, `uvx`, `pipx run`: always match (they are for one-off packages).
- **Global or system installs:** `npm install -g|--global <name>`, `pnpm add -g`, `yarn global add`,
  `bun add -g`, `pipx install`, `cargo install <name>`, `gem install` (already above), `brew install`,
  `apt|apt-get install`, `dnf|yum install`, `choco install`, `winget install`.
- **Extra commands:** `rails_commands.install_packages` prefixes, matched as `extraCommand` does for deploy and
  migrate.

**Prompt reason** (the `ask` / `deny` message):

> Installs packages: lodahs, left-pad (npm). Check each name is the one you meant and exists on the official
> registry before allowing.

- The tool label is one of npm, pnpm, yarn, bun, pip, uv, poetry, cargo, go, gem, composer, dotnet, brew, apt and
  so on.
- For an unlisted npx: "Runs a package that isn't a dependency of this repo: create-foo (npx). …" with the same
  check hint.
- For an extra command: "Runs `make deps`, listed as an install command in config.yml."
- `deny` uses the same text, with Claude Code's deny wording.

**Where it's evaluated:** `guard.mjs` loops over `RAIL_IDS` calling `matchRail`, so a new `case 'install_packages'`
in `matchRail` is enough. `makeMatchCtx` gains a cached `isListedNodePackage(dir, name)`; it already caches
`package.json` reads for scripts.

### 2. `fail_first` setting

**Config:**

```yaml
# Bugfixes: require a test that fails before the fix. level: off | note | section | proof.
#   note: Claude is told to write a failing test first. section: Reproduce must have a "## Failing test" section.
#   proof: `stage.mjs check --expect-fail` must record a failing test run before Reproduce can finish.
fail_first:
  level: off
  workflows: [bugfix]
```

- If it's missing or invalid, it's treated as `{ level: off, workflows: [bugfix] }`, and an invalid value warns like
  other config errors.
- `validateConfig`:
  - `level` must be one of the four; `workflows` must be a list of workflow ids that exist.
  - A listed workflow with no `reproduce` stage is a **warning**, not an error.

**Built-in note** (`stage.mjs`, printed when Reproduce starts or is resumed, **before** the repo's own rules, only
when `level ≠ off` and the task's workflow is listed):
- `note`: "Shipline (fail-first): before changing any code, write a test that reproduces this bug and fails on the
  current code. Name it in reproduction.md."
- `section`: the note plus "reproduction.md must have a `## Failing test` section naming the test and showing its
  failing output."
- `proof`: the note plus "Run `node .shipline/bin/stage.mjs check --expect-fail [test file or name]` to record that
  it fails. Reproduce can't finish until a failing run is recorded."

**Enforcement on `stage.mjs advance`** (from Reproduce, listed workflow):
- `section`: `Failing test` is added to Reproduce's required sections for this check, using the existing sections
  check (heading with text under it).
- `proof`: the manifest must hold a `fail_first` record from this task with a non-zero exit. Otherwise advancing is
  refused with the reason and the command to run.
- **The existing skip path still works:** `stage.mjs skip --reason …` on Reproduce, with the developer's confirmation
  if the stage is required. That's the developer's override.
- **`proof` with no test command** (`commands.test` empty): advancing is refused with "fail_first is set to proof but
  no test command is configured. Set commands.test in .shipline/config.yml, or skip this stage with a reason." It
  is never silently downgraded.

**`stage.mjs check --expect-fail [extra…]`:**
- Runs only `commands.test`, with `extra` appended. Each extra argument must match `^[A-Za-z0-9_./:@=,+-]+$`
  (no spaces, quotes, `;`, `|`, `&`, `$`, backticks, redirects or `..` segments). Anything else is refused with
  exit 2, because `stage.mjs` runs without a permission prompt and must not run arbitrary commands.
- Records `manifest.fail_first = { fingerprint, ran_at, command, exit, tail }`, using the same fingerprint and tail
  helpers as `check`.
- Prints "Failing as expected (exit N): recorded." or "The test passed, so it doesn't reproduce the bug: nothing
  recorded." (exit 1).
- Only valid while the active task is at Reproduce in a listed workflow; otherwise it's refused with a short reason.
- **Verify / PR summary:** when a `fail_first` record exists, Verify's output and the PR summary (`pr-summary`) show
  "Fail-first: failed before (exit N on <fp12>), passed after (on <fp12>)", using the latest `checks` result for the
  "after". The CI check shows it as information only; it never fails on it.

### 3. Where teams set it

- **Setup → Guardrails** (`guardrails-section.tsx`, which after the Setup redesign is the body of the focused Guardrails page `#/setup/<repoId>/guardrails`; the hub's Guardrails card summary should count the new rail):
  - an `install_packages` rail row (deny, ask or off, with its one-line description);
  - a `rails_commands.install_packages` list next to deploy and migrate;
  - a **Fail-first tests** block with the level select and a workflow multi-select (workflows without Reproduce are
    marked "no Reproduce stage").
- **Install stepper:**
  - **Terminal** (`init-prompts.mjs`): after the Guardrails step, a "Fail-first tests for bugfixes?" select
    (off/note/section/proof, default off).
  - **Wizard:** its Guardrails step already reuses `GuardrailsSection`, so the Fail-first block appears there with no extra UI. Add `fail_first` to the guardrail keys the wizard sends as `guardrailConfig` (`GUARDRAIL_KEYS` in `install-wizard.tsx` and in `install.mjs`), and add a review line in `review-step.tsx`.
  - **Terminal selection field:** `failFirst: 'off'|'note'|'section'|'proof'`, written by `install.mjs` into `config.yml`
    (workflows `[bugfix]`). When `guardrailConfig.fail_first` is also set, `guardrailConfig` wins (as it already does for rails).
  - `init --yes` uses off.
- **`/shipline-setup`:** the Guardrails topic lists `install_packages` and adds a fail-first question.

## Files to Touch

**Templates (`packages/cli/templates`)**
- `shipline/bin/lib.mjs`: **modify**.
  - `RAIL_IDS` and `RAIL_DEFAULTS` gain `install_packages`; `rails_commands.install_packages` parsing;
    `fail_first` parsing with defaults.
  - The `install_packages` matcher in `matchRail`; `isListedNodePackage` in `makeMatchCtx`.
- `shipline/bin/stage.mjs`: **modify**. The built-in Reproduce note, `section` and `proof` enforcement on advance,
  `check --expect-fail`, and the fail-first line in Verify output and `pr-summary`.
- `shipline/bin/ci-check.mjs`: **modify** only to display the fail-first line from the summary (informational).
- `shipline/config.yml`: **modify**. The `install_packages` rail line, `rails_commands.install_packages: []`, and the
  `fail_first` block with comments.
- `claude/skills/shipline-setup/SKILL.md`: **modify**. The rail in the Guardrails list, plus a fail-first question.

**CLI (`packages/cli/src`)**
- `setup-schema.mjs`: **modify**. `KNOWN_FIELDS` (`fail_first`, `install_packages` under rails and
  `rails_commands`), and `validateConfig` for `fail_first`.
- `install.mjs`: **modify**. The `failFirst` selection field (validation, default off, written to `config.yml`), and `fail_first` added to `GUARDRAIL_KEYS` (guardrailConfig wins over `failFirst`).
- `init-prompts.mjs`: **modify**. The terminal fail-first step.
- `known-hashes.json`: **modify**. 2.1.0 hashes (via `scripts/hash-templates.mjs`).
- `package.json`: **modify**. Version 2.1.0.
- `CHANGELOG.md`: **modify**. The 2.1.0 entry, noting that existing repos get the rail at `ask` after upgrade.

**UI (`packages/ui/src`)**
- `pages/setup/guardrails-section.tsx`: **modify**. The rail row, extra commands and the Fail-first block, on the redesigned Guardrails page.
- `pages/setup/setup-hub.tsx`: **modify**. The Guardrails card's deny/ask counts include `install_packages`; mention fail-first when it is on.
- `lib/types.ts`: **modify**. Config and selection types.
- `pages/install/install-wizard.tsx`: **modify**. Add `fail_first` to `GUARDRAIL_KEYS`.
- `pages/install/review-step.tsx`: **modify**. The fail-first review line. (`path-choice.tsx` is unchanged.)

**Docs**
- `docs/guardrails.md`: **modify**. `install_packages` (what's caught, what isn't, extra commands) and fail-first
  (levels, `--expect-fail`, the skip override).
- `docs/configuration.md`: **modify**. The `fail_first` and `rails_commands.install_packages` keys.

**Tests (`packages/cli/test`)**
- `rails.test.mjs`: **modify**. Table cases for `install_packages`:
  - each tool's add or install with a name;
  - bare restores not matched;
  - npx listed (in `package.json` and in `.bin`) and unlisted;
  - `npx -p`, `dlx`, `uvx`, `pipx run`;
  - global installs;
  - extra commands;
  - unwrapped forms (`uv run pip install x`, `python -m pip install x`);
  - `cd sub && npm i x`;
  - level `off`.
- `stage-check.test.mjs` / `stage-gate.test.mjs`: **modify**.
  - fail_first at each level: note printed, section required, proof required;
  - `--expect-fail` records on failure and not on pass;
  - unsafe extra args refused;
  - proof with no test command refused;
  - skip still works;
  - not active for unlisted workflows.
- `setup-schema.test.mjs`, `install.test.mjs`, `init-interactive.test.mjs`, `publish.test.mjs` and any test asserting
  rail lists, config layout, selection fields or template hashes: **modify** (expectation updates).

## Behavior & Edge Cases

- **Chained commands** (`npm i a && npx b`): each simple command is checked, and the reason lists every package
  found.
- **`npm install <name>` where the name is already a dependency** (a version change): still matched. The name is
  being fetched.
- **Local paths, workspace refs and tarballs** (`npm i ./pkg`, `pnpm add workspace:*`, `pip install -e .`, `pip
  install ./dist/x.whl`): not matched. Git and HTTP URLs are matched and shown as the URL.
- **npx of a binary from a listed package with a different bin name** (e.g. `npx tsc` from `typescript`): listed
  through `node_modules/.bin/tsc`. If `node_modules` isn't installed yet, it prompts. That's acceptable.
- **Guardrails off at install:** the rail is written as `off` like the others (`GUARDRAILS_OFF_NOTE` behaviour).
- **`fail_first` lists a workflow that no longer exists:** a validation error in Setup; at runtime the unknown id is
  ignored.
- **A task started before `fail_first` was turned on:** the setting is read at advance time, so it applies from the
  next Reproduce advance. That's acceptable; the note says it.
- **A task already past Reproduce:** unaffected.
- **Manifest tampering:** `fail_first` lives in the task manifest, which `guard.mjs` already protects from Claude's
  edits.

## Constraints

- Vendored scripts stay Node 18+ with no dependencies.
- The hook stays fast. The npx "listed" check reads at most the `package.json` files up to the repo root and stats
  `.bin`, cached per hook run.
- `--expect-fail` never runs a shell string built from unvalidated input.
- Shipped 1.0 rules files are unchanged.

## Verification

1. **New and updated automated tests** (above); the full CLI suite and the Prettier, typecheck and UI build steps
   pass.
2. **Manual, in a test repo after `upgrade`:**
   - Ask Claude to add a package: the prompt names it.
   - `npx` an unknown tool: prompt. `npx` a devDependency: no prompt.
   - Set the rail to `off` in Setup: no prompt.
3. **Manual, Bugfix at each `fail_first` level:**
   - **note:** the note is shown.
   - **section:** advance is refused until `## Failing test` exists.
   - **proof:** advance is refused until `--expect-fail` records a failure, and Verify and the PR summary show
     before/after.
   - **skip:** skipping with a reason works.

## Open Questions

- None blocking. (2026-11-17: the wizard and terminal paths for fail-first were pinned; see "Where teams set it".)
- Chosen in planning on the user's "you suggest": at `proof` with no test command, advancing is refused (never
  downgraded).
