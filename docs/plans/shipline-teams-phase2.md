# Teams Phase 2: trust — real checks, required sections, evidence for reviewers

**Status:** Approved
**Roadmap:** `docs/plans/shipline-teams-roadmap.md`, Phase 2. Source: `.claude/research/teams-guardrails-workflows-2026-11-05.md`.
**Release:** 0.11.0, on a new branch from `main`.

## Problem & Goal

Today a stage counts as "done" when its artifact file exists (`stage.mjs` advance), so an empty `plan.md` finishes Plan. Verify is Claude's own account in `verification.md`: the configured test, lint and build commands are never run by Shipline, and no result is recorded. The CI check reads a JSON summary pasted into the PR description, which can't show whether tests ran, or on which code. Reviewers see only a stage table.

**Goal:** make the gates mean something, while keeping the developer's cost low:

- Shipline itself runs the configured commands and records the results;
- key artifacts must have their required sections;
- reviewers see the plan's scope, the verification checklist and the command results;
- CI can tell whether the checks ran on exactly the code in the PR.

**Done when:**

1. `node .shipline/bin/stage.mjs check` runs test, lint and build, records the results, and Verify can't finish without a passing run on the current code (unless the developer accepts a failure).
2. Finishing Plan with a `plan.md` that lacks "Files to touch" is refused, naming the missing section.
3. The PR summary shows a results line plus collapsed plan scope and checklist.
4. CI warns (or fails, per config) when the PR's code differs from the code the checks ran on.
5. The browser UI shows the check results under the Verify stage.

## Scope

### In

**A. `stage.mjs check`**

- **Command:** `node .shipline/bin/stage.mjs check`, for the active task (or `--task`). It runs the configured `commands.test`, `commands.lint` and `commands.build` from `config.yml`, in that order, skipping empty ones.
  - Each command runs through the system shell (`spawnSync` with `shell: true`), in the repo root, with the developer's environment.
  - All three run even if one fails, so the developer sees everything at once.
  - stdout and stderr are combined, and only the **last 40 lines, at most 4 KB,** are kept as the tail.
- **The fingerprint** is a hash of the code the run saw: the git tree of the working tree, including uncommitted and untracked files and honouring `.gitignore`.
  - Computed with a temporary index: `GIT_INDEX_FILE=<tmp> git add -A` then `git write-tree`. The real index is never touched, and the temp index is deleted afterwards.
  - The value is a git tree id, so after a commit of exactly that code, `git rev-parse HEAD^{tree}` gives the same id. CI relies on this.
  - Not a git repo, or git fails: the fingerprint is `null`, and freshness checks are skipped with a printed note.
- **What gets recorded,** in the task's `manifest.json` as `checks`:

  ```json
  { "fingerprint": "<tree id or null>", "ran_at": "<ISO>",
    "results": [{ "name": "test", "command": "pnpm test", "exit": 0, "duration_ms": 41873, "tail": "…" }] }
  ```

  - Only the latest run is kept. `manifest.json` is already protected by the guard, so Claude can't edit results by hand.
  - A **null `exit`** means a command that didn't start (spawn error), and it counts as a failure.
- **Printed output:** a summary like `test ✓ 41.9s · lint ✗ (exit 1) · build ✓ 12.0s`, the failing commands' tails, and "Fingerprint: <first 12 chars>".
  - It exits 0 when everything passed (or no commands are configured), and 1 otherwise.
- **No commands configured:** it prints "No test, lint or build commands are configured in .shipline/config.yml." and records `results: []`.
- **Timeouts:** `check` has no timeout of its own. The `shipline-workflow` skill tells Claude to run it with the Bash tool's maximum timeout (600000 ms), or in the background for slow suites.

**B. The gate on a `checks: true` stage**

- **New stage field `checks: true`** (a boolean, default false). The shipped workflows set it on their `verify` stage.
- **`advance` on such a stage** requires, after the existing artifact and sections checks:
  1. **A recorded run.** Otherwise it's refused: "Run `node .shipline/bin/stage.mjs check` first."
  2. **A run on the current code:** `checks.fingerprint` equals the current fingerprint. Otherwise it's refused: "The code changed since the last check run. Run `stage.mjs check` again." This is skipped when either fingerprint is `null`.
  3. **Every result passed,** or the developer accepted the failures (below).
