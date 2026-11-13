# Setup redesign: Claude or in-app setup, full stepper, and the "setup done" banner

**Status:** Approved

Branch: `fix/stack-gaps` (same branch as the stack-gap fixes), released together as **1.3.0**.

## Problem & Goal

When `shipline ui` runs in a repo without Shipline, it opens a 5-step install wizard (Workflows, Agents & skills,
Commands & process, CI check, Review). That wizard only covers part of what setup means:

- Guardrails are a single on/off switch with a one-line summary, not the per-rail controls the Setup page has.
- Per-stage enforcement, confirmation and rules can only be tailored afterwards, by running `/shipline-setup` in
  Claude or by editing on the Setup page.
- **Bug:** only `/shipline-setup` writes `setup: done` to `.shipline/config.yml`. A team that sets everything up in
  the app keeps seeing the "Shipline is using its default rules, run setup with Claude" banner on the Setup page
  (`setup-page.tsx`, `usesDefaultRules`) and the same reminder at Claude Code session start (`session-start.mjs`).
  Confirmed with the user: they set up through the in-app wizard and the banner stayed.

Goal: at first setup the developer chooses **Set up with Claude** or **Set up here**. "Set up here" is a full stepper
that covers everything Claude's interview covers, all guardrails included, and finishing it counts as setup done.

Success:

- From a fresh repo, both paths end in an installed repo. After "Set up here", no default-rules banner and no
  session-start reminder appear. After "Set up with Claude", a chat is open with `/shipline-setup` already sent.
- An installed repo that isn't set up can clear the banner with **Mark setup as done**.

## Scope

**In**

1. **Path choice:** a first screen in the install wizard with two cards.
   - **Set up with Claude:** goes straight to Review with the default selection (what `init --yes` installs). After
     Install, a chat starts with `/shipline-setup`.
   - **Set up here:** goes to the stepper, pre-filled with the same defaults.
2. **Stepper (7 steps):**
   1. **Workflows:** pick workflows and answer "does this repo have a UI?" (as today).
   2. **Stages & rules:** for each chosen workflow, a tab with the Setup page's stage list and stage editor
      (`StageList` and `StageEditor`). Covers adding, removing and reordering stages, optional, enforcement
      (guide/warn/block plus blocks), confirm to advance, agent, and the rules text inline.
   3. **Agents & skills:** as today, worked out from the stages drafted in step 2.
   4. **Project:** tracker, branch pattern, test/lint/build commands and confirmations (today's Commands & process,
      without the guardrails switch).
   5. **Guardrails:** the Setup page's `GuardrailsSection`, unchanged: every rail (deny/ask/off), protected paths,
      extra deploy/migrate commands and the scope check.
   6. **CI check:** as today.
   7. **Review:** every file that will be written, then Install.
3. **Write timing:** nothing is written until Review's Install, which makes one install call. The install API takes
   full workflow models, rules texts, the guardrail parts of config, and a "setup done" flag.
4. **Errors on Review:** server validation problems are listed under the step they belong to, each with a "Go to
   step" button. Install stays disabled until there are none.
5. **"Setup done":** installing from the stepper writes `setup: done`. The Claude path doesn't, because
   `/shipline-setup` writes it at its end.
6. **Setup page banner** (installed repo, setup not done): keep **Run setup with Claude**, add **Mark setup as done**,
   and say the sections below can be edited directly. Mark done calls a new endpoint, with no confirmation dialog.

**Out (explicitly agreed)**

- `init --terminal` and `init --yes` are unchanged: same questions, guardrails on/off only.
- No new or copied workflows in the stepper. That stays on the Setup page after install.
- No phone layout for the stepper. It runs before install, and phone access needs an installed repo.
- Better test/lint/build command detection (monorepos, Python without pytest, polyglot order, more stacks) gets
  its own plan.
- No "turn all guardrails off" shortcut in the stepper; rails are set one by one.
- Re-running the stepper on an already installed repo.

