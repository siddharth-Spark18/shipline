# Trust: confirmations Claude can't fake, a PR gate in CI, and leftover processes

**Status:** Approved
**Roadmap:** `docs/plans/shipline-adoption-roadmap.md`, Phase 4. This is the second of the remaining plans. After it come *Chat input* (slash commands, images, `!` commands) and *Chat reliability*.
**Branch:** a new branch from `main` once `feat/cleanup-rollout` is merged, for example `feat/trust`.

## Problem & Goal

Shipline's pitch is guardrails. Today the guard really does block source edits while a stage is open, but **whether a stage counts as finished is self-reported**:
- **Self-confirmation:** `stage.mjs advance --confirmed` (for a `confirm_to_advance` stage) and `skip --force` (for a non-optional stage) are flags that Claude passes itself, so "ask the developer first" is only an instruction.
- **Direct edits:** the `Edit(~/.shipline/**)` allow rule lets Claude edit `manifest.json` and state files directly.
- **No PR evidence:** nothing in a pull request shows which stages ran or how they were confirmed.
- **Leftover processes:** stopping a browser chat can leave a process Claude started running in the background.

**Goals:**
1. **Real confirmation.** Passing a `confirm_to_advance` stage, or skipping a non-optional stage, needs the developer's own answer to a fixed question. This works in every surface: the terminal, IDE extensions and the browser chat.
2. **No way around it.** Claude can't fake the answer, change progress files by hand, or call the recorder itself.
3. **An optional CI gate.** It fails a PR whose Shipline summary is missing (the behaviour is configurable) or shows a `block` stage that isn't done.
4. **Visible leftovers.** After Stop, any processes still running are shown, with a button to kill them.

