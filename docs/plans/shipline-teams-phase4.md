# Teams Phase 4: lighter confirmations

**Status:** Approved
**Roadmap:** `docs/plans/shipline-teams-roadmap.md`, row 4
**Basis:** `.claude/research/ai-dev-guardrails-synthesis-2026-11-05.md`. About 93% of permission prompts are approved, the best-supported human checkpoints are plan approval and merge, and the evidence for confirmations mid-run is thin.
**Starts from:** `main` @ 58a83f8 (0.13.0). **Ships as:** 0.14.0, INTERFACE 6 → 7.

## Problem & Goal

The shipped feature workflow asks the developer before leaving Open questions, Plan, Wireframes and Verify. It also asks on a required skip, on accepting failed checks, and in the Phase 3 scope question. Teams that find this too much have one option: edit `confirm_to_advance` stage by stage in every workflow.

**Goal:** an opt-in, repo-wide **light** preset.
- Light mode asks to advance only at stages marked as checkpoints (plan approval).
- The rest of the workflow advances on deterministic checks.
- The questions that guard against something going wrong stay on: required skip (`skip`), failed checks (`accept`) and the scope question (`scope`).
- **Standard** stays the default and behaves exactly as today.

**Success:**
- In light mode, a feature task asks only at Plan, plus skip, accept or scope when one is triggered.
- The CI check agrees with the hooks about which stages needed an answer.
- The UI shows the setting that's actually in effect.

## Scope

**In:**
- **New config key** `confirmations: standard | light` in `.shipline/config.yml`. A missing or unknown value means `standard`.
- **New stage field** `checkpoint: true`. It's shipped on feature's `plan` stage and bugfix's `root_cause` stage. Hotfix and small have no checkpoint.
- **One rule**, shared by the hooks and CI:
  - a stage needs the developer's answer to advance when `confirm_to_advance` is true and either `confirmations` isn't `light` or `checkpoint` is true;
  - skip, accept and scope ask in both modes.
- **Hooks** apply the rule in these places:
  - `stage.mjs` advance;
  - the stage description text;
  - provenance in the PR summary;
  - `ci-check.mjs`.
- **The rule takes effect immediately.** The next `advance` uses the current config. If an `advance` question is pending and the rule no longer needs it, `advance` clears `pending_confirm` and advances, with provenance `auto`. Pending `skip`, `accept` and `scope` questions are untouched.
- **Setup page:**
  - a Standard/Light choice in the config form;
  - a "Checkpoint (asks in light mode)" toggle in the stage editor;
  - a note in the workflow editor when light mode is on and the workflow has no checkpoint stage.
- **Setup wizard:**
  - the "Commands & tracker" step is renamed "Commands & process";
  - a Standard/Light radio sits below the tracker, with Standard preselected;
  - choosing Light writes `confirmations: light` to config.yml.
- **`/shipline-setup` skill:** Claude asks Standard or Light and writes the key.
- **Task panel:** "Claude asks you before moving on." shows only when the rule says the stage asks.
- **`upgrade`:**
  - adds `confirmations: standard` with an explanatory comment when the key is missing;
  - adds `checkpoint: true` to the `plan` stage of `feature.yml` and the `root_cause` stage of `bugfix.yml` (matched by workflow id) when the file sets no `checkpoint` anywhere and that stage has `confirm_to_advance: true`, the way 0.11 added `checks: true`. It is listed in the preview as "checkpoint on <stage>". (Changed during the build: there is no template refresh for workflow files.)
- **README:** a short "Confirmations" section covering the two presets, `checkpoint`, and the fact that skip, accept and scope always ask.
- **Validation:**
  - `setup-schema.mjs` accepts `confirmations` (`standard` or `light`) and the stage field `checkpoint` (boolean);
  - `checkpoint` on a stage without `confirm_to_advance` is a validation **warning**, not an error.

**Out:**
- Per-workflow or per-developer presets.
- Changing the defaults: standard stays the default for new and upgraded repos.
- Fixing the preset at task start, or recording the mode in the PR summary.
- A fallback for workflows with no checkpoint: they simply ask at nothing in light mode, and Setup's note says so.
- A checkpoint on the Open questions stage.
- Any change to skip, accept or scope.
- A choice in the `init` CLI. `init --yes` writes standard, and interactive init doesn't ask.
- Turning off the Phase 3 scope question.

## Surface Area

- **Hooks** (vendored, Node 18):
  - `lib.mjs` gets the shared rule;
  - `stage.mjs` and `ci-check.mjs` use it.