- **Accepting failures:** this uses the existing confirmation mechanism, with no new keying.
  - **A third kind:** `CONFIRM_OPTIONS` in `lib.mjs` gains `accept: { yes: 'Finish anyway', no: 'Not yet' }`, alongside `advance` and `skip`.
  - **The question text:** `confirmQuestion(stage, 'accept', slug, extra)` produces `Finish "<stage>" in task <slug> with failed checks: <names> (run <first 8 chars of fingerprint, or ran_at when null>)?`. It's exact text, so `record-answer.mjs` matches it like the others.
  - **Recording the answer:** `record-answer.mjs` (**definitely modified**) accepts `pending.kind === 'accept'` through `CONFIRM_OPTIONS`, and records it like the others.
  - **Order:** a session has one `pending_confirm` at a time, so accepting comes first.
    - `advance` on a `checks` stage whose current run has failures, with no stored acceptance for **that run**, sets `pending_confirm` to the accept question (via `requireAnswer('accept', …)`) and exits with the question.
    - After the developer answers "Finish anyway", the next `advance` consumes the answer. It stores `accepted: { names: [...], fingerprint, ran_at }` on the stage, then continues.
    - If the stage also has `confirm_to_advance`, the normal advance question follows as today, and needs its own answer.
  - **Validity:** the acceptance only holds for the run it was given for, matched on `fingerprint` and `ran_at`. A new `check` run makes it void, so a rerun that passes leaves no stale acceptance, and one that fails asks again.
    - In the PR summary and on the stage, `accepted` marks the accepted command names. `reopen` clears `accepted`.
- **A stage with no commands configured** finishes as today. The summary records that no commands ran.

**C. Required sections**

- **New stage field `sections: [<heading>, …]`** (a list of strings, optional).
- **The check, on `advance`,** after the artifact-exists check:
  - Every listed section must appear in the artifact as a Markdown heading, any level from `#` to `######`. Matching is case-insensitive, ignores surrounding whitespace, and ignores trailing `:`.
  - Each must have at least **20 non-whitespace characters** of text before the next heading of the same or a higher level.
  - **The helper:** `sectionProblems(markdown, sections)` in `lib.mjs` returns a list of strings, each `"<heading> (no heading)"` or `"<heading> (empty)"`, in the order of `sections`.
  - **On failure,** `advance` exits with `"<artifact> is missing: " + problems.join(', ') + "."`, for example "plan.md is missing: Files to touch (no heading), Verification (empty)."
- **Shipped defaults:**
  - **plan:** `Scope`, `Files to touch`, `Verification`;
  - **verify:** `Checklist`;
  - **root_cause:** `Cause`, `Evidence`;
  - **feasibility:** `Risks`.
- **The Phase 1 default rules are reworded** so they ask for these exact headings: `rules/plan.md`, `verify.md`, `root_cause.md` and `feasibility.md`.
- **`stage.mjs` names the required sections** when it prints the current stage (`describeCurrent`), so Claude writes them from the start.

**D. The PR summary**

`stage.mjs pr-summary` output, after the optional `Closes #n` line from Phase 1:

````
### Shipline
| Stage | Status | Confirmed |
…existing table…

**Checks:** test ✓ 41.9s · lint ✗ (accepted) · build ✓ 12.0s

<details><summary>Plan scope</summary>

…the text under plan.md's "Scope" heading…

</details>

<details><summary>Verification checklist</summary>

…the text under verification.md's "Checklist" heading…

</details>
<!-- shipline:summary {json} -->
````

- **The Checks line:**
  - "(out of date)" is added when the recorded fingerprint differs from the current one when `pr-summary` runs.
  - It reads "**Checks:** no commands configured" when there are none.
  - It's left out when the task has no `checks: true` stage.
- **The collapsed sections:**
  - Each comes from the task's artifact for the stage whose `sections` include that heading: plan's `Scope`, verify's `Checklist`.
  - A missing artifact or section leaves that block out.
  - Each is cut at **3 000 characters**, ending with "…(truncated)".
- **The JSON gains** `checks: { fingerprint, results: [{ name, exit, duration_ms, accepted }] }`. There are no tails or commands in it, to keep the description small.
  - `v` becomes `2`. `ci-check` accepts both `v: 1` and `v: 2`.

