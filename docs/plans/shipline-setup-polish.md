# Setup polish and npm README (1.1.0)

**Status:** Approved
**Starts from:** `main` @ 43667bb (1.0.0, published). **Ships as:** 1.1.0, INTERFACE stays 1 (the hook contract doesn't change).
**Release:** after the merge, `v1.1.0` is tagged and `publish.yml` publishes through npm trusted publishing.

## Problem & Goal

Setting up Shipline is uneven:
- **Terminal `init`** writes files without a review.
- **Settings that are never asked:** terminal `init` never asks about confirmations; neither path asks about guardrails or the branch pattern; and `/shipline-setup` doesn't know about guardrails at all.
- **No clear next step:** both paths end without a clear "what now".
- **No npm README:** the npm page is blank.

**Goal:** the browser wizard becomes the default way to set up. Every path covers the same settings, ends with a review and then a numbered next-steps checklist. The npm page explains the package.

**Success:**
- A newcomer running `npx @forgeyard/shipline init` lands in the wizard, sets every setting, sees what will be written, and finishes on a checklist that tells them what to do next.
- `init --terminal` asks the same things and shows a review before writing.
- npmjs.com shows a README.

## Scope

### In

**1. Browser by default**
- With a terminal (TTY), no `--yes`, no `--dry-run` and Node 20+, `init` starts the browser wizard straight away (`startServer({ dir: root, port: 0, open: true })`). The "terminal or browser?" question is removed.
- **`init --terminal`** runs the terminal questions instead.
- **`--yes` and `--dry-run`** behave exactly as in 1.0.
- **Node 18–19** can't run the UI, so `init` uses the terminal questions and first prints "The setup wizard needs Node 20+; asking here instead." The terminal questions themselves still need Node 20.17+, as today, and fail with the existing message pointing to `--yes`.
- **No terminal and no `--yes`:** it refuses, as today, with the message "run it in a terminal, or pass --yes".
- **Help:** `bin/shipline.mjs` adds `--terminal` to the `init` help and its strict option list.

**2. The same settings everywhere.** Terminal `init`, the wizard and the install selection gain:
- **Confirmations** (`standard` or `light`; the wizard already has it). Terminal question: "Confirmations: Standard (asks before Open questions, Plan and Verify) / Light (asks only at plan approval)". Default Standard.
- **Guardrails** as one switch: `guardrails: 'on' | 'off'`, default `on`. Both paths show one summary line: "On: force-push to main and printing credentials are denied; pushes to main, deploys, migrations, edits to agent config and protected paths (migrations/, infra/, CI files, lockfiles…) ask first."
  - **`off`** writes every rail as `off` and `protected_paths: []`, with a comment above `rails:`: `# Guardrails are off (chosen at setup). Turn them on here or in Setup → Guardrails.` (How it's written: see the `install.mjs` row.)
  - **`on`** leaves the template as it is.
- **Branch pattern** (`branchPattern`, default `{type}/{key}-{slug}`): a free-text input showing the placeholders.
  - It's validated with the existing `setup-schema.mjs` `branch_pattern` rules. A validation error re-asks in the terminal and shows an inline error in the wizard.
  - An empty answer keeps the default. A value other than the default is written to `config.yml`.
- **`install.mjs`**: `defaultSelection` gets `guardrails: 'on'` and the default `branchPattern`. `checkSelection` validates both (`guardrails` must be `on` or `off`). `planInstall` applies them to `config.yml`. A missing field means the default, so older API callers keep working.

**3. Terminal flow reworked** (`init-prompts.mjs`). It covers the same ground as the wizard, grouped and numbered (`Step n of 7`):
1. **Workflows:** workflows, then "Does this repo have a UI?".
2. **Commands:** test, lint, build. Each is pre-filled with the detected command. The hint reads "Enter keeps it; type `none` to leave it empty", and `none` (case-insensitive) is stored as empty. This replaces the Backspace instruction.
3. **Tracker.**
4. **Process:** confirmations, then branch pattern.
5. **Guardrails:** the on/off switch with its summary line.
6. **Agents and skills:** stage agents, then standalone agents, then one question per name clash, then a replacement for each stage whose agent is missing, then the repo's own skills.
7. **CI check:** yes/no.

Then the **review** (item 4).

**4. Terminal review before writing**
- After the questions, `init` prints the settings summary:
  - workflows (and UI);
  - commands;
  - tracker;
  - confirmations;
  - guardrails;
  - branch pattern;
  - agents, with clash choices;
  - skills;
  - CI.
- It then prints the file list in the same format `--dry-run` uses (`+`, `~`, `=` lines, including `settings.json` and `CLAUDE.md`).
- Then it asks `Install these files? (Y/n)`.
  - **Yes** writes, as today.
  - **No** prints "Cancelled, nothing was written." and exits 1.
- `--yes` skips the review, as it skips every question.

**5. Next steps after install**
- **Terminal:** the final message replaces today's "Next: …" lines with a numbered checklist (exact text under Behavior).
- **Wizard:** after Install succeeds, it no longer reloads after 600 ms. It shows a final "You're set up" screen with the same checklist, a copy button on each command, and an **Open Shipline** button that reloads into the normal UI. Reloading the page also opens the normal UI, because the server is already in repo mode.

**6. `/shipline-setup` skill**
- A new interview topic, **Guardrails**:
  - rails (each `deny`, `ask` or `off`, with what each covers);
  - `protected_paths`;
  - `rails_commands` (extra deploy and migrate prefixes);
  - `scope_check`.
  - It points out that guardrails are defence in depth, and that hard limits need Claude Code's sandbox and managed settings.
- The **Enforcement** topic is rewritten for named actions: the default blocks are `actions: [commit, pr]` until Verify, and the available actions are commit, push, pr, merge, release, deploy and migrate. `{ bash: regex }` is mentioned only as the escape hatch.
- The topic list includes the branch pattern.
- **Tracker** and **confirmations** are kept as they are.

**7. npm README** (`packages/cli/README.md`), about 80–120 lines. Every link is absolute (`https://github.com/siddharth-Spark18/shipline/...`).
- **Contents:**
  - a one-paragraph "what it is";
  - a quickstart (`npx @forgeyard/shipline init` opens the wizard; `--terminal`; `--yes`);
  - what gets installed;
  - the commands table (`init`, `ui`, `upgrade`, `uninstall`, with their main flags);
  - requirements (Node 18+ for the hooks, 20+ for the UI, Claude Code, git);
  - links to the full README, the CHANGELOG, the LICENSE and issues.
- `package.json` `files` doesn't need it listed, because npm always includes `README.md`. `publish.test.mjs` asserts that `npm pack --dry-run` lists it.

**8. Root README.** The Install section and the quickstart are updated: `init` opens the wizard, `--terminal`, the review, the next-steps checklist, and the new guardrails and branch-pattern questions.

**9. Release files.**
- Version 1.1.0.
- A `## [1.1.0]` CHANGELOG entry.
- `known-hashes.json` **adds** the 1.1.0 hashes and keeps the 1.0.0 entries, so `upgrade` from 1.0.0 refreshes unedited files: `hash-templates.mjs` is run **without** resetting the file.
- `known-stub-rules.mjs` is unchanged unless a rules file changes.

### Out

- Prerequisite checks: `claude`, `gh` and its auth, the Atlassian MCP, a git remote.
- Per-rail choices at setup; those stay in Setup → Guardrails and `/shipline-setup`.
- A scope-check question at setup; it's in the skill only.
- An "edit a section" loop in the terminal review.
- Changes to `--yes` or `--dry-run`.
- Changes to the hooks, INTERFACE, or `upgrade` behaviour, beyond recording the new hashes.
- Changing the wizard's existing steps, other than adding the fields and the final screen.

## Surface Area

- **CLI:** `bin/shipline.mjs` (`--terminal`), `init.mjs` (default to the wizard, the review, next steps), `init-prompts.mjs` (reworked flow), `install.mjs` (the `guardrails` and `branchPattern` selection fields), and `setup-schema.mjs` (reuse its `branch_pattern` validation; export it if it isn't exported).
- **Server:** `ui/install-routes.mjs`. The selection passes through, and `/api/install/info` adds `branchPatternDefault` if the wizard needs it. There are no new endpoints.
- **UI:**
  - `install-wizard.tsx`: the guardrails switch and summary, plus the branch-pattern field, both in the "Commands & process" step; and the final screen.
  - `review-step.tsx`: shows the new settings.
  - `types.ts`: `InstallSelection` gains `guardrails` and `branchPattern`.
- **Templates:**
  - `claude/skills/shipline-setup/SKILL.md`;
- **Docs:** `packages/cli/README.md` (new), `README.md`, `CHANGELOG.md`.
- **Data and API:** the install selection gains two optional fields, `guardrails` and `branchPattern`. Nothing changes in the config schema; `branch_pattern`, `rails` and `protected_paths` already exist.

## Files to Touch

| Path | Change | What |
| --- | --- | --- |
| `packages/cli/bin/shipline.mjs` | modify | Adds `--terminal` to `init`'s allowed options and its help. |
| `packages/cli/src/init.mjs` | modify | Starts the wizard by default (item 1). Adds the terminal review and the Y/n question (item 4) and the next-steps checklist (item 5). Removes the `askWhere` call.<br>`runInit`'s parameters become `{ target, dryRun, yes, terminal, prompts, confirm, startUi }`: `where` is removed and `terminal` (from `--terminal`) is added. `confirm` is an optional `async (reviewText) => boolean` that replaces the real Y/n question, for tests. The review and its question also run when `prompts` is injected; only `--yes` skips them. When `prompts` is injected, the wizard is never started, as `where` behaved before. |
| `packages/cli/src/init-prompts.mjs` | modify | The reworked numbered flow (item 3), including the confirmations, guardrails and branch-pattern questions and the `none` hint for commands. Removes `askWhere` and adds `askConfirmInstall()`. |
| `packages/cli/src/install.mjs` | modify | Adds the `guardrails` and `branchPattern` selection fields: defaults, and `checkSelection` (which uses `branchPatternError`). They're written to `config.yml` through the existing parse-model-then-`emitConfig` path.<br>With `guardrails: 'off'`, `model.rails` is built from `RAIL_IDS` (imported from `setup-schema.mjs`, not hardcoded) with every value `off`, and `model.protected_paths = []`. After `emitConfig`, the comment line is inserted directly above the `^rails:` line with a text replace that keeps the file's line ending. A non-default `branchPattern` sets `model.branch_pattern`.<br>Any of these counts as a config change, so the file is re-emitted rather than copied. Exports a `nextSteps(selection)` helper that returns the checklist lines, used by `init` and served to the wizard. |
| `packages/cli/src/setup-schema.mjs` | modify | Adds and exports `branchPatternError(value)`, built on the private `checkPattern` (which requires `{slug}` and allows only `{key}`, `{slug}` and `{type}`). It returns the first error message or `null`. `install.mjs` `checkSelection` and the terminal prompt both use it. |
| `packages/cli/src/ui/install-routes.mjs` | modify | The install response includes `nextSteps` (from `nextSteps(selection)`). `info` includes the default branch pattern. |
| `packages/ui/src/lib/types.ts` | modify | `InstallSelection` gains `guardrails` and `branchPattern`; the install response gains `nextSteps: string[]`. |
| `packages/ui/src/pages/install/install-wizard.tsx` | modify | Adds the guardrails switch, its summary and the branch-pattern field to "Commands & process". After a successful install it shows the final "You're set up" screen (checklist, copy buttons, Open Shipline) instead of reloading. |
| `packages/ui/src/pages/install/review-step.tsx` | modify | Lists the guardrails and branch pattern among the settings. |
| `packages/cli/templates/claude/skills/shipline-setup/SKILL.md` | modify | The Guardrails topic and the named-actions enforcement text (item 6). |
| `packages/cli/README.md` | create | The npm README (item 7). |
| `README.md` | modify | Install and quickstart (item 8). |
| `packages/cli/CHANGELOG.md` | modify | The `## [1.1.0]` entry. |
| `packages/cli/package.json` | modify | Version 1.1.0. |
| `packages/cli/src/known-hashes.json` | modify | Adds the 1.1.0 hashes and keeps the 1.0.0 ones. |
| `packages/cli/test/**` | create / modify | Tests (test agent). |

## Behavior & Edge Cases

**Next-steps checklist.** Terminal and wizard show the same text, from `nextSteps(selection)`. Item 5 appears only when the CI check was added:

```
Next steps
  1. Commit the setup:  git add .shipline .claude CLAUDE.md && git commit -m "Add Shipline"
     (add .github/workflows/shipline.yml too if you chose the CI check)
  2. Open Claude Code in this folder (`claude`) and trust it when asked, so the hooks run.
  3. Try it: ask Claude for a small change, e.g. "fix the typo in README". It picks a workflow and shows the stages.
  4. Tailor the rules to this repo: run /shipline-setup in Claude Code (or `npx @forgeyard/shipline ui` → Setup).
  5. Make the CI check count: on GitHub, protect your main branch and require the "Shipline check", and add
     CODEOWNERS for .shipline/ and .github/ (see the README, "The pull-request check").
```

In the CI case, step 1's `git add` lists `.github/workflows/shipline.yml` directly, so the second line of step 1 isn't printed.

**Other behaviour:**
- **The wizard after install:**
  - **When the server is already in repo mode** (another tab installed first), the existing "installed meanwhile" handling still applies. That tab reloads into the normal UI, with no final screen.
  - **When install fails,** the existing error handling applies, with no final screen.
- **Branch pattern:**
  - **The wizard checks it on the client** with the same rule, copied into `install-wizard.tsx` (must contain `{slug}`; only `{key}`, `{slug}` and `{type}` are allowed). The server's `checkSelection` is still the authority.
  - **An invalid pattern** (per `setup-schema`) is re-asked in the terminal with the validator's message. In the wizard it shows inline, and Next is disabled until it's fixed.
  - **Whitespace** around it is trimmed.
- **Guardrails `off`:** `protected_paths` is written as an empty list. The next-steps text doesn't change.
- **`init --terminal --yes`:** `--yes` wins, so there are no questions and no review.
- **`init --terminal` on a non-TTY:** refused like any interactive run.
- **Ctrl+C during the questions or the review:** the existing "init cancelled, nothing was written" message, exit 1.
- **Browser can't open** (SSH, headless): the server prints its URL as it does today, and the user opens it manually.

## Constraints

- The hooks are untouched, and INTERFACE stays 1.
- `--yes` output and file contents are byte-identical to 1.0.0 for the same repo, apart from the version in `VERSION` and the new next-steps lines.
- The UI bundle stays at about 284 KB, with no new dependencies.
- The full CI matrix must be green.

## Verification

1. **Tests:**
   - `init` starts the wizard by default (start function injected); `--terminal` runs the prompts; `--yes` and `--dry-run` are unchanged.
   - The Node <20 fallback note.
   - A review "No" writes nothing and exits 1, while "Yes" installs.
   - The guardrails off/on `config.yml` content; the branch-pattern validation and writing.
   - `nextSteps` with and without CI.
   - The commands prompt treats `none` as empty.
   - The install API accepts the new fields and returns `nextSteps`.
   - The npm README is in `npm pack`, with absolute links only (no `](./` or `](../`).
   - `known-hashes` keeps the 1.0.0 entries and adds 1.1.0.
   - The skill text mentions the rails and `actions:`.
2. **By hand (author):**
   - In a scratch repo, `npx @forgeyard/shipline@1.1.0 init` opens the wizard. Set guardrails off and a custom branch pattern, install, and check the final screen. Then check `config.yml`.
   - `init --terminal` in another scratch repo: walk the steps, answer No at the review (nothing written), rerun, then answer Yes.
3. **After `v1.1.0` is tagged:** `npm view @forgeyard/shipline@1.1.0` has provenance (`dist.attestations`), and npmjs.com shows the README.

## Open Questions

- None blocking.
