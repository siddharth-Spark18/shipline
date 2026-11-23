# Review: shipline-2-2-0-dev-loop.md

## 1. Verdict

Ready after must-fixes (3 must-fix items, all short).

## 2. Paraphrase

**What the plan proposes.** Plan D (13 items, D1 to D13, plus UI) adds a task lifecycle and fewer false positives on top of Plan A's hotfix, in a second commit on `release/2-2-0`. At SessionStart the hook auto-binds a new session to the single open task on the current branch, so `/clear` doesn't lose enforcement. New `stage.mjs` commands cover abandon, side pass (30-minute exemption from stage blocks for named files), explain (last deny or ask) and `status --all`. Ownership tracking warns when two live sessions share a task. Session start becomes quieter by collapsing stale tasks. A headless policy lets `checks_pass` auto-approve `confirm_to_advance` when `SHIPLINE_NONINTERACTIVE=1`. The credentials rail, scope check (merge-base), commit-command list and worktree root detection are loosened or fixed. Small change drops its subagents. The UI shows abandoned and owner state and gets two config fields.

**How the existing system works, per the plan.** Each task lives in a per-repo store at `~/.shipline/projects/<key>/` with a manifest. A session is bound to a task through `state/<session>.json`. The guard hook enforces stage `tools:` blocks and rails, and denies or asks. `stage.mjs` handles the lifecycle, and confirm questions are answered through a recorded developer answer (`CONFIRM_OPTIONS`, `record-answer`). `listOpenTasks` exists in both `lib.mjs` and `src/ui/tasks.mjs`. Plan A (assumed done) adds the `run-hook` launcher, `failFirstLevel` in lib, exported `TEST_GLOBS` and Bash-write checks against stage blocks.

## 3. Must-fix

1. **D8, "ask" outcomes in headless mode are undefined for the guard.** The plan only covers stage.mjs confirm questions. Under `SHIPLINE_NONINTERACTIVE=1`, guard "ask" decisions (the new D9 ask tiers: `source .env`, `--env-file`, `.env.development`) have no defined behaviour. They could hang, auto-allow or deny. The builder has to choose. Fix: state that in headless mode guard "ask" becomes "deny" (never auto-allow), or say explicitly that it is unchanged.

2. **D1/D2/D3, how "branch" is determined and what `task.branch` holds are not stated.** D1 needs "the current branch is known" and `task.branch === branch`. The plan doesn't say how the hook gets the branch (git call, which command), what happens in detached HEAD, or whether `task.branch` is set for tasks started before a branch exists (`start` suggests a branch). It also doesn't say whether this is an extra git call beyond the one budgeted in Constraints. Fix: name the existing lib helper if there is one (or specify `git rev-parse --abbrev-ref HEAD`), say detached HEAD means no bind, and say tasks without `task.branch` never auto-bind.

3. **D2/D5, the confirm-then-rerun flow for `abandon`/`side` is described only as "exactly like `skip`".** That is fine for the shape. But `side`'s answer must be tied to the specific files and reason. Otherwise an answer recorded for one file list could authorize a rerun with a different list. The plan doesn't say what the recorded answer is matched on. Same for `abandon --task <dir>` (a different task than the one asked about). Fix: say the answer is keyed on kind plus a hash of the arguments (files and reason, or the task dir), or state how `skip` already does it and that these reuse it unchanged.

## 4. Optional (non-blocking)

- D12, if `git rev-parse --show-toplevel` of `cwd` has `.shipline/config.yml`, but it is a nested repo or submodule, the root silently changes. Probably fine, but one line would help.
- D5, a side pass is stored in the session binding file. A session without a task binding can't have one. Say whether `side` requires a bound task (the Problem text implies yes).
- D10, "falls back to the next default name": for example main then master then `task.base_commit`. The order isn't specified, though `defaultBranches(root)` likely defines it.
- D9, the credential name stems list ends with "…". The builder will pick the stems. Point it at the existing stem list in `lib.mjs`.
- D9, `env $(cat <f> ...)`, `export $(cat <f>)` and `printenv` pipelines are regex-heavy. Test examples exist, which is enough.
- D4, "age" uses manifest stage `updated` times. Confirm that field exists in the manifest (not checked).
- Plan statuses and review links are fine. The headless `approved_by: 'non_interactive'` field is a new manifest field missing from the Data model list (add it next to `abandoned` and `side_passes`).
- Open Questions: `/clear` session id behaviour is handled both ways, good.

## 5. Files-to-touch check

- All named existing paths were found: bin scripts (`lib`, `guard`, `stage`, `session-start`, `record-answer`), `workflows/small.yml`, the SKILL.md, `src/setup-schema`, `yaml-emit`, `interface`, `ui/tasks`, `ui/projects`, UI `types.ts`, `task-panel.tsx` and `config-form.tsx` (`TOP_KEYS` at line 19).
- `listOpenTasks` exists in both `lib.mjs:532` and `src/ui/tasks.mjs:109`, as the plan says. `isAgentConfigPath` is in `guard.mjs:99` (a const, not lib), matching the plan's file list.
- `prompt-submit.mjs` exists, and D6 says the prompt hook should treat the next request as new after unbind. The plan doesn't list it. Probably no change is needed, but confirm, or list it as "modify only if".
- I did not check the existence of the docs, tests, CHANGELOG, `known-hashes.json` or `config.yml` template. Several of those are Plan A's, to be created or modified.
- `scripts/hash-templates.mjs` run is implied by "known-hashes regenerate" and is fine.