**E. CI: the checks ran on this code**

- **The template** `templates/github/shipline.yml` checks out the PR's head commit, `actions/checkout@v4` with `ref: ${{ github.event.pull_request.head.sha }}`, so the tree CI sees is the PR's own code, not the merge commit.
  - `upgrade` updates the file when it's unedited (hash-tracked, as today).
- **`ci-check.mjs`** compares `summary.checks.fingerprint` with `git rev-parse HEAD^{tree}`:
  - **Equal:** a notice, "Checks ran on this exact code."
  - **Where the workflow comes from:** `ci-check` already loads the workflow named in the summary (`loadWorkflow(root, data.workflow)`). It uses that workflow's stages to see whether any stage has `checks: true`.
  - **Different,** or the summary has no checks while that workflow has a `checks: true` stage: it behaves according to `ci.stale_checks`. A summary without checks whose workflow has no `checks: true` stage is fine.
  - **`ci.stale_checks`** is a new config value, `warn` (default) or `fail`.
    - With **`warn`:** a warning annotation, "The checks in the Shipline summary ran on different code than this PR (code changed after `stage.mjs check`, or the summary is from another task). Rerun `stage.mjs check` and paste `pr-summary` again."
    - With **`fail`:** the same text as a failure.
  - **A fingerprint of `null`, or a `v: 1` summary:** a notice that freshness can't be checked, and never a failure.
- **Failed commands:** the job-summary table gains a Checks row. A command that failed and wasn't accepted is a **failure**, regardless of `stale_checks`.

**F. Browser UI**

- **The server:** the task shape from `GET /api/tasks` and `GET /api/chats/<id>` (`tasks.mjs`) gains `checks: { ran_at, stale, results: [{ name, command, exit, duration_ms, tail, accepted }] } | null`.
  - **`stale`** is computed by the server, which compares the recorded fingerprint with the current one using the same temp-index method, at most once per 5 s per repo.
- **The task panel:** under the `checks: true` stage in `StageTimeline`, a compact row per command (name, ✓ or ✗, duration, "accepted").
  - An "Out of date" badge shows when `stale` is true.
  - Clicking a row expands its output tail in a monospace block.
  - Before the first run, it says "No check run yet".

**G. Setup and upgrade**

- **The Setup stage editor:** a "Run checks before finishing" switch (`checks`), and a "Required sections" list editor (`sections`) that adds or removes strings, like the existing allow-paths editor.
  - `setup-schema.mjs`: `checks` is a boolean and `sections` a list of non-empty strings. Both join `KNOWN_FIELDS.stage`.
  - `config-form.tsx`: `ci.stale_checks` gets a select next to `missing_block`, and `setup-schema` validates it.
- **`upgrade`, in `planConfig` alongside the Phase 1 migrations:** in each `.shipline/workflows/*.yml`, it adds `checks: true` to any stage with id `verify` that has no `checks` key. It also adds the default `sections` to stages with ids `plan`, `verify`, `root_cause` or `feasibility` that have no `sections` key.
  - The changes are shown with a diff, and `--dry-run` writes nothing.
  - Stages that already set them are left alone.
  - Rules files are updated by the existing stub-hash mechanism: the Phase 1 rules are recorded in `known-stub-rules.mjs`, so unedited ones are replaced.

### Out

- Running commands in CI. CI only compares fingerprints; teams' own CI still runs tests.
- Signed or tamper-proof summaries. A determined developer can still hand-edit the JSON, and the plan accepts this.
- Per-package commands (monorepos, Phase 3), and timeouts or parallelism for `check`.
- Section checks on artifacts other than the four defaults, unless a team adds them.
- Keeping more than the latest check run.

## Surface Area

- **Vendored hooks and scripts:**
  - `bin/stage.mjs`: `check`, the gate, sections, and `pr-summary`;
  - `bin/lib.mjs`: `fingerprint(root)`, `findSection(md, heading)`, `sectionProblems`, and the `accept` question kind;
  - `bin/ci-check.mjs`;
  - `bin/record-answer.mjs`: accepts the new `accept` kind.
