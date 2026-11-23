# Shipline 2.2.0, part A: enforcement hotfix

**Status:** Approved

Part A of the 2026-11-19 audit follow-up (plans A–E; F goes through /ideate later). Branch `release/2-2-0` off `main`.
2.2.0 ships together with Plan D (task lifecycle and escape hatches); this plan is built and committed first, in its
own commit.

## Problem & Goal

Five defects break Shipline's core promise ("stages and rails are enforced, and you can always get through a
workflow"):

1. **Bugfix can't get past Reproduce** (regression from 2.1.0 fail-first). `rules/reproduce.md` asks for a failing
   test and `fail_first: proof` requires one, but the Root cause stage's `tools: Edit|Write|MultiEdit|NotebookEdit`
   block (`templates/shipline/workflows/bugfix.yml`) has no `allow_paths`, so Claude is denied writing the test.
2. **Verify loops forever** when a check command writes a file git doesn't ignore (coverage reports, `tsbuildinfo`,
   `next-env.d.ts`, `eslint --fix`). `stage.mjs check` records the fingerprint *before* the commands run
   (`stage.mjs:747-754`); `gateChecks` (`stage.mjs:932-938`) then always sees "The code changed since the last check
   run".
3. **A crashing hook silently turns enforcement off.** Every hook command in `templates/settings-hooks.json` ends in
   `|| true`, and PreToolUse/UserPromptSubmit/PostToolUse print nothing when node is missing. A syntax error in
   `lib.mjs` (which teams are invited to edit) disables every rail with no message.
4. **Upgrade can leave `.shipline/bin/*` at mixed versions.** `upgrade.mjs:96-101` decides file by file: an edited
   `lib.mjs` is skipped while `guard.mjs`/`stage.mjs` are replaced. If the new scripts need new `lib.mjs` exports, the
   hooks crash (and, today, fail open silently, see 3).
5. **Plan / Root cause gates are bypassed through Bash.** Stage `tools:` blocks only apply to file tools
   (`guard.mjs:278-286`); `cat > src/a.js`, `sed -i`, `cp`, `mv`, `rm` on repo files pass. `bashWriteTargets`
   (`lib.mjs:1746`) already detects these writes but is used only by the rails / protected paths.

Plus three small consistency fixes the user chose to fold in: Node version wording (wrong 18/20 claims for the CLI/UI),
Verify running the test suite twice (qa-bug-hunter agent + `stage.mjs check`), and closing the retro's "Glob not in
the hook matcher" item by documenting why Glob isn't gated.

**Success:** a Bugfix task with `fail_first: proof` goes from Ticket to PR with Claude writing the failing test at
Reproduce; Verify with a coverage-writing test command advances after one `check`; a broken `lib.mjs` produces a
visible warning on every hook call; `upgrade` never writes a mixed bin set; `cat > src/x.js` during Plan is denied
with the same message as an Edit.

## Scope

### In

- A1. Test-file edits allowed at Reproduce when fail-first applies (built into `guard.mjs`).
- A2. `stage.mjs check` re-fingerprints after the run, records the post-run fingerprint, and warns with the files the
  checks changed.
- A3. New `run-hook.mjs` launcher; all hook commands go through it; node-missing message on every hook event.
- A4. `upgrade` treats `.shipline/bin/*` as one unit: refuse (before writing anything) if any is edited, unless
  `--force`.
- A5. Bash write targets checked against stage `tools:` blocks like a Write.
- A6. Correct Node wording (hooks 18+, CLI/UI 22+); qa-bug-hunter runs `stage.mjs check` instead of the commands; docs line on Glob.
- INTERFACE 1 → 2, version 2.2.0, CHANGELOG, known hashes.

### Out (explicitly)

- Everything in plans B–E (task lifecycle, session binding after `/clear`, credentials-rail false positives, scope
  check merge-base, chat, setup UI, store/CLI hygiene). In particular finding "enforcement stops after `/clear`" is
  Plan D, not here.
