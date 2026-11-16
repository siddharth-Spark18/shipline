# Refactor plan rules

<!-- Repo-specific instructions Claude must follow in the Refactor workflow's "Plan" stage. Edit freely. -->

- Write `plan.md` with these headings, each with real text under it (the stage can't finish without them): `## Scope` (the goal, what is in scope and out of scope), `## Files to touch` (each marked create, modify or delete), and `## Behaviour that must not change` (the observable behaviour that must stay exactly the same: public APIs, outputs, UI, data formats, error messages).
- For each item under `## Behaviour that must not change`, say how the verify stage will show it stayed the same (an existing test, a new characterisation test, or a manual check).
- No code in the plan. Describe the new structure and why it is better, not how each line looks.
- Build on what the repo already does. Name the existing code, patterns and helpers to reuse, so a second way of doing the same thing isn't introduced.
- Keep the change behaviour-neutral. If a behaviour change turns out to be needed, stop and list it under out of scope or ask; don't fold it into the refactor.
- Say whether the work affects the UI, and run `stage.mjs flag ui true|false`.