- **Templates:**
  - all four workflows (`checks`, `sections`);
  - four rules files;
  - `config.yml` (`ci.stale_checks` documented);
  - `github/shipline.yml`;
  - the `shipline-workflow` skill (how to run `check`, required headings, accepting failures).
- **CLI:** `setup-schema.mjs`, `upgrade.mjs`, `known-stub-rules.mjs` (Phase 1 rule hashes added), `known-hashes.json` and `package.json` (0.11.0).
- **UI server:** `tasks.mjs` (`checks` on the task shape, `stale`).
- **Browser UI:** `task-panel.tsx` (check rows), `setup/stage-editor.tsx`, `setup/config-form.tsx`, `lib/types.ts`.
- **Data:** the manifest gains `checks` and the per-stage `accepted`. Workflow stages gain `checks` and `sections`, and config `ci.stale_checks`. The summary JSON is `v: 2`. `INTERFACE` goes **4 → 5**, because `stage.mjs` gains a command the skill relies on, so an older UI on a newer repo sees the usual version banner.

## Files to Touch

- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**):
  - `fingerprint(root)` (temp index, `write-tree`, null on error);
  - `findSection(markdown, heading)` → `{ found, text }`;
  - `sectionProblems(markdown, sections)` → a list of problem strings;
  - `CONFIRM_OPTIONS.accept`, and `confirmQuestion` builds the accept question text;
  - `loadConfig` normalises `ci.stale_checks` (`warn` or `fail`, default `warn`).
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**):
  - the `check` command;
  - the gate in `advance` for `checks: true` stages;
  - the sections check in `advance`;
  - sections listed in `describeCurrent`;
  - `pr-summary`: the Checks line, the collapsed blocks and the JSON `v: 2`;
  - the usage text.