- **CLI:** `setup-schema.mjs` (keys and validation), `upgrade.mjs` (key insertion), `install.mjs` (wizard selection → config), `interface.mjs` and `package.json` (version), `known-hashes.json` (new template hashes).
- **Server:** no new endpoint.
  - The setup GET already returns the config and workflow models that the task panel and Setup read.
  - The install selection gains `confirmations: 'standard' | 'light'`, which defaults to `'standard'` when missing.
- **UI:** `types.ts`, `config-form.tsx`, `stage-editor.tsx`, `workflow-editor.tsx`, `draft.ts`, `install-wizard.tsx`, `task-panel.tsx`, and a TypeScript copy of the rule.
- **Data:** no store or schema migration. `confirmations` is a new optional config key and `checkpoint` a new optional stage field. The PR summary format stays `v: 2`, with no new field.

## Files to Touch

| Path | Change | What |
| --- | --- | --- |
| `packages/cli/templates/shipline/bin/lib.mjs` | modify | Add `export function needsAnswer(stageCfg, config)`, implementing the rule above. Normalize `config.confirmations`: anything other than `'light'` is standard. |
| `packages/cli/templates/shipline/bin/stage.mjs` | modify | **`advance`:** call `needsAnswer` instead of reading `sc.confirm_to_advance`. When it's false and `pending_confirm.kind === 'advance'` for this stage, clear the pending question and advance. Before advancing, look for an "Advance" answer the developer already gave for this stage, using the same approval lookup `requireAnswer` uses. If there is one, consume it and set `confirmed = { via: 'answer', at }`, whichever mode is on. Otherwise leave `confirmed` unset, so provenance is `auto`.<br>Every call in this file uses the existing module-level `cfg` (`loadConfig(root)`, line ~64) as the `config` argument, so no function signatures change.<br>**`describeCurrent` (line ~169):** say YES or no from `needsAnswer`; in light mode, a non-checkpoint stage reads "no (light confirmations: auto-advance)".<br>**`provenance` (line ~481):** a done stage without an answer is `auto` when `needsAnswer` is false, and `null` otherwise. |
| `packages/cli/templates/shipline/bin/ci-check.mjs` | modify | Line ~103: use `needsAnswer(sc, cfg)`, where `cfg` is the existing module-level `loadConfig(root)` result (line ~48), read from the PR's own tree. |
| `packages/cli/templates/shipline/config.yml` | modify | Add `confirmations: standard`, with a comment explaining light mode, checkpoints and the questions that always ask. |
| `packages/cli/templates/shipline/workflows/feature.yml` | modify | Add `checkpoint: true` on `plan`, and describe `checkpoint` in the header comment. |
| `packages/cli/templates/shipline/workflows/bugfix.yml` | modify | Add `checkpoint: true` on `root_cause`. |
| `packages/cli/templates/claude/skills/shipline-setup/SKILL.md` | modify | Add a step: ask Standard or Light (one line explaining each) and write `confirmations`. |
| `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` | modify | One line: whether to ask comes from `stage.mjs` output, not the YAML. Light mode may auto-advance a `confirm_to_advance` stage. |
| `packages/cli/src/setup-schema.mjs` | modify | Add `confirmations` to `KNOWN_FIELDS.config.top` and `checkpoint` to the stage fields. Validate `standard` or `light` (any other value is an error), and add `checkpoint` to the boolean list. Warn on `checkpoint` without `confirm_to_advance`. |
| `packages/cli/src/install.mjs` | modify | Accept `selection.confirmations`. When it's `'light'`, set `model.confirmations = 'light'` (counts as `changed`). Any other value, missing or unknown, is treated as standard without an error, and the template's standard is left as it is. |
| `packages/cli/src/upgrade.mjs` | modify | When `confirmations` is missing, insert `confirmations: standard` with the template's comment. List it in the preview and the final message ("New: confirmations preset"). |
| `packages/cli/src/interface.mjs` | modify | INTERFACE 6 → 7. |
| `packages/cli/package.json` | modify | Version 0.14.0. |
| `packages/cli/src/known-hashes.json` | modify | Record the new template hashes for 0.14.0. |
| `packages/ui/src/lib/types.ts` | modify | Add `confirmations?: 'standard' \| 'light'` to the config model, `checkpoint?: boolean` to `StageModel`, and `confirmations` to the install selection type. |
| `packages/ui/src/lib/confirmations.ts` | create | `needsAnswer(stage, config)`, the TypeScript copy of the rule, with a comment pointing to `lib.mjs`. |
| `packages/ui/src/pages/setup/config-form.tsx` | modify | Add a Standard/Light select with a one-line description of each. |
| `packages/ui/src/pages/setup/draft.ts` | modify | Carry `confirmations` in the draft. |
| `packages/ui/src/pages/setup/stage-editor.tsx` | modify | Add `checkpoint` to the field list, plus a "Checkpoint (asks in light mode)" switch that's disabled unless `confirm_to_advance` is on. |
| `packages/ui/src/pages/setup/workflow-editor.tsx` | modify | When the draft config is light and no stage has `confirm_to_advance && checkpoint`, show the note "In light mode this workflow never asks before advancing." |
| `packages/ui/src/pages/install/install-wizard.tsx` | modify | Rename step 2 to "Commands & process". Add a Standard/Light radio below the tracker (Standard preselected) and send `confirmations` in the selection. |
| `packages/ui/src/components/task-panel.tsx` | modify | Line ~84: show "Claude asks you before moving on." only when `needsAnswer(c, setup.config)` is true. |
| `README.md` | modify | Add a "Confirmations" section. |
| `packages/cli/test/**` | create / modify | Tests (written by the test agent, not feature-builder). |

