# Shipline 2.2.0, part D: task lifecycle, escape hatches and dev-loop friction

**Status:** Approved (review must-fixes applied)

Part D of the 2026-11-19 audit follow-up. Same branch and release as Plan A (`release/2-2-0`, version 2.2.0,
INTERFACE 2), built **after** Plan A, in its own commit. Plan A's changes (run-hook launcher, `failFirstLevel` in
lib.mjs, `TEST_GLOBS` exported, Bash writes vs stage blocks) are assumed to be in place.

## Problem & Goal

An experienced developer using Claude Code with Shipline hits friction that either makes enforcement lapse or makes
them fight it:

- **Enforcement lapses:** a task is bound to one Claude session id (`state/<session>.json`). After `/clear`, in a new
  session or a second terminal the hooks see no task; only a one-time warning appears (`guard.mjs:162-180`).
- **No lifecycle:** tasks can't be abandoned; stale tasks are offered for resume in every new session
  (`session-start.mjs`); a title that matches an old task fails with "already exists" (`stage.mjs:573`); two live
  sessions can work the same task unknowingly.
- **No escape hatch:** a quick unrelated edit mid-task ("fix that README typo" during Plan) is denied, and the only
  way out orphans the task. After all stages are done, the prompt hook still asks before switching.
- **No explanation:** when a call is denied, there's no way to ask "why, and what do I do".
- **False positives:** the credentials rails deny everyday commands (`source .env && npm start`,
  `--env-file .env`, `cat .env.development`, `.env.local.example`, `printenv PATH`); Grep with `**/*` asks; the
  Verify scope check flags upstream files after a rebase and every new test file; commit-creating git commands are
  treated inconsistently; in a Claude Code worktree under `.claude/worktrees/`, every edit is flagged as agent config.
- **Headless runs stall:** `claude -p` can never pass a `confirm_to_advance` stage.
- **Noise:** Small change suggests two subagents for a one-line fix; session start lists every open task, however
  old.

**Success:** `/clear` mid-task keeps enforcement with no developer action; a dev can abandon a task, make a
confirmed side edit, and ask `explain` after a denial; the listed everyday commands no longer hard-deny; a rebased
branch's scope check shows only the branch's own files; a headless run with the opt-in policy reaches PR on a Small
change whose checks pass.

## Scope

### In

- D1. Auto-bind at SessionStart to the single open task on the current branch.
- D2. `stage.mjs abandon` (developer-confirmed), abandoned tasks hidden from lists; title collisions get `-2`, `-3`.
- D3. Task ownership: owner session + last activity; warn (don't block) when another live session binds.
- D4. Quieter session start: task age; tasks idle longer than `stale_task_days` (config, default 14) collapse into a
  count; `stage.mjs status --all` lists everything.
- D5. Side pass: `stage.mjs side` (developer-confirmed) lets edits to named files through the stage blocks for 30 min.
- D6. Unbind the session when the task's last stage finishes.
- D7. `stage.mjs explain`: the last deny/ask for this session and the way past it.
- D8. Headless policy: `non_interactive: deny | checks_pass` in config.yml, applied only when
  `SHIPLINE_NONINTERACTIVE=1`.
- D9. Credentials rail: sample suffixes; env consumers → ask; `.env.<env>` reads → ask; `printenv/env NAME` allowed
  for non-secret names; Grep asks only when the glob names a credential pattern.
- D10. Scope check: diff from the merge-base; newly added test files are not "sensitive".
- D11. One list of commit-creating git commands; concluding a conflicted merge/rebase/cherry-pick is allowed.
- D12. Worktrees: root from the call's cwd; `.claude/worktrees/**` is not agent config.
- D13. Small change no longer suggests builder / qa-bug-hunter.
- UI: abandoned tasks hidden/marked; owner shown; `non_interactive` and `stale_task_days` in the Setup config form.

### Out (explicitly)

- Tasks shared across worktrees of one repo (store keying by absolute path) → **Plan E**.
- A dry-run guardrail tester (`explain --bash ...`) → Plan F (/ideate).
- An Abandon button in the UI (UI only shows abandoned state).
- Auto-approving skip / accept / scope / abandon / side in headless mode (never auto-approved).
- Detecting `claude -p` automatically (Claude Code exposes no headless signal to hooks; confirmed from
  code.claude.com/docs/en/hooks and /env-vars).
- Indirect Bash writes (Plan A limit stands).

## Surface Area

- **Layers:** vendored hook/stage scripts, the CLI's UI server (task listing), the UI (task panel, lists, Setup config
  form), config schema, templates (workflows, skill), docs.