- Adding Glob to the PreToolUse matcher (decided against: Glob returns names only).
- Detecting writes Bash makes indirectly (`python -c`, `node -e`, `npm run <script>`, editors, build tools). Stays a
  documented limit.
- Per-file upgrade conflict resolution / `.shipline-new` files (Plan E).
- The CI path-filter fix in `.github/workflows/cli.yml`: goes on branch `ci/required-check`, not here.
- Child-process isolation for hooks (decided: in-process).

## Surface Area

- **Layers:** vendored hook scripts (`templates/shipline/bin`), installer/upgrader (`src/`), templates
  (settings-hooks.json, agent, CLAUDE.md section), docs. No UI code changes beyond what INTERFACE 2 already drives
  through existing banners.
- **Data model:** none. The manifest's `checks.fingerprint` keeps its meaning ("the code the checks passed on"), now
  taken after the run. No new manifest fields.
- **Hook contract (INTERFACE 2):** settings.json hook commands change from `node .../guard.mjs` to
  `node .../run-hook.mjs guard` (same for `session-start`, `prompt-submit`, `record-answer`). Hook stdin/stdout
  shapes are unchanged. `HOOK_MARK` (`.shipline/bin/`) still identifies Shipline's entries, so `upgrade`'s existing
  `replace: true` merge swaps old entries for new ones.
- **CLI:** `upgrade` gains a new refusal case; exit code 1 with a message (same as the existing "edited files" path).
  `--force` semantics unchanged (replace all edited files).

## Behaviour & Edge Cases

### A1. Test files at Reproduce

- In `guard.mjs`'s stage loop, before a `tools:` block is evaluated: if the task's **current** stage id is
  `reproduce` **and** `failFirstLevel` for that stage/workflow is not `off` (workflow listed in `fail_first.workflows`,
  level `note|section|proof`), and the target path matches the test-file globs, the block does not hit.
- Test-file globs: the existing `TEST_GLOBS` in `lib.mjs` (move/export it, and reuse it from `sensitiveKind`; one
  list). Matching is case-insensitive like other path globs.
- Applies to every `tools:` block in the workflow (not just root_cause), so custom workflows with a Plan-style block
  before Reproduce behave the same.
- Only the current-stage check: once Reproduce is done (Root cause current), test edits are blocked again until Root
  cause is done, as today.
- `fail_first: off` or a workflow not listed: unchanged behaviour (rules text still says "when practical"; no change to
  `rules/reproduce.md`).
- Also applies to Bash writes (A5): a `cat > test/login.test.js` at Reproduce passes under the same rule.
- `failFirstLevel` currently lives in `stage.mjs` and reads that module's `cfg`. Move it to `lib.mjs` as
  `export function failFirstLevel(cfg, stageId, wfId)` (same logic: `off` unless `cfg.fail_first` is on, `stageId ===
  'reproduce'` and `cfg.fail_first.workflows` includes `wfId`). `stage.mjs` calls it with its loaded `cfg` and `wf.id`.
- In `guard.mjs`, the current stage comes from the existing `currentStage(manifest)` in `lib.mjs` (guard already loads
  the manifest and config); the rule applies when `failFirstLevel(cfg, cur.id, wf.id) !== 'off'`.

### A2. Check runs that write files

- `check` keeps taking the pre-run fingerprint, runs the commands, then takes a second fingerprint.
- If they differ: record the **post-run** fingerprint in `manifest.checks.fingerprint`, and print a warning after the
  results:
  `Note: the checks changed these files: <up to 10 paths, "+N more">. The result is recorded for the code as it is now.
  Add generated files to .gitignore to keep them out of the diff.`
- The changed-file list: `git diff --name-only` between the two trees (`git diff-tree -r --name-only <pre> <post>`).
  If listing fails, print the warning without the list.
- If either fingerprint is null (not a git repo / git failed): behave as today (record whatever the pre-run value
  was).
- `check --expect-fail` (fail-first record at Reproduce) gets the same treatment for `manifest.fail_first.fingerprint`.
- `status --json` / UI staleness logic (`stage.mjs:1044-1046`) needs no change; it compares against the recorded
  value.