**Done when** (author's criteria):
- **Claude can't confirm by itself.** In a real session, Claude can't pass a confirm stage without the developer answering the fixed question. Editing the manifest or state files, or running the recorder, is blocked.
- **The terminal works too.** The same confirmation works in plain `claude` in a terminal, through the PostToolUse hook.
- **The CI gate works on a real PR.** A test PR fails without the block, as configured, and passes with it.
- **The leftover-process button works.** Stopping a chat while a process is still running shows "Kill them", and it works.

## Scope

### In

**A. Recording answers (a new PostToolUse hook)**
- **The hook:** `.shipline/bin/record-answer.mjs` runs on `PostToolUse` with matcher `AskUserQuestion`.
  - It reads the hook input: `session_id`, `tool_use_id`, `tool_input.questions`, and the developer's answers from `tool_response.answers`, falling back to `tool_input.answers`. Both are a map from question text to the chosen label, for example `{ "Advance past \"plan\" in task x?": "Advance" }`. This was confirmed on 2026-11-04 in a real `claude -p` run (`claude` 2.1.317).
  - For each question whose text **exactly** matches a confirmation question that `stage.mjs` has issued for this session, it appends a line to `approvals/<session>.jsonl` in the store:

    ```
    { task_dir, stage, kind: 'advance'|'skip', answer, at, tool_use_id }
    ```

  - Every other question is ignored.
- **Where the questions come from:** when `stage.mjs` needs a confirmation, it writes the exact question it printed into `state/<session>.json` under `pending_confirm`:

  ```
  { stage, kind, question, issued_at }
  ```

  The recorder only accepts that exact text.
- **The question text:**
  - for advancing: header `Shipline`, question `Advance past "<stage>" in task <slug>?`, options `Advance` and `Not yet`;
  - for skipping: question `Skip "<stage>" in task <slug>?`, options `Skip` and `Don't skip`.

**B. `stage.mjs` changes**
- **Matching sessions:**
  - The recorder and `stage.mjs` both key approvals by `safeId(session_id)`: `approvals/<safeId>.jsonl`, the same rule as `statePath`.
  - The hook gets `session_id` in its input. `stage.mjs` gets it from `$SHIPLINE_SESSION`, which the SessionStart hook writes from the same `session_id` and which the browser chat sets to the same UUID, or from `--session`.
  - With no session, `advance` on a confirm stage and `skip` on a non-optional stage are refused: "no session id; confirmations need the session that asked the question".
  - Accepted gap: Claude could pass `--session <other id>` and use another session's unused approval. That still needs a real "Advance" answer from the developer.
- **`--confirmed` and `--force` are removed.** Passing either prints an error explaining the new flow.
- **`advance` on a `confirm_to_advance` stage:**
  - **Without a valid approval:** it exits non-zero and prints the exact AskUserQuestion to ask, recording `pending_confirm`.
  - **A valid approval:** one from `approvals/<session>.jsonl` with:
    - `kind: 'advance'`, the same `task_dir` and `stage`, and `answer === 'Advance'`;
    - question text exactly equal to `pending_confirm.question`;
    - `at` later than `pending_confirm.issued_at`, so answers given before this question was issued never count;
    - not yet used.
  - **Re-running `advance`** while a `pending_confirm` for the same stage and kind exists keeps the original `issued_at` and prints the same question again, so an answer already given stays valid.
  - **Clearing `pending_confirm`:** it's cleared when an approval is used, and whenever the current stage changes (advance, skip or `reopen`).
  - **"Not yet" or "Don't skip"** is recorded, but never counts. `pending_confirm` stays, so Claude can ask again later.
  - **With one:** it uses it up (marks it used in the file), records `confirmed: { via: 'answer', at }` on the manifest stage, and advances.
- **Missing artifacts:** `advance` on a stage with an `artifact` requires the file to exist. There's no override any more.
- **`skip` on a non-optional stage:** the same flow with `kind: 'skip'` and the answer `Skip`. The manifest records `skipped: { via: 'answer', at, reason }`.
- **Optional and conditional stages** skip as they do today, with no question.
- **New `stage.mjs pr-summary` command:** prints the PR block (see C) for the session's task.

**C. The PR summary block and the CI gate**
- **What `stage.mjs pr-summary` prints:** a visible markdown section followed by the hidden data the check reads.

  ```
  ### Shipline
  | Stage | Status | Confirmed |
  | ... one row per stage: done / skipped / pending, and "your answer" / "auto" / "—" |
  <!-- shipline:summary {"v":1,"workflow":"feature","task":"<slug>","stages":[{"id":"plan","status":"done","enforcement":"block","confirmed":"answer"}, ...]} -->
  ```

- **The `pr` rules:** `templates/shipline/rules/pr.md` and the workflow skill tell Claude to paste the output into the PR description unchanged.
- **The check script** is `.shipline/bin/ci-check.mjs` (no dependencies, Node 18). It reads `GITHUB_EVENT_PATH` to get `pull_request.body` and the label names, reads `.shipline/config.yml` and `.shipline/workflows/<workflow>.yml` from the checked-out repo, and then:
  - **No block:** follows `ci.missing_block`:
    - `fail-unless-label` (the default) fails unless the PR has the label named by `ci.skip_label` (default `shipline:skip`);
    - `warn` passes with a `::warning::` annotation;
    - `fail` always fails.
  - **A block is present:**
    - fail if the JSON doesn't parse, or the `workflow` doesn't exist;
    - fail if any stage whose **current** workflow config has `enforcement: block` isn't `done`;
    - fail if any `confirm_to_advance` stage is marked done without `confirmed: "answer"`;
    - otherwise pass, and print the table to the job summary (`$GITHUB_STEP_SUMMARY`).
- **The workflow file:** `.github/workflows/shipline.yml`, from the template `templates/github/shipline.yml`. It runs on `pull_request` (opened, edited, synchronize, labeled, unlabeled): checkout, then `node .shipline/bin/ci-check.mjs`. GitHub's preinstalled Node is enough.
- **Opting in:**
  - interactive `init` asks "Add a Shipline CI check for pull requests?" (default No). `--yes` leaves it out;
  - Setup gets a "CI check" section that adds or removes `.github/workflows/shipline.yml` and edits `ci.missing_block` and `ci.skip_label`, through the usual diff-and-confirm save.

**D. Blocking the ways around it (the guard)**
- **When the guard checks:** these checks run for **every** session, with or without a task, **before** the existing "no task means allowed" exits.
- **File writes into the store are denied:** Edit, Write, MultiEdit and NotebookEdit on any path inside this repo's store under `state/`, `approvals/` or `tasks/*/manifest.json`. Task artifacts (other files in `tasks/<slug>/`) stay writable.
- **Bash commands are denied when the command text:**
  - contains this repo's store path (or `~/.shipline`, or `$SHIPLINE_HOME`) **and** one of `approvals`, `manifest.json` or `/state/`; or
  - runs `record-answer.mjs`; or
  - passes `--confirmed` or `--force` to `stage.mjs`.
- **The deny message:** "Shipline: progress and approvals can only change through `stage.mjs` and your answers to its questions."
- **Accepted gap:** a determined script could still hide the path, for example by building it from pieces. The guard catches direct attempts, and the CI gate catches PRs whose summary doesn't match the workflow.

**E. Leftover processes after Stop (POSIX)**
- **After Stop:**
  - once `claude` has exited, the server checks whether the chat's process group still has members (`process.kill(-pgid, 0)` succeeds);
  - if it does, it sends an SSE `chat` event `{ chatId, kind: 'orphans', pgid }`, and the UI shows a notice: "Processes started in this chat are still running." with a **Kill them** button;
  - the button calls `POST /api/chats/<id>/kill`, which sends SIGKILL to the group and returns `{ killed: true }`, or 404 when there's nothing left;
  - after a kill, or when the group is found empty, the notice goes away (an SSE `chat` event `{ kind: 'orphans-cleared' }`).
- **Windows:** no change. The cleanup plan's `taskkill /T` already kills the whole tree.

**F. Versioning**
- `INTERFACE` becomes 4, because the hooks, the `stage.mjs` flags and the `VERSION`-tracked templates change.
- `upgrade` brings `record-answer.mjs`, the new PostToolUse hook entry, `ci-check.mjs` and the updated templates to existing repos.
- **A task that is in progress during the upgrade** keeps its stages. The new rules apply to the next `advance`.
- The package version becomes 0.8.0.

### Out

- **The chat input features** (slash commands, images, `!` commands): the next plan.
- **Chat reliability** (the chat test, the `UNVERIFIED` items, Jira in `-p`, the Node preflight, the doubled usage-limit message): the plan after that.
- **Cryptographic signing** of the PR block. It can be edited by hand, and that's accepted.
- **A server-side record** of approvals. Approvals stay local, in the store.
- **Automatically killing leftover processes.** The developer decides, using the button.

## Surface Area

- **Vendored hooks and scripts:** `record-answer.mjs` (new), `ci-check.mjs` (new), `guard.mjs`, `stage.mjs`, `lib.mjs`.
- **Templates:** `settings-hooks.json` (the PostToolUse entry), `templates/github/shipline.yml` (new), `config.yml` (`ci:`), `rules/pr.md`, and the skills and `CLAUDE.md` wording.
- **CLI:** `init` (the CI prompt and installing the workflow file), `upgrade` (new files; `INTERFACE` 4), `uninstall` (removes `.github/workflows/shipline.yml` only if its hash matches what Shipline wrote), `hashes.mjs` (inventory), `interface.mjs`.
- **UI server:** `chat.mjs` (leftover-process detection), `chat-routes.mjs` (`POST /api/chats/<id>/kill`), `setup.mjs` (the CI section: GET shape and a save route).
- **Browser UI:** the leftover-processes notice and button, and the Setup CI section.

### Data (in the store)

- **`approvals/<session>.jsonl`:** one line per recorded answer. A used approval gets `"used_at"` (the file is rewritten atomically).
- **`state/<session>.json`:** gains `pending_confirm: { stage, kind, question, issued_at } | null`.
- **Manifest stages:** gain `confirmed?: { via: 'answer', at }` and `skipped?: { via: 'answer' | 'optional', at, reason }`.

### API

- **`POST /api/chats/<id>/kill`:** 200 `{ killed: true }`, or 404 `not-found` when no group remains.
- **New SSE `chat` event kinds:** `orphans` and `orphans-cleared`.
- **`GET /api/setup`:** gains `ci: { installed: boolean, missing_block, skip_label, workflowHash }`.
- **`POST /api/setup/ci`:** `?preview=1` behaves like `/api/setup/agents`.
  - The request is `{ install: boolean, missing_block, skip_label, baseHashes }`.
  - It writes or deletes `.github/workflows/shipline.yml` and saves `config.yml`'s `ci:` through the existing save pipeline.

### Config (`config.yml`)

```
ci:
  missing_block: fail-unless-label   # fail-unless-label | warn | fail
  skip_label: shipline:skip
```

`setup-schema.mjs` validates both keys. The `ci:` section is optional, and when it's absent the defaults above apply.

## Files to Touch

### Vendored scripts and templates

- `packages/cli/templates/shipline/bin/record-answer.mjs` (**create**):
  - the PostToolUse recorder from scope A;
  - fails open (exit 0, plus a visible `systemMessage` on a store write error);
  - never prints the answers anywhere except the approvals file.
- `packages/cli/templates/shipline/bin/ci-check.mjs` (**create**): the CI gate from scope C. Its exit code is 0 or 1, and it writes annotations and the step summary.
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**):
  - remove `--confirmed` and `--force`;
  - add the approval check and consumption, the `pending_confirm` write and the printed question;
  - artifacts are required;
  - the new `pr-summary` command;
  - manifest `confirmed` and `skipped` fields.
