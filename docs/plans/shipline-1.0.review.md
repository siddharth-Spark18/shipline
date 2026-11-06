# Review: docs/plans/shipline-1.0.md

The plan-reviewer couldn't write this file itself, so its report was saved here.

**Verdict:** ready after 4 must-fixes. All four were fixed in the plan on 2026-11-06.

## Must-fix (all fixed)

1. **`package.json` `files` doesn't ship `CHANGELOG.md`.** `CHANGELOG.md` and `LICENSE` were added to `files`.
2. **Deleting `test/fixtures/legacy-0.6` breaks `uninstall.test.mjs` and `publish.test.mjs`.** Both are now listed and rewritten against a fresh 1.0 init.
3. **The ticket auto-skip was under-specified.** It now runs in `activateNext()`, matched by the stage id `ticket`, with `via` set to `optional` or `auto`. Nothing reads `ticket.md` afterwards.
4. **Edge cases of the credential rule.** Now specified:
   - only non-flag arguments count, checked separately for each sub-command;
   - `cp` and `mv` are safe unless they copy to stdout;
   - `git diff`, `show`, `log -p` and `blame` on a credential path are denied;
   - credential directories count too.

## Optional

**Taken:**
- How the base branch is checked out (base SHA, `fetch-depth: 1`) and how fork PRs behave.
- The retrospective note is committed with the plan.

**Not taken (accepted):**
- The broken-config warning appears on every tool call, which is intended.
- How the `upgrade` refusal for a pre-1.0 repo interacts with a missing `VERSION` file is left unspecified. The existing missing-`VERSION` handling stays.
- `--port` and `--no-open` already exist in `parseUiArgs`. The plan's "adds" just means they're kept under the strict rules.
- `status` without a session in a folder that isn't a git repo: the branch is unknown, so it lists every unfinished task.