- Accepted trade-off (user decision): a check that rewrites tracked source (`eslint --fix`) counts as checked on the
  rewritten code.

### A3. run-hook.mjs launcher

- New file `templates/shipline/bin/run-hook.mjs`, **imports nothing from `lib.mjs`** (only `node:` builtins).
- Usage: `node .shipline/bin/run-hook.mjs <name>` where name ∈ `guard|session-start|prompt-submit|record-answer`
  (allow-list; an unknown name prints a systemMessage and exits 0).
- Behaviour:
  - Installs `uncaughtException` and `unhandledRejection` handlers first, then `await import('./<name>.mjs')`.
  - Any throw during import (e.g. syntax error in `lib.mjs`) or an uncaught error later: write
    `{"systemMessage":"Shipline <name> hook crashed: <first line of the error>. Its checks are off for this call; run
    \`npx @forgeyard/shipline upgrade\` or fix .shipline/bin."}` to stdout, exit 0 (fail open, visibly).
  - If the hook already wrote output before crashing, run-hook must **not** print anything more on stdout: per the
    Claude Code hooks docs (code.claude.com/docs/en/hooks), stdout counts as JSON only when it is exactly one JSON
    object; a second object or trailing text makes the whole output plain text and the hook's decision is lost. In
    that case the crash message goes to stderr only. run-hook tracks whether anything was written by wrapping
    `process.stdout.write` before importing the target.
  - Stdin is not touched by run-hook; the imported script reads it as today.
  - All current hook scripts exit 0 deliberately (checked: `process.exit(0)` only), so no exit-code interpretation
    is needed.
- `templates/settings-hooks.json`: every event uses the same shape as SessionStart today:
  `if command -v node >/dev/null 2>&1; then node "$CLAUDE_PROJECT_DIR/.shipline/bin/run-hook.mjs" <name>; else echo
  '{"systemMessage":"Shipline needs Node.js 18 or newer on this machine; its workflow hooks are off until it'\''s
  installed."}'; fi` — no `|| true`.
- Warning frequency: every affected call (user decision).
- The existing `failOpen()` in `lib.mjs` (handled errors) is unchanged.

### A4. Upgrade: bin scripts as one unit

- This is **new behaviour**: today edited files are only listed as "skipped" and upgrade exits 0. That stays true for
  edited files outside `.shipline/bin/`.
- Where: in `runUpgrade`, immediately after `planFiles()` returns and **before** the preview is printed or anything is
  written. If any path under `.shipline/bin/` (excluding `VERSION`) is in `plan.skip`, and not `--force`, the whole
  upgrade stops, **returns exit code 1**, message:
  `.shipline/bin/ has local edits (<files>). Its scripts must all be the same version, so upgrade won't replace only
  some of them. Save your edits, run \`shipline upgrade --force\`, then re-apply them.` followed by the existing diff
  output for those files.
- `--dry-run` reports the same refusal (exit 1) instead of a mixed plan.
- `--all`: the repo is reported as failed with this reason; other repos continue (same as other per-repo failures).
- `--force`: unchanged (replaces all edited files, bin included).
- Files under `.shipline/bin/` that the team **added** (not Shipline-owned) are ignored by this check.

### A5. Bash writes vs stage blocks

- In `guard.mjs`'s stage loop, for a Bash command: compute `bashWriteTargets(parts, ctx)` once; for each `tools:`
  block whose regex matches `Write`, each repo-relative target is evaluated exactly like a Write to that path
  (allow_paths, `{task_dir}` vars, the A1 test-file rule). Any hit → the block hits.
- Targets outside the repo (absolute) are ignored, as for file tools. `/dev/*` already excluded.
- Deny message: `Shipline (<wf> workflow, task <slug>): writing <path> from Bash needs the "<stage>" stage to be done
  first. ...` (same tail as today).
- `rm`, `mv`, `cp` targets count (user decision). Enforcement mode `warn` produces a warning, `guide` ignores, as for
  file tools.
- Docs state the limit: indirect writes (scripts, interpreters, build tools) aren't detected.

