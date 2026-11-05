# Review: docs/plans/shipline-teams-phase1.md

**Reviewer:** plan-reviewer (fresh context), 2026-11-05.

## Verdict

**Ready after must-fixes.** There are 4 must-fixes.

## Must-fix

1. **The `jira`/`ticket` aliasing is under-specified.**
   - Stage ids are compared in more places than `stage.mjs` and `ci-check.mjs`: `guard.mjs:155`, `lib.mjs:446` and `:518`, `stage.mjs` `stageCfg` and the skip/goto paths, and the UI's `tasks.mjs`.
   - Fix: name one helper, list every call site, and say how config keyed by stage id is handled.
2. **Where the hooks read `tracker` and `setup` is unspecified.**
   - `lib.mjs` holds the defaults and `loadConfig`, and isn't in Files to Touch.
   - The plan doesn't say how `session-start.mjs` finds `<store>/state`.
3. **`resolveInsideStore` is private to `tasks.mjs`, and its results aren't mapped.**
   - It returns `{real}`, `{missing:true}` or `null`.
   - The plan doesn't say what `readTask` does with each result, or whether `task_dirs` entries are absolute.
4. **The chat-detail refresh behaviour is unspecified.**
   - Nothing says when the UI refetches `GET /api/chats/<id>`. `bindTask` emits only `kind: 'task'`.
   - The plan doesn't say what replaces `chat-page.tsx`'s `task` and `changes` props.

## Optional

- **`hash-templates.mjs` path:** it's at `packages/cli/scripts/hash-templates.mjs`. The plan should also say where the old stub hashes live.
- **Reuse a fixture:** `test/fixtures/legacy-0.6/.shipline/rules/jira.md` exists. The upgrade tests could reuse it.
- **Answers keyed by stage id:** check that confirmations and answers keyed by stage id survive the rename. The ticket stage is optional and doesn't ask, so the risk is low.
- **Duplicate section:** merge the two "Data" bullets in Surface Area.
- **`TaskPanel`:** only the Tasks page uses it, so state it as a delete.
