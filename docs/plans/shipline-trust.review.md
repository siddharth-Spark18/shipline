# Re-review: shipline-trust.md

## 1. Verdict

**Ready to build.** 0 must-fix items. All 3 earlier must-fixes are closed.

## 2. Paraphrase

**What the plan proposes.** Remove the `--confirmed` and `--force` flags from `stage.mjs`. When a `confirm_to_advance` stage is advanced, or a non-optional stage is skipped, `stage.mjs` writes a `pending_confirm` record (stage, kind, exact question text, `issued_at`) into the session state. It then refuses and prints the exact AskUserQuestion to ask. A new PostToolUse hook on `AskUserQuestion` (`record-answer.mjs`) reads the developer's answers. For any question whose text exactly matches the pending one, it appends a line to `approvals/<safeId(session)>.jsonl`. On the next `advance` or `skip`, `stage.mjs` accepts an unused approval with the right kind, task and stage and the answer "Advance" or "Skip", provided it is newer than `issued_at`. It marks the approval used, stamps `confirmed` or `skipped` with `via: 'answer'` on the manifest, and moves on. The guard denies edits and Bash commands that touch the store's state, approvals or manifests, run the recorder, or pass the old flags, and does so before the "no task" early exits. A new `pr-summary` command prints a markdown table plus a hidden JSON block. An optional `ci-check.mjs` and a GitHub workflow fail PRs with a missing block (per `ci.missing_block`), an unfinished `block` stage, or a confirm stage not confirmed by answer. After Stop on POSIX, the server checks whether the chat's process group still has members, tells the UI, and a "Kill them" button calls `POST /api/chats/<id>/kill`. The release is INTERFACE 4 and version 0.8.0.

**How the existing system works, according to the plan.** Hook scripts are vendored into `.shipline/bin`. State lives in a per-user store (`~/.shipline`) as `state/<session>.json` and `tasks/<slug>/manifest.json`. The guard blocks source edits while a stage is open and exits early when there is no task. `stage.mjs` takes its session id from `$SHIPLINE_SESSION` (written by SessionStart) or `--session`. The browser chat sets the same variable. Stage completion is currently self-reported through flags. `init`, `upgrade` and `uninstall` track files by hash in `VERSION.files` and `hashes.mjs`. Setup has a diff-and-confirm save pipeline. The browser chat spawns `claude` as a detached process group on POSIX. Windows already kills the whole tree.

## 3. Earlier must-fix items

1. Unverified `answers` field and the missing relay fallback: **closed.** The plan records the field names (`tool_response.answers`, falling back to `tool_input.answers`) and evidence. The terminal check is explicitly left in Verification 2, and the failure behaviour is stated (visible `systemMessage`).
2. Session identity: **closed.** The plan names `safeId(session_id)` on both sides and `$SHIPLINE_SESSION` or `--session` for `stage.mjs`. The code confirms that `session-start.mjs` exports `SHIPLINE_SESSION` and `chat.mjs` sets it.
3. Freshness and overwrite rules: **closed.** `at > issued_at`, `issued_at` kept on re-run, cleared on use or stage change, and "Not yet" never counts.

## 4. Must-fix

None.

## 5. Optional (non-blocking)

- **The `Edit(~/.shipline/**)` allow rule** is still in `packages/cli/templates/settings-hooks.json` (line 3). The plan relies on the guard hook's deny beating the allow rule but doesn't say so. Add one line stating that, or drop the Edit allow. Confirm in the Verification run that the deny wins.
- **CI reads `config.yml` and the workflow YAML from the PR's own checkout.** A PR can lower `enforcement` or set `missing_block: warn`. Note this as an accepted gap, or read from the base ref.
- **Uninstall wording is inconsistent.** Surface Area says remove "only if its hash matches". Files to Touch says remove "if it's recorded in `VERSION.files`". Pick one.
- **Date.** The plan says the field check was done "2026-11-05", but today is 2026-11-04. This is probably a typo.
- **`skip` reason:** the plan doesn't say where `skipped.reason` comes from. It is probably an existing argument.
- **Process group after exit:** the plan doesn't say that `pgid` is kept after `claude` exits. `chat.mjs` already spawns it detached on POSIX. It also doesn't cover PID reuse.
- **Non-interactive opt-in:** state that no flag installs the CI workflow without prompting. This is probably intended.
- **`-p` auto-answers:** say whether an auto-answered AskUserQuestion could produce "Advance" with no human.
- **`POST /api/setup/ci` `baseHashes` and `workflowHash`:** they are only "like `/api/setup/agents`". This is fine if the shape is truly the same.

## 6. Files-to-touch check

- Existing paths checked: `settings-hooks.json`, `guard.mjs`, `stage.mjs`, `pr.md`, the roadmap doc, and `chat.mjs` and `session-start.mjs` (seen in the grep). All exist. Earlier review verified the other modify paths.
- The create targets are new as expected. `templates/github/` doesn't exist yet, so the template-copy and hash inventory code must handle a new directory.
- Nothing the plan describes is missing from the list. `session-start.mjs` needs no change.
