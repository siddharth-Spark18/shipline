# Review: docs/plans/shipline-chat-reliability.md

**Reviewer:** plan-reviewer (fresh context), 2026-11-05.

## Verdict

**Ready after must-fixes.** There are 2 small must-fixes. The plan is very detailed and its verified facts are well sourced.

## Must-fix

1. **`pending` and idle detection are undefined.**
   - Scope H says `GET /api/chat/controls` returns `pending: {…} | null`, but never gives the shape of `pending`.
   - It doesn't say where pending changes live (in memory or in `sessions.json`). The edge case where the chat ends before a pending change is sent implies they're persisted.
   - It doesn't say which existing flag decides "idle" versus "running a turn".
   - **Fix:** `chat.pending = { model?, effort?, permissionMode? }`, mirrored to the session entry. Idle means the existing busy flag is false.
2. **The atomic write and the file's mode.**
   - Two private `writeAtomic` functions exist, at `sessions.mjs:23` and `setup.mjs:360`.
   - It's unstated whether `trust.mjs` reuses one of them.
   - Neither keeps the file's mode. Scope D requires keeping the mode of `~/.claude.json`.
   - **Fix:** state how `trust.mjs` keeps the mode.

## Optional

- **Hook wrappers:** the guard denies through JSON with exit 0 (`guard.mjs:21`, `:184`), so `|| true` doesn't disable it. A short note in the plan would help reviewers.
- **SessionStart:** `A && B || echo` could print twice if the script prints output and then exits non-zero. `failOpen` exits 0, so this is only theoretical.
- **Test name clash:** `packages/cli/test/trust.test.mjs` already exists (it tests CI trust). Name the new one `workspace-trust.test.mjs`.
- **Repeated entries:** several files appear twice in Files to Touch ("in addition to the above"). Merge them.
- **The Jira notice:** the plan doesn't say how the UI learns the task's current stage. It presumably uses existing task data.
- **Scope size:** chat controls (scope H) could ship as a separate PR.
- **`sonner`:** check that it's already a UI dependency. It is: `packages/ui/package.json` lists `sonner` ^2.0.8.
