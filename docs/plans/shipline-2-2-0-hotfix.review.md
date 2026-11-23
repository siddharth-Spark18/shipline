# Re-review: shipline-2-2-0-hotfix.md

## 1. Verdict

**Ready to build.** 0 must-fix items. The 3 earlier must-fixes are closed. A few optional notes remain.

## 2. Paraphrase

**What the plan proposes.** Release 2.2.0 part A fixes five enforcement defects and three small consistency items. (1) At Reproduce, with fail-first on for the workflow, `guard.mjs` lets test-file writes (file tools and Bash) through every `tools:` block. This fixes Bugfix being stuck at Reproduce. (2) `stage.mjs check` and `check --expect-fail` re-fingerprint after the commands run and record the post-run value. They also print a note listing the files the checks changed. (3) A new dependency-free `run-hook.mjs` dynamically imports the named hook. If the import throws or the script crashes, it prints a visible systemMessage and exits 0. Every hook command in `settings-hooks.json` goes through it, with no `|| true`. (4) `upgrade` refuses with exit 1, before writing anything, if any Shipline-owned `.shipline/bin/*` file (except VERSION) is locally edited and `--force` is absent. (5) Bash write targets from `bashWriteTargets` are checked against stage `tools:` blocks as if they were Writes. It also bumps INTERFACE to 2 and the version to 2.2.0. It fixes the Node wording (hooks stay on 18+, CLI/UI are 22+). It makes qa-bug-hunter run `stage.mjs check`, and it adds a docs line on Glob, tests, hashes and a CHANGELOG entry.

**How the existing system works, according to the plan.** Hook scripts are vendored into `.shipline/bin/` and run from `settings.json` as `node ... || true`. `guard.mjs` loops over workflow stages and applies `tools:` blocks only to file tools. `bashWriteTargets` is used only by the rails and protected paths. `stage.mjs check` fingerprints before running the commands. `gateChecks` then compares against a fresh fingerprint, so any file a check writes looks like a code change. `upgrade.mjs` decides per file whether to add, replace or skip (edited) and exits 0 when files are skipped. `failFirstLevel` lives in `stage.mjs` and reads its module-level `cfg`. `TEST_GLOBS` is private in `lib.mjs`. `currentStage(manifest)` in `lib.mjs` returns the first stage that is not done or skipped.

## 3. Must-fix

None. Status of the earlier items:

1. **A4 wrong "same as existing" claim and placement. Closed.** The plan now says this is new behaviour. It places the check in `runUpgrade` right after `planFiles()`, before the preview. It covers exit 1, `--dry-run`, `--all` and `--force`. I confirmed that `plan.skip` is built per file at `upgrade.mjs:100`.
2. **A1 `failFirstLevel` signature and "current stage". Closed.** The plan gives `failFirstLevel(cfg, stageId, wfId)` and names `currentStage(manifest)`. I confirmed that `currentStage` exists at `lib.mjs:525` and returns the first not-done stage. I also confirmed that `failFirstLevel` in `stage.mjs:171` reads the module `cfg`.
3. **A6 Node 18 vs 22 contradiction. Closed.** The plan now decides that hooks stay on 18. It lists the exact text to change and the CLI-only modules. It requires `run-hook.mjs` to run on Node 18.

## 4. Optional (non-blocking)

- **A3, two JSON objects on stdout.** This is still a "verify during build" item with a fallback. Make the fallback (stderr only when output was already emitted) the default, and add a test for it. The current A3 test covers only the import-throws case.
- **A4, edge cases.** The plan doesn't say whether these count as "edited" for the refusal. The first is a bin file listed in `VERSION.excluded`, which never gets replaced and so also leaves a mixed set. The second is a `plan.skip` entry with `removed: true` (`upgrade.mjs:136`) under `.shipline/bin/`. The third is how the refusal sets `report.outcome`. It defaults to failed, so probably fine.
- **A3, edited settings.** If a team has edited the Shipline hook entries in `settings.json`, upgrade skips them. The repo then keeps the old direct hooks and gets no crash warning. Consider one upgrade note.
- **A1, `isTestPath`.** Files to Touch mentions exporting `TEST_GLOBS`/`isTestPath`, but A1 doesn't define the `isTestPath` signature. Reuse the existing `globMatches(g, file)` over `TEST_GLOBS`.
- **A1, call sites.** `failFirstNote` in `stage.mjs:178` also calls `failFirstLevel(stageId, wf)`. Its call sites need updating to the new signature.
- **A5.** State that the Bash-vs-`tools:` check is a separate branch evaluated in addition to the existing `bash:`/`actions:` handling. Then a block with both still works.
- **`MISSING_BEFORE` entry shape.** Point at how the banner consumes it, or give the element shape.
- **A2, `stage.mjs:740`.** This is a branch that sets `manifest.checks` when there are no commands to run. Confirm it needs no change.
- **Files to Touch, verify skill path.** It is now named (`skills/shipline-workflow/SKILL.md`, which exists), with "builder confirms". That is fine.

## 5. Files-to-touch check

- Verified in this pass:
  - `templates/shipline/bin/{lib,stage}.mjs` exist, along with `src/upgrade.mjs`.
  - `templates/claude/skills/shipline-workflow/SKILL.md` exists.
  - The earlier review verified the other modify paths.
- `run-hook.mjs` and `test/run-hook.test.mjs` are correctly marked create.
- `interface.mjs` appears twice in the list (A6 header comment and INTERFACE bump). That is harmless.
- Nothing the plan describes is missing from the list. `scripts/hash-templates.mjs` is run, not edited.