### A6. Small consistency fixes

- Node version (user decision: **hooks stay on Node 18**, as decided in 2.0; only the CLI/UI need 22). Hook scripts,
  their "Node 18+" comments, the `NODE_TOO_OLD_MESSAGE` in lib.mjs and the settings-hooks.json node-missing message keep
  saying 18. `run-hook.mjs` must run on Node 18 (no newer syntax/APIs) and is covered by the `hooks` test subset.
  Fix only the text that is wrong:
  - `templates/claude-md-section.md`: "Requires Node 18+ (Node 20+ for the UI)" → "The hooks need Node 18+; the
    `shipline` CLI and UI need Node 22+".
  - `src/` header comments that say "Node 18+"/"Node 20+" for CLI-only modules (`detect-commands`, `detect-ui`,
    `interface`, `install`, `hashes`, `store`, `setup-schema`, `yaml-emit`, `registry`, `init-prompts`) → "Node 22+".
    Modules imported by the vendored hooks are none of these (they import only `templates/shipline/bin/*`).
  - `src/init.mjs:119-122`: remove the dead `nodeMajor < 20` wizard branch and its comment (bin already exits below 22).
  - `src/init-prompts.mjs:13-14`: the comment/message about Node 20.17 → state the CLI needs Node 22.
- `templates/claude/agents/qa-bug-hunter.md` step 3: "Run `node .shipline/bin/stage.mjs check` (never the commands
  directly, never invent commands) and use its output as evidence." Check the verify skill text doesn't also tell
  the main session to run `check` a second time after the agent; if it does, keep one (the agent's).
- `docs/guardrails.md`: one line: "Glob isn't gated: it lists file names, never their contents."

### Errors / empty states

- run-hook with a missing target file (e.g. partial upgrade removed it): crash message as above.
- Upgrade refusal leaves the repo untouched (verified by test).

## Constraints

- Hook scripts stay dependency-free and run on Node 18+ (the CLI/UI need 22+ per engines), and must work on Windows (Git Bash runs the hook commands;
  the `if command -v` shape already does today for SessionStart).
- Hook latency must not grow measurably (in-process import, no child process).
- Fail open on Shipline's own bugs (never block a developer because Shipline crashed), but always visibly.
- Vendored-file rules: every edited template needs `scripts/hash-templates.mjs` run for 2.2.0 and `known-hashes.json`
  updated; INTERFACE bump means `MISSING_BEFORE` gets its first entry.
- Plan D lands on the same branch afterwards; keep A in its own commit.

## Files to Touch

- `packages/cli/templates/shipline/bin/run-hook.mjs` — **create**: the launcher (A3).
- `packages/cli/templates/settings-hooks.json` — **modify**: all four events via run-hook, no `|| true`, Node 18 node-missing message on every event.
- `packages/cli/templates/shipline/bin/guard.mjs` — **modify**: A1 test-file rule in the stage loop; A5 Bash write
  targets checked against `tools:` blocks; Bash-specific deny wording.
- `packages/cli/templates/shipline/bin/lib.mjs` — **modify**: export `TEST_GLOBS`/`isTestPath`, move `failFirstLevel`
  here as `failFirstLevel(cfg, stageId, wfId)`; header comment unchanged (Node 18+).
- `packages/cli/templates/shipline/bin/stage.mjs` — **modify**: import `failFirstLevel` from lib; `check` and
  `check --expect-fail` post-run fingerprint + changed-files warning.
- `packages/cli/templates/claude-md-section.md` — **modify**: "hooks need Node 18+; CLI and UI need Node 22+".
- `packages/cli/templates/claude/agents/qa-bug-hunter.md` — **modify**: run `stage.mjs check`, not the commands.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` (verify instructions; builder confirms the path) — **modify only if** it duplicates the check run.
- `packages/cli/src/{init,init-prompts,detect-commands,detect-ui,interface,install,hashes,store,setup-schema,yaml-emit,registry}.mjs` — **modify**: Node wording in header comments; remove init's dead Node<20 branch (A6).
- `packages/cli/src/upgrade.mjs` — **modify**: bin-as-a-unit refusal in `planFiles`/caller, dry-run and `--all`
  reporting.
- `packages/cli/src/interface.mjs` — **modify**: `INTERFACE = 2`, `MISSING_BEFORE` entry ("hook crash warnings and
  Bash write blocking").
- `packages/cli/src/known-hashes.json` — **modify**: regenerated for 2.2.0.
- `packages/cli/package.json` — **modify**: version 2.2.0.
- `packages/cli/CHANGELOG.md` — **modify**: 2.2.0 entry (Fixed: Bugfix Reproduce, Verify loop, mixed upgrade, silent
  hook failure, Bash bypass; Changed: INTERFACE 2, Node wording fixes, qa-bug-hunter). Plan D adds to the same entry.
- `docs/guardrails.md` — **modify**: Bash writes now count against stage blocks + limits; Glob line; hook crash
  behaviour.
- `docs/usage.md` — **modify**: fail-first at Reproduce lets test files through; Verify note on checks that write files.
- `docs/install.md` — **modify**: upgrade refusal for edited bin scripts (Node requirements text already correct).
- `docs/troubleshooting.md` — **modify**: "Shipline <hook> hook crashed" entry and the upgrade refusal.
- `packages/cli/test/guard-actions.test.mjs` or `stage-gate.test.mjs` — **modify**: A1 and A5 cases.
- `packages/cli/test/stage-check.test.mjs` — **modify**: A2 cases.
- `packages/cli/test/run-hook.test.mjs` — **create**: A3 cases.
- `packages/cli/test/upgrade.test.mjs` — **modify**: A4 cases; INTERFACE 2 expectations.
- `packages/cli/test/{init-version,cli,publish}.test.mjs`, `test/ui/*.test.mjs` — **modify** only where they assert
  version 2.1.0 / INTERFACE 1 / the old hook command strings.

## Verification

New `node:test` cases (user choice), then the existing full suite (`pnpm test`):

- **A1:** bugfix task, current stage reproduce, `fail_first` proof on bugfix → Write `test/login.test.js` allowed,
  Write `src/login.js` denied; same with `fail_first: off` → test write denied; at root_cause current → test write
  denied; Bash `cat > test/x.test.js` at reproduce allowed.
- **A2:** test command `date > coverage.txt && exit 0` → `check` prints the changed-files note, then `advance` does not
  report "code changed"; editing a source file after `check` still reports it. Same for `--expect-fail`.
- **A3:** run-hook with a target that throws on import → stdout is a single systemMessage JSON, exit 0; with an
  unknown name → systemMessage; normal guard deny passes through unchanged; settings template has no `|| true`.
- **A4:** repo with edited `.shipline/bin/lib.mjs` → `upgrade --yes` exits 1, no file changed; `--dry-run` reports the
  refusal; `--force` replaces all; `--all` marks that repo failed and continues.
- **A5:** during Plan, `cat > src/a.js`, `sed -i s/a/b/ src/a.js`, `rm src/a.js`, `cp x src/a.js` denied; `echo hi >
  /tmp/x` allowed; target in `allow_paths` (docs workflow `docs/**`) allowed; enforcement `warn` → warning not deny.

## Open Questions

- ~~Two JSON objects on stdout (A3)~~: resolved from the hooks docs, see A3 (stderr only once output was written).
- **Verify skill duplication (A6):** depends on what the current verify skill text says; builder checks and edits only
  if it double-runs.
- Branch name `release/2-2-0` vs the earlier `fix/2-1-1`: settled on `release/2-2-0`.
- **Accepted optional review notes** (see `shipline-2-2-0-hotfix.review.md`, re-review ready-to-build, 0 must-fix):
  the A3 two-JSON default, A4 excluded/removed bin edge cases, the warning when an edited settings.json keeps the old
  hook commands, A5 deny wording, the `MISSING_BEFORE` entry shape, and `failFirstNote` call sites. The builder
  reads the report and handles them in line with this plan; none changes a decision above.
