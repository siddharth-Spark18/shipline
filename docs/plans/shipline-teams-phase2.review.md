# Review: docs/plans/shipline-teams-phase2.md

**Reviewer:** plan-reviewer (fresh context), 2026-11-05.

## Verdict

**Ready after must-fixes.** There are 3 must-fixes, all small clarifications.

## Must-fix

1. **Where `ci-check` learns about a `checks: true` stage.** The plan never says where `ci-check` gets the workflow.
2. **The `accept-failures` question and `record-answer.mjs`.**
   - The question text is dynamic, and the plan doesn't say how the pending question is keyed, ordered against `confirm_to_advance`, or consumed.
   - The `record-answer.mjs` change is listed as "only if needed".
3. **The section helper's name and error contract.**
   - Surface Area calls it `requiredSectionProblems`, and Files to Touch calls it `sectionProblems`.
   - The message format is given only by example.

## Optional

- **`--task` flag:** confirm it's the same flag the other stage commands use. It is: `flags.task` in `stage.mjs`.
- **The temp index location:** an absolute path in the OS temp folder, which matters on Windows.
- **CI needs a checkout** for `HEAD^{tree}`. The template change already provides it.
- **Editing tracked `.shipline/` files after `check` makes the run stale.** Say so in the plan.
- **Where the UI's `stale` cache lives:** in the server process or in `tasks.mjs` module state.
- **Scope:** the plan could ship as two PRs.
- **`accepted_failures` after a rerun:** say whether it's cleared when `check` runs again.