## Surface Area

- **Frontend** (`packages/ui`): the install wizard, a new path-choice screen, a new Stages & rules step, the Review
  error list, and the Setup page banner. `StageList`, `StageEditor` and `GuardrailsSection` are reused unchanged.
- **Backend** (`packages/cli/src`): `installInfo` (shipped templates as models), `checkSelection` and `planWrites`
  (new selection fields), install preview validation, a new mark-done endpoint, and `nextSteps`.
- **Data:** no new files or stores. `config.yml` may gain `setup: done` (already a known key, see
  `setup-schema.mjs` `top`). The workflow, rules and config files are the same files install writes today, with
  drafted content.
- **API contract** (the UI and CLI ship together in one package, so no versioning concern):
  - `GET /api/install/info` adds:
    ```
    templates: {
      workflows: Record<workflowId, WorkflowModel>,  // parsed shipped .shipline/workflows/<id>.yml
      rules: Record<stageId, string>,                // shipped .shipline/rules/<id>.md texts
      config: ConfigModel                            // parsed shipped .shipline/config.yml
    }
    ```
    `infoBody` in `install-routes.mjs` builds the response from an explicit field list, so it must pass
    `templates` through from `installInfo`.
  - `InstallSelection` (used by `POST /api/install/preview` and `POST /api/install`) gets optional fields. When a
    field is absent, behaviour is exactly as today, so terminal init is unaffected.
    ```
    workflowModels?: Record<workflowId, WorkflowModel>  // one per id in `workflows`
    rules?: Record<stageId, string>
    guardrailConfig?: { rails, rails_commands, protected_paths, scope_check }  // ConfigModel shapes
    setupDone?: boolean
    ```
    - **`workflowModels`:** the server writes each chosen workflow from its model with `emitWorkflow(model,
      { header: headerFor(id) })`. It first drops `ui_only` stages when `ui` is false, as it does for template text
      today. The client always sends the full drafted models and lets the server filter them.
    - **Agents on the model path:** the server does **not** apply `stageAgents` to `workflowModels`, and does not
      silently drop agents. In the Agents & skills step, the "replacement or none" pick for each stage whose agent
      isn't being installed is written straight into that stage of the drafted model: a replacement sets `agent`,
      and "none" removes it. A stage that still names an agent not in the selection (and not one of the repo's own)
      is a validation error on Review. The text path, used by terminal init, keeps today's `applyStageAgents`
      behaviour.
    - **`rules`:** one `rules/<stageId>.md` is written for every active stage id. The text comes from `rules[id]`
      when given; otherwise the shipped template, if one exists; otherwise an empty file.
    - **`guardrailConfig`:** replaces those four keys in the config model before `emitConfig`, and takes precedence
      over `guardrails: 'on' | 'off'`. The wizard no longer sends `guardrails`; the server still accepts it.
    - **`setupDone: true`:** sets `model.setup = 'done'` before `emitConfig`.
  - **Validation:** `checkSelection` validates each `workflowModels` entry with `validateWorkflow`. Its agents are
    the selected agents plus the repo's own; `existingStageIds` are the shipped stage ids of that workflow. It
    validates the resulting config model with `validateConfig` (`skills` = the repo's skills).
    - On problems, preview and install answer `400` with code `invalid` and details
      `[{ file, path, message }]`. `file` is a repo-relative path such as `.shipline/workflows/feature.yml` or
      `.shipline/config.yml`; `path` is the dotted path from the validator.
    - **Mechanism:** `checkSelection` collects validator problems and throws one `Error` whose `message` is a plain
      summary (what terminal init prints today) and which carries `issues: [{ file, path, message }]`.
      `selectionOf` in `install-routes.mjs` passes them on as `new HttpError(400, 'invalid', e.message, e.issues)`.
      Shape errors from today's checks keep throwing plain Errors with no `issues`, and the client shows their
      message as today.
  - **New** `POST /api/setup/mark-done` (installed mode, in `src/ui/setup.mjs`):
    - Reads `config.yml`, sets `setup: done` and writes it back with `emitConfig` (keeping comments and layout, as
      a Setup save does). Returns `{ ok: true }`.
    - If `config.yml` doesn't parse, it answers `400 invalid-config` with a message.
    - If the repo is newer than the UI, it answers the same read-only error other Setup writes give.
- **Client issue-to-step mapping:**
  - `.shipline/workflows/*` → Stages & rules.
  - `config.yml` with path `rails`, `rails_commands`, `protected_paths` or `scope_check` → Guardrails.
  - `config.yml` with `skills` → Agents & skills.
  - Any other `config.yml` path → Project.

## Files to Touch

**Frontend**

- `packages/ui/src/pages/install/install-wizard.tsx`: **modify**.
  - Start on the path-choice screen.
  - Make the stepper 7 steps (order above). The draft holds the workflow drafts (`WorkflowDraft` per id, from
    `info.templates.workflows`), rules texts, and the guardrail part of a config model (from
    `info.templates.config`).
  - Work out agents from the drafted stages. The Agents step's per-stage "replacement or none" pick edits the
    drafted model directly (see "Agents on the model path"); `stageAgents` isn't sent on the stepper path.
  - Remove the guardrails switch and `GUARDRAILS_SUMMARY`.
  - The stepper path sends `workflowModels`, `rules`, `guardrailConfig` and `setupDone: true`. The Claude path
    sends the default selection only.
  - After a Claude-path install, call `api.createChat('/shipline-setup')`, then reload into `#chat`. On load,
    `lib/use-chat-selection.ts` selects the active chat, which is the new one. No chat-store update is needed
    before the reload.
- `packages/ui/src/pages/install/path-choice.tsx`: **create**.
  - Two cards, "Set up with Claude" and "Set up here", each with a short description. The Claude card notes it
    needs Claude Code installed and signed in.
- `packages/ui/src/pages/install/stages-step.tsx`: **create**.
  - The Stages & rules step: a tab per chosen workflow rendering `StageList` with that workflow's draft. Stages are
    filtered for display by the UI answer, as `activeStages` does.
  - Rules are read and written through the shared rules map. Rules are keyed by stage id, so a stage id used in two
    workflows shares one rules text, the same as on the Setup page.
  - `SetupAgents` comes from `info.agents` (`installed: false, excluded: false, hash: null`) and `info.repoAgents`.
- `packages/ui/src/pages/install/review-step.tsx`: **modify**.
  - When preview returns `invalid`, list each issue grouped under its step (using the mapping above), with a "Go to
    step" button, and keep Install disabled.
- `packages/ui/src/pages/setup/setup-page.tsx`: **modify**.
  - Banner copy: run setup with Claude, or edit the sections below.
  - Add a **Mark setup as done** button that calls `api.markSetupDone()`, then invalidates `queryKeys.setup`.
    Errors show as a toast.
- `packages/ui/src/lib/api.ts`: **modify**. Add `markSetupDone()`; the install preview and install calls carry the
  new selection fields.
- `packages/ui/src/lib/types.ts`: **modify**. Add `InstallInfo.templates`, the new optional `InstallSelection`
  fields, and the install validation issue type `{ file, path, message }`.

**Backend**

- `packages/cli/src/install.mjs`: **modify**.
  - `installInfo` returns `templates`.
  - `checkSelection` checks the shapes of the new fields and runs the validators.
  - `planWrites` uses `workflowModels`, `rules`, `guardrailConfig` and `setupDone` as specified.
  - `nextSteps` drops the "Tailor the rules … /shipline-setup" item, and renumbers, when `selection.setupDone`.
- `packages/cli/src/ui/install-routes.mjs`: **modify**. `infoBody` passes `templates` through. `selectionOf` passes
  `e.issues` as `HttpError` details. Preview and install return `400 invalid` with the
  `[{ file, path, message }]` details.
- `packages/cli/src/ui/setup.mjs`: **modify**. Add the `POST /api/setup/mark-done` route.

**Docs**

- `packages/cli/CHANGELOG.md`: **modify**. 1.3.0 gets "Added" (the path choice, the full stepper, Mark setup as done)
  and "Fixed" (the banner after an in-app setup).
- `docs/install.md`: **modify**. Describe the two setup paths and the stepper's steps where the browser wizard is
  described.

## Behavior & Edge Cases

- **Defaults:** the stepper starts from what `init --yes` would install: the shipped workflow models, rules and
  config guardrails, plus the detected commands and UI answer. Going back and forth between steps keeps edits.
- **Changing the UI answer** in step 1 after editing stages: drafts keep every stage, and `ui_only` stages are hidden
  in the Stages & rules step and dropped server-side while the answer is "no". Switching back to "yes" brings them
  back with their edits.
- **Deselecting a workflow** drops it from the selection. Its draft is kept in memory in case it's ticked again.
- **New stage ids:** validated by `validateWorkflow` (format, clashes) and reported on Review. A new stage's rules
  default to empty.
- **Review loading and errors:**
  - Preview runs on entering Review, as today.
  - Network or server errors show as today.
  - `invalid` shows the grouped list.
  - A `409 installed` (a second tab) reloads into the app, as today.
- **Claude path, chat can't start** (Claude Code missing or not signed in, or `chat-active`): the install has
  already succeeded. Show the existing done screen with an error line saying to run `/shipline-setup` from the
  Setup page or in Claude Code, plus the Open Shipline button. The banner stays, because setup isn't done.
- **Mark setup as done:** after success the banner disappears; the session-start reminder stops at the next session
  (it already reads `setup`). It isn't offered when the repo is newer than the UI (read-only).
- **Existing partial installs** (the CLAUDE.md block or hooks found): the warnings on the first screen and in Review
  work as today.
- **Terminal init:** sends none of the new fields, so its output is byte-for-byte the same as today.

## Constraints

- Hook scripts and the vendored templates are unchanged, so there are no new template hashes. `lib.mjs` already has
  its 1.3.0 hash from the stack-gap fixes.
- The UI bundle must stay within the 400 KB gzip budget (`scripts/build-ui.mjs`).
- No new dependencies. Reuse the existing shadcn components, `StageList`, `StageEditor` and `GuardrailsSection`.
- The server stays the authority on validation; the client doesn't duplicate validator rules beyond what the
  reused editors already do.

## Verification

Chosen by the user:

1. **Click through both paths** in a fresh git repo with `shipline ui`:
   - **Set up here:** change a stage's enforcement and rules, set a rail to deny, add a protected path, then Install.
     Check that the written files reflect it, that `config.yml` has `setup: done`, and that the Setup page shows no
     banner.
   - **Set up here, with an error:** create a bad stage id and confirm Review lists it under Stages & rules, "Go to
     step" works, and Install is disabled until it's fixed.
   - **Set up with Claude:** Review of the defaults, Install, then a chat opens with `/shipline-setup` sent. The
     Setup page shows the banner until Claude finishes.
   - **Mark setup as done** on an installed repo without `setup: done`: the banner goes away and `config.yml` gains
     the key with its comments intact.
2. **UI typecheck and build:** `check:ui` / tsc, and the bundle budget.

The existing CLI test suite must still pass (`npm test` in `packages/cli`). Tests that assert the exact
`/api/install/info` shape may need updating.

## Open Questions

- **No new automated tests were chosen** for the new install fields or the mark-done endpoint; verification is
  manual plus typecheck. Accepted for now. Worth adding later, since `planWrites` changes are covered elsewhere
  only by the existing install tests.