## Behavior & Edge Cases

- **Rule.** `needsAnswer = confirm_to_advance === true && (confirmations !== 'light' || checkpoint === true)`.
  - A missing, empty or unknown `confirmations` value counts as standard at runtime. The schema flags an unknown value as an error in Setup and upgrade.
- **Light feature run:**
  - Ticket, Feasibility, Open questions, Wireframes, Implement, Verify and PR all advance without an `advance` question.
  - Plan asks.
  - Verify still can't finish until checks pass or the developer accepts the failures (`accept`), and the scope question still asks when something is flagged.
- **Light with no commands configured:** Verify finishes on its own. The PR summary already says "no commands configured".
- **Light hotfix or small:** never asks to advance; only skip, accept and scope ask.
- **Custom workflow with no checkpoint in light mode:** never asks to advance. Setup's workflow editor shows the note, with no fallback.
- **Switching mid-task:**
  - **Standard → light:** a pending `advance` question that's no longer needed is cleared on the next `advance`, and the stage finishes as `auto`.
  - **Light → standard:** the next `advance` on a confirm stage asks as it does today.
  - Stages already finished keep their recorded provenance.
- **CI:**
  - In light mode, `auto` on a non-checkpoint confirm stage passes.
  - A checkpoint stage that's done without `answer` fails with the existing message.
  - In standard mode nothing changes. CI uses the config in the PR's own tree, so switching to light shows up in the diff, and `.shipline/**` is covered by the `agent_config` rail.
- **`checkpoint: true` without `confirm_to_advance`:** has no effect, and the schema warns.
- **Upgrade:**
  - The key is added only when it's missing, and an existing value is never changed.
  - A workflow that already sets `checkpoint` on any stage, or whose checkpoint stage no longer asks to advance, is left alone. Other workflows get no checkpoint; in light mode the Setup note tells the team.

## Constraints

- The hooks stay Node 18-compatible with no dependencies, and fail open as today.
- Standard mode, and a missing key, behave exactly as 0.13.0 does: same questions, same provenance, same CI result. Existing tests must pass unchanged, apart from template-hash updates and the tests that list every known config or stage field (for example `setup-schema.test.mjs`), which gain `confirmations` and `checkpoint`.
- `lib.mjs` (`needsAnswer`) is the only source of the rule for the hooks and CI. The UI copy has to match it, and a test keeps the two in step.
- The UI bundle stays roughly where it is (about 283 KB). No new dependencies.

## Verification (done when)

1. **Light feature run:** in a temp repo with `confirmations: light`, a feature task asks to advance only at Plan. Skip of a required stage, accepting failed checks, and the scope question still ask when triggered. This is covered by hook tests and checked once by hand in an interactive session.
2. **CI agrees:**
   - in light mode, a summary with `auto` on questions, wireframes and verify passes `ci-check`;
   - a summary where `plan` is done without `answer` fails;
   - the same summaries under standard fail as they do today.
3. **The UI reflects it:**
   - the task panel line follows the effective rule;
   - the stage editor's checkpoint switch saves `checkpoint: true`;
   - the workflow editor note appears in light mode with no checkpoint;
   - the Setup config form and the wizard radio write `confirmations`, and the wizard defaults to Standard.
4. **Full suites green** on the CI matrix: Ubuntu, macOS and Windows, on Node 18 (hooks) and Node 20 (CLI and UI).

## Open Questions

- None blocking.
- **Accepted trade-off:** with "takes effect immediately", a developer can switch a repo to light partway through a task to skip a pending `advance` question. The config change shows in the PR diff, and editing `.shipline/**` is held by the `agent_config` rail when it's on.
