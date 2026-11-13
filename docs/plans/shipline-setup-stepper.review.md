# Review: shipline-setup-stepper

## 1. Verdict

Ready after must-fixes (3 must-fix items, all small).

## 2. Paraphrase

**What the plan proposes.** The browser install wizard (shown when `shipline ui` runs in a repo without Shipline) gets a first screen with two choices. "Set up with Claude" goes straight to Review with the `init --yes` defaults. After Install it starts a chat that sends `/shipline-setup`. "Set up here" opens a 7-step stepper. The stepper adds a Stages & rules step, which reuses the Setup page's `StageList` and `StageEditor`, and a Guardrails step, which reuses `GuardrailsSection`. Nothing is written until Install. Install then writes the drafted workflows, rules and guardrail config, and writes `setup: done`. This fixes the bug where the "default rules" banner never clears after an in-app setup. The API grows optional selection fields (`workflowModels`, `rules`, `guardrailConfig`, `setupDone`), `info.templates`, and a structured `400 invalid` issue list that Review groups by step. An installed repo that isn't set up gets a **Mark setup as done** button backed by a new `POST /api/setup/mark-done`. Terminal init is unchanged.

**How the existing system works, per the plan.** The wizard has 5 steps. Guardrails are a single on/off switch. Only `/shipline-setup` writes `setup: done`, so in-app setups keep the banner and the session-start reminder. The server's `planWrites` writes shipped template text, with `ui_only` stages removed and stage agents rewritten as text edits. `checkSelection` validates the selection shape. The Setup page already has the stage editor, the guardrails section and a "run setup with Claude" banner. `emitWorkflow`, `emitConfig`, `validateWorkflow` and `validateConfig` already exist. `lib/use-chat-selection.ts` picks the active chat on load.

## 3. Must-fix

1. **`GET /api/install/info` is built in `install-routes.mjs` (`infoBody`), not in `installInfo`.**
   - Plan: API contract and Files to Touch. The plan says `installInfo` returns `templates`, and lists `install-routes.mjs` only for the 400 change.
   - `infoBody` builds the response from an explicit field list. It will drop `templates` unless it is edited too.
   - Why it matters: a builder following the plan literally ships an info response with no templates. The stepper has nothing to start from.
   - Fix: add to the `install-routes.mjs` bullet that `infoBody` passes `templates` through. Also say whether `installInfo` itself returns it, or whether it is computed only for the route. Terminal init and other `installInfo` callers don't need it.

2. **The `400 invalid` details shape has no path from the validators to the route.**
   - Plan: "Validation".
   - Today `checkSelection` throws a plain `Error("invalid selection: ...")`, and `selectionOf` turns it into `HttpError(400, 'invalid', message)`.
   - The plan needs `[{ file, path, message }]` details but doesn't say how they get out of `checkSelection`. Options: a new error type carrying `issues`, a new return value, or a separate function. It also doesn't say whether `HttpError`'s fourth argument (`details`) is the place for them. `HttpError(409, ..., { state, found })` suggests it is.
   - Why it matters: this is the data shape the UI's Review step depends on. The builder has to choose it, and it touches both layers.
   - Fix: state that `checkSelection` throws an error with `.issues` and that `selectionOf` passes them as `HttpError` details. Keep the plain-string message for the existing shape errors.

3. **`stageAgents` and the model path conflict.**
   - Plan: `workflowModels` bullet and the `validateWorkflow` agents rule.
   - Today `applyStageAgents` has two jobs. It applies `stageAgents` overrides. It also drops any stage `agent:` whose agent isn't present in the selection (not selected, or clash `skip`).
   - The plan says the model path "applies `stageAgents`, the same two steps", but the stepper edits `agent` directly in `StageEditor` and doesn't need `stageAgents`.
   - It is unclear whether the model path should still silently drop a stage agent that isn't present, or whether `validateWorkflow` should reject it. The plan says validation uses "selected agents plus the repo's own", which treats it as an error.
   - The two behaviours differ. A user who deselects an agent in step 3, while a drafted stage still names it, gets either a silent drop or a Review error.
   - Fix: pick one rule and write it down. Suggested: on the model path, a stage whose agent is not present fails validation and is listed under Stages & rules (or Agents & skills), and `stageAgents` is ignored.
   - Also say whether the Agents & skills step is where the stage-agent fallback prompt still lives. The plan only says "as today, worked out from the drafted stages".

## 4. Optional (non-blocking)

- `existingStageIds` is "the shipped stage ids of that workflow". Please say what `validateWorkflow` uses it for. If it exempts these ids from clash checks, a user-added stage named like a shipped stage in another workflow is a case to state.
- `guardrailConfig` is validated by `validateConfig` on the whole resulting model. Say that a `guardrailConfig` error carries `file: '.shipline/config.yml'` (the mapping section implies it).
- Preview and install both read the same selection, so one `selectionOf` change covers both. A one-line note would help.
- The Claude path sends the defaults but never sends `setupDone`. The `nextSteps` change only keys off `setupDone`, so the Claude path keeps the "Tailor the rules" item, which is correct. Say so.
- `init --terminal` byte-for-byte parity. `planWrites` today writes the template text verbatim when `!changed`. The plan keeps this. Fine, but the new `setupDone`/`guardrailConfig` code must stay inside the `changed` branch logic. Existing tests cover this.
- No new automated tests, as the plan accepts in Open Questions. `planWrites` now has a new model branch with real edge cases (ui_only, rules defaults). Consider at least one test. This is a judgement call.
- "Mark setup as done" says it reuses the read-only error that "other Setup writes give". Name the route helper or error code (a one-word reference is enough).
- Say whether the stepper's draft survives a page reload. It looks like no, which is fine. Say so.

## 5. Files-to-touch check

Paths verified as existing: `packages/ui/src/pages/install/install-wizard.tsx`, `review-step.tsx`, `packages/ui/src/lib/use-chat-selection.ts`, `packages/cli/src/install.mjs`, `packages/cli/src/ui/install-routes.mjs`, `docs/install.md`. `emitWorkflow`, `emitConfig`, `validateWorkflow`, `validateConfig`, `headerFor` and `api.createChat` all exist. `path-choice.tsx` and `stages-step.tsx` are new. I did not separately glob `setup-page.tsx`, `api.ts`, `types.ts` or `src/ui/setup.mjs`. `setup-page.tsx` appeared in the grep and `api.ts` also exists (the grep matched `createChat` there). I did not check `types.ts` or `setup.mjs`.

Not listed but implied:
- The `infoBody` change in `install-routes.mjs` (must-fix 1; the file is listed, but the reason is missing).
- Tests that assert the `/api/install/info` shape. The plan mentions these only in prose. Name them: probably `packages/cli/test/ui/*` install-route tests.
- `packages/cli/package.json` and the `known-hashes.json` version bump to 1.3.0. The plan says 1.3.0 is already in progress on this branch, which is fine.