- `packages/cli/templates/shipline/bin/guard.mjs` (**modify**): the store write and Bash checks from scope D, run before the no-task early exits. The existing stage blocks are unchanged.
- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**):
  - `approvalsPath(root, session)`;
  - `readApprovals` and `consumeApproval`;
  - `confirmQuestion(stage, kind, slug)`, the single source of the exact question text;
  - `loadConfig` defaults for `ci`.
- `packages/cli/templates/settings-hooks.json` (**modify**): add `PostToolUse` with matcher `AskUserQuestion`, running `node "$CLAUDE_PROJECT_DIR/.shipline/bin/record-answer.mjs"`.
- `packages/cli/templates/github/shipline.yml` (**create**): the CI workflow template.
- `packages/cli/templates/shipline/config.yml` (**modify**): add the commented `ci:` section with its defaults.
- `packages/cli/templates/shipline/rules/pr.md` (**modify**): "Run `node .shipline/bin/stage.mjs pr-summary` and paste its output unchanged at the end of the PR description."
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` and `packages/cli/templates/claude-md-section.md` (**modify**):
  - confirmations work only through the printed AskUserQuestion;
  - never pass `--confirmed` or `--force`;
  - never edit progress files.

### CLI

- `packages/cli/src/init.mjs` and `packages/cli/src/init-prompts.mjs` (**modify**):
  - the opt-in CI prompt (default No; left out with `--yes`);
  - on yes, write `.github/workflows/shipline.yml` and record its hash in `VERSION.files`.
- `packages/cli/src/hashes.mjs` (**modify**): add `record-answer.mjs`, `ci-check.mjs` and the optional `.github/workflows/shipline.yml` to the template inventory, plus the PostToolUse entry in the settings part.
- `packages/cli/src/upgrade.mjs` (**modify**):
  - update `.github/workflows/shipline.yml` only if it's present and unedited;
  - never add it on an upgrade.
- `packages/cli/src/uninstall.mjs` (**modify**): remove `.github/workflows/shipline.yml` if it's recorded in `VERSION.files`.
- `packages/cli/src/interface.mjs` (**modify**): `INTERFACE = 4`, with `MISSING_BEFORE` gaining "Trust: answer-based confirmations and the CI check".
- `packages/cli/src/setup-schema.mjs` (**modify**): `ci.missing_block` (an enum) and `ci.skip_label` (non-empty, at most 50 characters).
- `packages/cli/package.json` (**modify**): version 0.8.0.
- `packages/cli/src/known-hashes.json` (**modify**): re-run `packages/cli/scripts/hash-templates.mjs` for 0.8.0.

### UI server and browser UI

- `packages/cli/src/ui/chat.mjs` (**modify**):
  - after a Stop-initiated exit on POSIX, check the group and emit `orphans`;
  - add `killOrphans(chatId)`;
  - emit `orphans-cleared` when the group is empty.
- `packages/cli/src/ui/chat-routes.mjs` (**modify**): add `POST /api/chats/<id>/kill`.
- `packages/cli/src/ui/setup.mjs` (**modify**): add the `ci` shape to `GET /api/setup`, and `POST /api/setup/ci` with preview and apply.
- `packages/ui/src/lib/types.ts` and `packages/ui/src/lib/api.ts` (**modify**): the chat event kinds, `killChat`, and the CI setup types and calls.
- `packages/ui/src/pages/chat/notices.tsx` and `packages/ui/src/pages/chat/chat-page.tsx` (**modify**): the leftover-processes notice with a **Kill them** button.
- `packages/ui/src/pages/setup/ci-check.tsx` (**create**) and `packages/ui/src/pages/setup/setup-page.tsx` (**modify**): a CI check section in the Setup navigation, with the install switch, the missing-block select and the skip-label input, saved through a preview.

### Tests (written separately, but listed here)

- `packages/cli/test/trust.test.mjs` (**create**):
  - **The recorder:** records only exact questions; ignores other questions; fails open.
  - **`stage.mjs`:**
    - refuses without an approval and prints the question;
    - accepts after a recorded `Advance`, and uses it once;
    - rejects an approval older than the stage start;
    - skip works the same way;
    - `--confirmed` and `--force` give an error;
    - a missing artifact blocks the advance.
  - **The guard:** blocks Edit and Bash writes to manifests, state and approvals, and calls to `record-answer.mjs`, with or without a task; artifacts stay writable.
  - **`pr-summary`:** its output format.
- `packages/cli/test/ci-check.test.mjs` (**create**):
  - each `missing_block` mode, with and without the label;
  - a valid block passes;
  - a `block` stage not done fails;
  - a confirm stage without `confirmed: answer` fails;
  - unparsable JSON fails;
  - an unknown workflow fails.
- `packages/cli/test/ui/chat.test.mjs` (**modify**):
  - after Stop, a fake claude whose grandchild ignores SIGTERM produces the `orphans` event;
  - `/kill` removes the group and produces `orphans-cleared`;
  - 404 when nothing is left.
- `packages/cli/test/ui/setup.test.mjs`, `init-interactive.test.mjs`, `upgrade.test.mjs` and `uninstall.test.mjs` (**modify**): the CI section, the opt-in, the workflow file update and removal rules, and `INTERFACE` 4.

## Behavior & Edge Cases

- **The developer answers "Not yet":** it's recorded, but never counts. `pending_confirm` stays, `stage.mjs advance` keeps refusing, and Claude carries on with the stage.
- **An old answer after `reopen`:** any approval older than the new `pending_confirm.issued_at` is ignored, so an answer to an earlier, identical question can't be reused.
- **The question is asked twice and answered twice:** each approval is used once. Extra ones stay unused.
- **The question is asked in another session:** it doesn't count, because approvals are per session. Resuming the task in a new session issues a new question.
- **A new session on an existing task with a pending confirmation:** `stage.mjs status` prints the question again.
- **The hook gets no `answers` field** (not expected, after the 2026-11-04 check): `record-answer.mjs` records nothing and logs a visible `systemMessage` ("Shipline couldn't read your answer; the stage can't be confirmed in this session"). There is no separate relay recorder, because the hook covers the browser chat too.
- **An upgrade happens mid-task:** stages already confirmed keep their status. The next `advance` uses the new rules.
- **`ci-check` on a PR from a fork:** it reads only the event payload and repo files, with no secrets, so it works with the default token.
- **A PR body that's edited after it opened:** the check re-runs on `edited`.
- **The leftover-processes notice and the UI server:** if the server restarts, the notice is gone, because the process group can't be recovered. That's accepted.

## Constraints

- **Hooks and scripts:** dependency-free on Node 18. Each hook fails open with a visible message, never silently.
- **Safety:** nothing in the approvals or the PR block includes a secret or the content of answers other than the fixed options.
- **The guard's Bash check** matches only the command text. Hiding the command is an accepted gap (see D).
- **No new dependencies.**

## Verification

1. **In the browser chat on a repo using Feature:**
   - Claude reaches Plan (`confirm_to_advance`) and runs `advance`, which is refused and prints the question;
   - Claude asks the question, and you answer "Advance";
   - the advance succeeds, and the manifest shows `confirmed.via = 'answer'`;
   - asking Claude to edit `manifest.json` or run `record-answer.mjs` is blocked.
2. **The same flow in plain `claude` in a terminal** (the PostToolUse hook). This is the only surface where the `answers` field hasn't been confirmed yet.
3. **CI:** a test PR with no block fails, the `shipline:skip` label makes it pass, and a PR with a valid `pr-summary` block passes. With `ci.missing_block: warn` in `config.yml`, a PR with no block passes with a warning.
4. **Leftover processes:** in the browser chat, ask Claude to start a long-running process, then press Stop. The notice appears, and "Kill them" removes it.
5. **Tests:** `npm test` and CI are green.

## Open Questions

- **Resolved on 2026-11-04 (was Open Questions 1 and 2):** a PostToolUse hook on `AskUserQuestion` receives the developer's answers in `claude -p` with the permission relay (the browser chat). The answers are in `tool_response.answers` (and `tool_input.answers`), a map from question text to the label, along with `session_id` and `tool_use_id`. Evidence: a real run with `claude` 2.1.317, captured hook input.
- **Still to confirm by hand:** the same `answers` field in an interactive terminal session (Verification 2).
- **Accepted from the plan re-review (optional, not blocking):**
  - **The allow rule:** the `Edit(~/.shipline/**)` allow rule stays, because artifacts need it. The guard's PreToolUse deny on `state/`, `approvals/` and manifests runs before permissions and wins over it.
  - **CI config from the PR:** the CI gate reads `config.yml` and the workflows from the PR's own checkout, so a PR can relax its own gate. This is accepted; teams can protect `.shipline/` with CODEOWNERS or branch rules.
  - **Other notes:** uninstall wording, the skip reason, PID reuse, the non-interactive opt-in and `-p` auto-answers are as recorded in `shipline-trust.review.md`. The builder follows the plan text.