- **Data model (all in the per-repo store `~/.shipline/projects/<key>/`):**
  - `tasks/<dir>/manifest.json`: new optional `abandoned: { at: ISO, reason: string }`; new log array
    `side_passes: [{ at, session, files: [..], reason }]` (append-only, written by stage.mjs); per stage, optional
    `approved_by: 'non_interactive'` (D8).
  - `tasks/<dir>/owner.json` (**new**): `{ session: id, last_seen: ISO }`. Written by SessionStart auto-bind, `resume`,
    `start`, and guard (throttled: only when `last_seen` is older than 60 s). Never written into the manifest.
  - `state/<session>.json` (existing binding): new optional `side_pass: { files: [repo-relative], reason, expires_at }`.
  - `state/<session>.decision.json` (**new**): the last guard deny/ask `{ at, tool, target, kind: 'stage'|'rail'|
    'protected', id, decision: 'deny'|'ask', reason }`. Written for sessions with or without a task.
  - Missing/unreadable new files are treated as absent; old tasks work unchanged.
- **Config (`.shipline/config.yml`), new optional keys:** `non_interactive: deny | checks_pass` (default `deny`),
  `stale_task_days: <int ≥ 1>` (default 14). Added to `lib.mjs` defaults, `src/setup-schema.mjs` validation, the
  config template (commented), `yaml-emit` layout, and the Setup config form.
- **Confirm kinds:** `CONFIRM_OPTIONS` gains `abandon: { yes: 'Abandon', no: 'Keep it' }` and
  `side: { yes: 'Allow', no: "Don't allow" }`. The UI does not hardcode kinds (checked), so no UI change for them.
- **stage.mjs commands (INTERFACE 2 already bumped by Plan A; extend its `MISSING_BEFORE` text):** `abandon
  [--reason "..."]`, `side --files a,b --reason "..."`, `side done`, `explain`, `status --all`.
- **UI server API:** the task list items (`src/ui/tasks.mjs` listOpenTasks copy and whatever serialises a task for the
  task panel) gain `abandoned` (filtered out of open lists) and `owner: { session, last_seen, active: boolean }`.
  Additive fields only.

## Behaviour & Edge Cases

### D1. Auto-bind at SessionStart

- The current branch is `currentBranch(root)` (`git rev-parse --abbrev-ref HEAD`). An empty result or `HEAD`
  (detached HEAD, e.g. mid-rebase or a checked-out tag) means **no auto-bind**; tasks without a `task.branch` never
  auto-bind.
- SessionStart (any `source`: startup, resume, clear, compact, fork): if the session has no binding, the current
  branch is known, and **exactly one** open, non-abandoned task has `task.branch === branch`, write the binding
  exactly as `stage.mjs resume` does, update `owner.json`, and tell Claude in `additionalContext`:
  `Shipline: continuing task <dir> (<workflow> workflow), current stage "<id>". Run: node .shipline/bin/stage.mjs status`.