- `packages/cli/templates/shipline/bin/record-answer.mjs` (**modify**): accept and record `pending.kind === 'accept'`.
- `packages/cli/templates/shipline/bin/ci-check.mjs` (**modify**): accept `v: 1` and `v: 2`, the fingerprint comparison with `stale_checks`, failed and unaccepted commands, and the Checks row in the job summary.
- `packages/cli/templates/github/shipline.yml` (**modify**): checkout `ref: ${{ github.event.pull_request.head.sha }}`.
- `packages/cli/templates/shipline/workflows/{feature,bugfix,hotfix,small}.yml` (**modify**): `checks: true` on verify, plus the default `sections`, with the header comment documenting both fields.
- `packages/cli/templates/shipline/rules/{plan,verify,root_cause,feasibility}.md` (**modify**): ask for the exact required headings.
- `packages/cli/templates/shipline/config.yml` (**modify**): document `ci.stale_checks`.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` (**modify**): the Verify stage covers running `stage.mjs check` with a 600000 ms Bash timeout (or in the background), rerunning after changes, asking the accept-failures question only after reporting the failures, and writing the required headings.
- `packages/cli/src/known-stub-rules.mjs` (**modify**): add the 0.10.x hashes of the four rules files being changed.
- `packages/cli/src/setup-schema.mjs` (**modify**): the stage fields `checks` and `sections`, and `ci.stale_checks`.
- `packages/cli/src/upgrade.mjs` (**modify**): add `checks` and the default `sections` where missing, with diff and dry-run.
- `packages/cli/src/interface.mjs` (**modify**): INTERFACE 5.
- `packages/cli/src/ui/tasks.mjs` (**modify**): `checks` on the task shape, and `stale` from a cached fingerprint (5 s).
- `packages/ui/src/components/task-panel.tsx` (**modify**): check rows under the `checks` stage, the out-of-date badge and the expandable tail.
- `packages/ui/src/pages/setup/stage-editor.tsx` (**modify**): the checks switch and the sections list editor.
- `packages/ui/src/pages/setup/config-form.tsx` (**modify**): the `ci.stale_checks` select.
- `packages/ui/src/lib/types.ts` (**modify**): `Task.checks`, `StageModel.checks` and `.sections`, and `ci.stale_checks`.
- `packages/cli/src/known-hashes.json` (**modify**): regenerated with `packages/cli/scripts/hash-templates.mjs`.
- `packages/cli/package.json` (**modify**): 0.11.0.
- `README.md` (**modify**): `stage.mjs check`, the new stage fields, `ci.stale_checks`, and the PR evidence.
- `docs/plans/shipline-teams-roadmap.md` (**modify**): link Phase 2 to this plan.

### Tests (written separately, listed here)

- **`test/stage-check.test.mjs` (create):**
  - pass, fail and spawn-error commands;
  - empty commands skipped;
  - "no commands configured";
  - the tail cut to 40 lines and 4 KB;
  - the exit code;
  - results in the manifest, latest only;
  - the fingerprint is the same for the same tree, changes after an edit or a new untracked file, ignores gitignored files, and leaves the real index untouched;
  - `null` outside git.
- **Gate tests (create or extend the stage tests):**
  - no run → refused;
  - stale run → refused;
  - failing run → the accept-failures question, then advance with an answer;
  - acceptance recorded with its run, and voided by a new run;
  - both questions when `confirm_to_advance` is also set;
  - no commands → finishes.
- **Section tests:**
  - present, missing, empty (under 20 characters), wrong case, heading levels, trailing colon, nested headings;
  - the error message lists all problems.
- **`pr-summary` tests:**
  - the Checks line in each state, including out of date and none;
  - the collapsed blocks and truncation;
  - missing artifacts;
  - JSON `v: 2` with no tails.
- **`ci-check` tests:**
  - a `v: 1` summary still passes;
  - a fingerprint equal to `HEAD^{tree}` → notice;
  - a different one → warn by default and fail with `stale_checks: fail`;
  - a failed unaccepted command → fail;
  - accepted → pass;
  - a null fingerprint → notice.
- **`upgrade`:** `checks` and sections added where missing, kept where set; the `shipline.yml` checkout ref updated when unedited.
- **`setup-schema` and the UI setup tests:** the new fields are validated and survive a save.
- **`test/ui/tasks.test.mjs`:** `checks` and `stale` on the task shape.

## Behavior & Edge Cases

- **`check` while another `check` runs for the same task:** the last one to finish wins. This is accepted.
- **A very large repo:** `git add -A` into a temp index costs about as much as `git status`. This is accepted.
- **Files ignored via `.git/info/exclude` or global excludes** are honoured by `git add -A`, the same as `.gitignore`.
- **A PR built from several Shipline tasks:** each summary is per task, and the last summary block wins (existing behaviour). Its fingerprint must match the PR's code.
- **Squash or rebase before merge:** the tree stays the same unless the code changes. A rebase that pulls in new base changes alters the tree, so CI warns (or fails) and the developer reruns `check`.
- **Reopening a `checks` stage:** the old `checks` record stays, but its fingerprint will usually be stale. `accepted` is cleared on reopen.
- **Section headings inside fenced code blocks** are ignored.

## Constraints

- **Node 18, no dependencies** in the vendored scripts.
- **Only git plumbing:** no change to the real index or working tree.
- **The friction budget:**
  - the gate adds one command run, which Claude does itself;
  - the developer is only asked when something failed;
  - the section check costs nothing when the artifact is written to the default rules.

## Verification

1. **On a repo with commands configured:** start a feature, reach Verify, and run `stage.mjs check` with a failing lint.
   - `advance` asks to accept. Answer yes, and it finishes.
   - Edit a file, and `advance` on a reopened Verify says the check is stale.
2. **Plan sections:** delete "Files to touch" from `plan.md`, and `advance` names it.
3. **The PR:** `pr-summary` shows the Checks line and the two collapsed blocks. On a real PR, CI says "Checks ran on this exact code".
   - Push another commit, and CI warns.
   - With `stale_checks: fail`, it fails.
4. **The UI:** the task panel shows the check rows, then "Out of date" after an edit.
5. **Upgrade:** `upgrade` on a 0.10.x repo adds `checks` and sections with diffs. An open task keeps working.
6. **Tests:** the suite and CI are green on all three operating systems.

## Open Questions

- **Commands that need services or secrets** (databases, API keys) may fail locally. The accept-failures question covers this, but teams may want per-command opt-outs later.
- **Windows:** commands run through `cmd.exe` (`shell: true`). Commands written for POSIX shells, as in `package.json` scripts, run through npm or pnpm, so they're fine, but raw POSIX commands in `config.yml` may not be.
- **`stale` costs a temp-index `git add -A`** every 5 s while a UI is open with tasks. If that proves heavy on huge repos, it can become on-demand.
