# Plan rules

<!-- Repo-specific instructions Claude must follow in the "plan" stage. Filled in by /shipline-setup; edit freely. -->

- Write `plan.md` with: the goal, what is in scope and out of scope, the files to touch (each marked create, modify or delete), the behavior and edge cases, the verification steps, and open questions.
- No code in the plan. Describe what changes and why, not how each line looks.
- Build on what the repo already does. Name the existing code, patterns and helpers to reuse, so a second way of doing the same thing isn't introduced.
- Cover error handling, empty states, and what happens to existing data or callers.
- Say whether the work affects the UI, and run `stage.mjs flag ui true|false`.
- Keep the scope to what was asked. Put extra ideas under out of scope or open questions.
- List how each acceptance criterion will be checked, so the verify stage has something to follow.