- Several matching tasks: no bind; list them (today's text) and ask which.
- None matching: today's behaviour (D4 list).
- The guard's `warnIfLostTask` stays as the fallback for sessions that started before the task's branch existed.
- Ownership check (D3) runs on bind.

### D2. Abandon and title collisions

- `stage.mjs abandon [--reason "..."]` on the bound task (or `--task <dir>`): prints the confirm question (kind
  `abandon`) exactly like `skip`. Recorded answers are matched by exact question text (as for `scope`/`accept`), so the
  question embeds its arguments: `Abandon task <dir>? Reason: <reason or "none">`; once the developer's answer is recorded, rerunning it sets `manifest.abandoned`,
  removes the session binding and prints `Abandoned <dir>. Resume it any time with stage.mjs resume <dir>.`
- `resume <dir>` on an abandoned task clears `abandoned` and binds as normal.
- `listOpenTasks` (lib.mjs **and** the UI server's copy in `src/ui/tasks.mjs`) skip abandoned tasks. `status --all`
  shows them marked "abandoned".
- `start` with a title whose folder exists (open, done or abandoned): use `<slug>-2`, `-3`, … for the folder and the
  suggested branch; the title is unchanged. Print the chosen folder.

### D3. Ownership

- "Active owner" = `owner.json.session` ≠ this session and `last_seen` within 10 minutes.
- On `resume`, `start` (n/a), and SessionStart auto-bind: if there is an active owner, still bind, take ownership, and
  print `Another Claude session (<id first 8>) was working on this task <n> min ago. Both sessions now see it; avoid
  editing the same files.` (additionalContext for SessionStart, stdout for resume).
- guard updates `owner.json` (throttled 60 s) on calls from the bound session.
- UI task panel shows "Another session is working on this task (active <n> min ago)" when the owner isn't the chat's
  own session and is active.

### D4. Quieter session start

- Each listed task shows its age: `(<n>d ago)` from the newest of manifest stage `updated` times and
  `owner.json.last_seen`.
- Tasks idle longer than `stale_task_days` are not listed; instead one line: `+<n> older tasks (idle over <d> days):
  node .shipline/bin/stage.mjs status --all`.
- Tasks matching the current branch are always listed regardless of age.
- `status --all` (with or without a session): every task in the store with workflow, stage, age, branch, and
  done/abandoned marker.

### D5. Side pass

- Requires a bound task (no task → `No task is active; nothing blocks this edit.`).
- `stage.mjs side --files README.md,docs/a.md --reason "typo"`: paths repo-relative, globs not allowed, at least one,
  at most 10. Prints the confirm question (kind `side`). The question embeds the
  exact arguments so a recorded answer only authorises the identical rerun: `Allow edits to <files, sorted, comma-
  separated> outside the stages of task <dir>? Reason: <reason>`. After the answer is recorded,
  rerunning sets `state/<session>.json.side_pass = { files, reason, expires_at: now + 30 min }` and appends to
  `manifest.side_passes`.
- guard: while a side pass is active (not expired), a **stage block** does not hit when the target (file tool path or
  Plan A Bash write target) is in `side_pass.files`. Rails and protected paths still apply (a side pass never lifts a
  rail).
- `stage.mjs side done` clears it; it also expires after 30 min; `advance` does not clear it.
- One side pass at a time; a new `side` replaces the old after its own confirmation.
- The shipline-workflow skill tells Claude: for a small edit unrelated to the task, propose a side pass instead of
  switching tasks.

### D6. Unbind on completion

- When `advance`/`skip` finishes the last stage, `stage.mjs` removes the session binding and prints
  `Task <dir> is complete; this session is no longer tracking a task.` The prompt hook then treats the next request as
  new (no "ask before switching").

### D7. explain

- guard writes `state/<session>.decision.json` whenever it returns deny or ask (stage block, rail, protected path,
  Plan A crash excluded).
- `stage.mjs explain` reads it (session from `$SHIPLINE_SESSION` / `--session`) and prints: when, the tool and target,
  which rule (stage name / rail id / protected path glob), deny or ask, and the way past it:
  - stage block → `Finish "<stage>" (stage.mjs advance)`, or for an unrelated edit `stage.mjs side --files <path>`;
  - rail → the rail id, its level, and the config key (`rails.<id>: ask|off` in .shipline/config.yml) — never advice
    to work around it;
  - protected path → the `protected_paths` entry.
- No decision recorded: `No Shipline denial recorded for this session.`

### D8. Headless policy

- Applies only when `process.env.SHIPLINE_NONINTERACTIVE === '1'` (set by the launcher, e.g. CI script or SDK
  harness). Without it, nothing changes.
- With it and `non_interactive: deny` (default): any command that would print a confirm question instead fails with
  `This stage needs the developer's answer, and this is a non-interactive run (SHIPLINE_NONINTERACTIVE=1). Set
  non_interactive: checks_pass in .shipline/config.yml to let passing checks advance, or run interactively.` and exit 1.
- With `checks_pass`: `advance` on a `confirm_to_advance` stage auto-records the approval only when the latest
  `check` ran on the current fingerprint and every command passed; the manifest's stage gets `approved_by:
  'non_interactive'`. Otherwise the deny message above, naming the failing/missing check. Consequence (documented): a
  stage without checks (e.g. Feature's Plan) can't auto-advance, so headless runs suit Small change / Verify.
- `skip`, `accept`, `scope`, `abandon`, `side` are never auto-approved.
- **Guard asks become denies:** with the flag set (either policy), every guard `ask` (rails at `ask`, the new D9 ask
  tiers, protected paths at ask) is returned as `deny` with the suffix `(non-interactive run: this needs a developer's
  approval)`. Recorded in `decision.json` as `deny`.
- The PR summary notes `Advanced without a developer answer (non-interactive, checks passed)` for such stages.

### D9. Credentials rail

- **Sample suffixes:** any basename ending in `.example`, `.sample`, `.template`, `.dist` (case-insensitive) is never a
  credential path (replaces the three exact names in `lib.mjs:1004`).
- **Env consumers → ask (not deny):** `source <envfile>`, `. <envfile>`, `--env-file <envfile>` / `--env-file=<f>` on any
  command, `dotenv -e <f>`, `env $(cat <f> ...)`-style, `export $(cat <f> ...)`. Ask reason: "loads <file> into the
  environment".
- **`.env.<name>` reads → ask:** reading (Read tool, `cat`/`head`/`less`/… and Grep path) a file matching `.env.<name>`
  where name is not `local`, `production`, `prod` (or contains them, e.g. `.env.production.local`) asks instead of
  denying. `.env`, `.env.local`, `.env.production*`, `.env.prod*` stay deny.
- **printenv / env:** `printenv NAME...` and `env | grep NAME`/`printenv | grep NAME` are allowed when no name/pattern
  contains (case-insensitive) KEY, TOKEN, SECRET, PASS, PWD, CREDENTIAL, AUTH, PRIVATE, SESSION, COOKIE. Bare
  `env`/`printenv` (dump everything) stays as today.
- **Grep:** asks only when `path` is a credential path or `glob` itself names a credential pattern (`.env*`, `*.pem`,
  `*.key`, `*credentials*`, `id_rsa*`, `.npmrc`, `.netrc`, … i.e. the glob string contains one of the name stems in the
  existing `CREDENTIAL_SAMPLES` list in lib.mjs; no new list), not when a broad wildcard merely could match one. Accepted risk: an un-ignored `.env` matched by `**/*`.
- `.npmrc` stays a credential file (unchanged).

### D10. Scope check

- Base for the diff: if the current branch is not a default branch and `git merge-base HEAD <default>`
  succeeds, use that merge-base. Order tried: the names from `defaultBranches(root)` (origin/HEAD's name, else `main`,
  else `master`), first one that resolves wins; if none resolves, `task.base_commit`. On a
  default branch, or when nothing resolves, use `task.base_commit` as today.
- Sensitive files: a test file (TEST_GLOBS) that is **added** (diff status `A`, or untracked) is not sensitive;
  modified, deleted or renamed test files still are. Lint and CI files unchanged.
- The scope line states the base used (`since merge-base with main abc1234`).

### D11. Commit-creating commands

- Held back by a stage's `actions: [commit]` block (and matched by the `commit` action everywhere it's used):
  `git commit`, `git cherry-pick <rev>`, `git revert <rev>`, `git am`, and `git merge --commit` (as today). A plain
  `git merge <x>` stays allowed (merging the default branch in to sync, as today).
- **Allowed while a conflicted operation is in progress** (detected by `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
  `rebase-merge/` or `rebase-apply/` in the git dir): `git commit` / `git commit --no-edit` (concluding a merge),
  `git merge --continue`, `git rebase --continue`, `git cherry-pick --continue`, `git revert --continue`,
  `git am --continue`.
- `git rebase --continue` with no rebase in progress: harmless, allowed.

### D12. Worktrees

- `findRoot`: first try the git toplevel of `input.cwd` (`git rev-parse --show-toplevel`, only if it contains
  `.shipline/config.yml`); else today's walk from `CLAUDE_PROJECT_DIR`. Per the Claude Code docs, after EnterWorktree
  `CLAUDE_PROJECT_DIR` stays the main repo while `cwd` is the worktree. stage.mjs uses the same resolution (its cwd).
- `isAgentConfigPath` excludes `.claude/worktrees/**`.
- Consequence (until Plan E): a worktree has its own store, so tasks started in the main checkout aren't visible in
  the worktree. Documented.
- Cost: one extra `git rev-parse` per hook call; acceptable (measured hook time 0.15–0.37 s); skip it when `cwd` equals
  `CLAUDE_PROJECT_DIR`.

### D13. Small change agents

- `templates/shipline/workflows/small.yml`: remove `agent:` from its stages.

### UI

- Lists of unfinished tasks (sidebar badges, All projects, Health, repo chats view) exclude abandoned tasks (comes from
  the server's listOpenTasks).
- Task panel: `Abandoned <date>: <reason>` banner when viewing an abandoned task's chat; owner line per D3.
- Setup › Project config: `non_interactive` (select deny / checks_pass, help text: "Only applies when
  SHIPLINE_NONINTERACTIVE=1 is set, e.g. in CI") and `stale_task_days` (number ≥ 1). Both added to `TOP_KEYS`.

### Errors

- Every new store file write failure in guard is swallowed (never blocks a call); in stage.mjs it dies with the path.
- Corrupt `owner.json` / `decision.json`: treated as absent and overwritten.

## Constraints

- Hook scripts: Node 18+, no dependencies, Windows-safe paths (Plan A constraint).
- Guard latency: at most one extra git call (D12) and one throttled small write (D3) per call.
- Security: no new path lets Claude get past a rail; side passes and abandon need the developer's recorded answer;
  headless auto-approval requires both the env flag and the config key, and never covers skip/accept/scope.
- Back-compat: tasks and configs from 2.1.x work unchanged; new keys optional.

## Files to Touch

- `packages/cli/templates/shipline/bin/lib.mjs` — **modify**: `CONFIRM_OPTIONS` abandon/side; defaults for
  `non_interactive`, `stale_task_days`; `listOpenTasks` skips abandoned + returns age; owner/decision file helpers;
  `isCredentialPath` sample suffixes and `.env.<name>` ask tier; env-consumer and printenv matching; Grep glob rule;
  `scopeOf` merge-base + added-test rule; `commit` action list + in-progress detection; `findRoot` cwd toplevel.
- `packages/cli/templates/shipline/bin/guard.mjs` — **modify**: side pass exemption; decision record; owner heartbeat;
  `isAgentConfigPath` worktrees exclusion; ask tier for the new credential cases.
- `packages/cli/templates/shipline/bin/stage.mjs` — **modify**: `abandon`, `side`, `side done`, `explain`,
  `status --all`; `start` suffixes; `resume` clears abandoned + ownership warning; unbind on completion; headless
  policy in the confirm path; PR summary note; usage header.
- `packages/cli/templates/shipline/bin/session-start.mjs` — **modify**: auto-bind, ownership warning, ages, stale
  collapse.
- `packages/cli/templates/shipline/bin/prompt-submit.mjs` — **modify**: with no binding after D6 the existing
  "no workflow is active" text applies; adjust only if it still mentions switching for a completed task (verify).
- `packages/cli/templates/shipline/bin/record-answer.mjs` — **modify** only if it whitelists kinds beyond
  `CONFIRM_OPTIONS` (it reads `CONFIRM_OPTIONS`; verify).
- `packages/cli/templates/shipline/config.yml` — **modify**: commented `non_interactive` and `stale_task_days`.
- `packages/cli/templates/shipline/workflows/small.yml` — **modify**: drop agents.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` — **modify**: abandon, side pass, explain, auto-bind
  wording, completion unbind.
- `packages/cli/src/setup-schema.mjs` — **modify**: validate the two new keys.
- `packages/cli/src/yaml-emit.mjs` — **modify**: layout/order for the two new keys.
- `packages/cli/src/interface.mjs` — **modify**: extend the INTERFACE 2 `MISSING_BEFORE` text (new stage commands).
- `packages/cli/src/ui/tasks.mjs` — **modify**: listOpenTasks copy skips abandoned; task items carry `abandoned`,
  `owner`.
- `packages/cli/src/ui/projects.mjs` — **modify** only if it counts unfinished tasks without going through tasks.mjs.
- `packages/ui/src/lib/types.ts` — **modify**: task `abandoned`, `owner`; config `non_interactive`, `stale_task_days`.
- `packages/ui/src/components/task-panel.tsx` — **modify**: abandoned banner, owner line.
- `packages/ui/src/pages/setup/config-form.tsx` — **modify**: two fields, `TOP_KEYS`.
- `packages/cli/src/known-hashes.json` — **modify**: regenerate (with Plan A's).
- `packages/cli/CHANGELOG.md` — **modify**: add D to the 2.2.0 entry.
- `docs/usage.md` — **modify**: auto-bind, abandon, side pass, explain, status --all, headless runs, worktree note.
- `docs/configuration.md` — **modify**: `non_interactive`, `stale_task_days`.
- `docs/guardrails.md` — **modify**: credential changes, commit list, scope check base, worktrees.
- `docs/troubleshooting.md` — **modify**: "why was this denied" → `explain`; worktree tasks not visible.
- Tests — **create/modify** under `packages/cli/test/`: `session-start.test.mjs`, `stage-gate.test.mjs`,
  `stage-scope.test.mjs`, `rails.test.mjs`, `guard-actions.test.mjs`, `guard-lost-task.test.mjs`,
  `confirmations.test.mjs`, `setup-schema.test.mjs`, `test/ui/tasks.test.mjs`; new `stage-lifecycle.test.mjs`
  (abandon, side, explain, status --all, suffixes, unbind, headless).

## Verification

`node:test` cases (user choice), plus the full suite:

- **D1:** SessionStart with source `clear`, new session id, one open task on the branch → binding written, context
  says "continuing"; two matching → no bind, list; abandoned task on branch → not bound.
- **D2:** abandon without answer → question printed, nothing changed; with recorded answer → abandoned, unbound,
  hidden from listOpenTasks and from the UI server list; resume clears; `start` twice with same title → `-2`.
- **D3:** resume while owner active (<10 min) → warning, ownership moves; owner stale → no warning; guard heartbeat
  throttled.
- **D4:** task idle 20 days with `stale_task_days: 7` → collapsed count; branch-matching old task still listed;
  `status --all` lists both.
- **D5:** during Plan, Edit README.md denied → side pass with answer → allowed; other file still denied; rail
  (`cat .env`) still denied; expired (mock clock) → denied; `side done` → denied.
- **D6:** advance last stage → binding removed; prompt hook says "no workflow is active".
- **D7:** deny then `explain` prints stage + side-pass hint; rail ask → config key; nothing recorded → message.
- **D8:** without env flag → unchanged; flag + deny → exit 1 with message; flag + checks_pass + passing checks on
  current code → advances with `approved_by`; stale or failing checks → refused; skip never auto-approved.
- **D9:** each listed command: `.env.local.example` read allowed; `source .env && npm start` ask; `docker compose
  --env-file .env up` ask; `cat .env.development` ask; `cat .env` / `.env.production.local` deny; `printenv PATH`
  allowed; `printenv AWS_SECRET_ACCESS_KEY` denied; Grep `**/*` allowed, Grep glob `.env*` ask.
- **D10:** branch rebased onto a main with new upstream files → those aren't in scope; added test file not sensitive;
  modified test file sensitive; on main → base_commit used.
- **D11:** cherry-pick/revert/am before Verify denied; during a conflicted merge, `git commit --no-edit` allowed;
  `git merge main` allowed.
- **D12:** cwd in `.claude/worktrees/wt` with `.shipline/config.yml` there, `CLAUDE_PROJECT_DIR` = main → root is the
  worktree; edit `src/a.js` not flagged as agent config.
- **UI:** `test/ui/tasks.test.mjs` for abandoned/owner fields; Setup schema round-trip of the new keys.

## Open Questions

- **D11 exact git-dir checks on Windows / worktrees:** the in-progress markers live in `git rev-parse --git-dir`
  (per-worktree); the builder must use that, not `.git/`. Fact to confirm while building, not a design choice.
- **`claude --worktree` launch:** docs confirm `CLAUDE_PROJECT_DIR` stays at the original root after EnterWorktree;
  the `claude --worktree` launch case is unconfirmed. D12's cwd-first resolution covers both either way.
- **Does `/clear` produce a new session id?** Unconfirmed in docs; D1 handles both (an existing binding is kept).
- **Accepted optional review notes** (see `shipline-2-2-0-dev-loop.review.md`; must-fixes applied, re-review skipped
  by the user): any remaining optional items are for the builder to handle in line with this plan; none changes a
  decision above.

## Build-time decisions (2026-11-20, after the first build pass)

Agreed with the user after the builder's report; these amend the sections above.

- **D8 + CI check:** `ci-check.mjs` accepts a stage confirmed by `non_interactive` (checks passed) only when
  `config.yml` has `ci.allow_non_interactive: true` (default false; validated in `setup-schema.mjs`, documented in
  `docs/configuration.md` and `docs/guardrails.md`). Its PR check line then says "advanced without a developer answer
  (checks passed)". Otherwise such a stage still fails as needing the developer's confirmation. Files added to scope:
  `packages/cli/templates/shipline/bin/ci-check.mjs`, `test/ci-check.test.mjs`.
- **D11:** while a conflicted merge/rebase/cherry-pick/revert is in progress (git-dir markers), **any** `git commit`
  (including `-m "..."`) is allowed, not only bare/`--no-edit`.
- **D6:** when the session is unbound because its task finished, the session state keeps `last_task: <dir>`;
  `stage.mjs pr-summary` and `status` without a binding (and without `--task`) use `last_task` and print
  `(task <dir>, finished in this session)`.
- Builder deviations accepted: merge-base prefers the more recent of `origin/<default>` and `<default>`; guard treats a
  bound-but-abandoned task as no task; extra decision kind `store`; Grep glob stems = `CREDENTIAL_SAMPLES` plus their
  extensions; `chat-page.tsx` passes `chatId` to the task panel; `yaml-emit.mjs`, `projects.mjs`, `record-answer.mjs`
  unchanged.
