# Custom workflows: workflow designer skill, Setup flow and more shipped workflows

**Status:** Approved
**Release:** folded into 2.0.0 (same branch, `feat/multi-repo-ui`)
**Sources:** `.claude/research/multi-repo-and-custom-workflows-2026-11-16.md` (section 2), planning interview 2026-11-16.

## Problem & Goal

Teams whose process doesn't fit Feature, Bugfix, Hotfix or Small change must write workflow YAML by hand. In Setup
they can start from a blank workflow (one Implement stage) or copy one, and they need to know what `enforcement`,
`checkpoint`, `sections`, `blocks` and `checks` mean. New stage ids need hand-written rules files. Nothing validates
YAML that Claude writes until a hook reads it.

**Goal:**
- Anyone, whether new to Shipline's fields or an expert, can describe their process in plain words. They get a valid
  workflow (stages, gates, rules), new or changed, in one sitting.
- In the UI they review it in Setup before anything is written.
- Five more shipped workflows give common starting points.

**Success:**
- A team lead who has never seen the YAML creates a working workflow from Setup through "Describe a workflow". They
  review the draft in the existing preview/save dialog and save it.
- "Change with Claude" on an existing workflow produces a reviewable diff.
- In a plain terminal, the skill writes valid files after a summary.

## Scope

**In:**
- A new always-installed skill, `/shipline-workflow-designer`, that creates **and** changes workflows. It has two
  modes: draft (from the UI) and terminal (writes the files).
- New vendored commands `stage.mjs validate` and `stage.mjs draft`. The workflow validator moves into the vendored
  scripts (one copy, shared with the CLI).
- Drafts stored per repo in the store, a drafts API, and a `drafts` SSE event.
- Setup UI:
  - "Describe a workflow" and "Change with Claude" buttons.
  - A "Draft ready" banner, and a "Draft ready, Review" notice in the chat.
  - Review through the existing preview/save dialog, with Save and Discard.
- Five new shipped workflows (Spike, Refactor, Docs, Dependency bump, Release), with rules files for their new stage
  ids. They're offered but not ticked by default in the install wizard and `init`, and in Setup's "Add shipped
  workflow".
- Docs and changelog (2.0.0 entry).

**Out (explicitly):**
- New gate types, such as named-person sign-off or waiting on a ticket status. Workflows use today's stage fields
  only.
- The skill installing or creating agents. It may only use agents already in `.claude/agents/`, or none.
- Changing `config.yml` (rails, commands and so on) from this skill; that stays with `/shipline-setup` and Setup.
- Draft history (only one draft per workflow id).
- New automated tests (verification is manual). Existing tests may only have their expectations updated where
  template hashes and template lists change.
- Changes to `/shipline-setup` beyond one line pointing to the new skill for adding or changing workflows.

## Surface Area

### Skill: `.claude/skills/shipline-workflow-designer/SKILL.md` (new template)

- **Frontmatter:** `name: shipline-workflow-designer`, `disable-model-invocation: true` (like `shipline-setup`),
  and a description covering create and change.
- **Arguments:**
  - `--draft`: UI mode. Write a draft, never the repo files.
  - `--edit <workflow-id>`: change an existing workflow.
  - The rest is the user's free-text description.
  - Without `--draft`, it runs in terminal mode.
- **Steps:**
  1. **Read** `.shipline/config.yml`, `.shipline/workflows/*.yml` (including the field docs at the top of
     `feature.yml`), `.shipline/rules/*.md`, `.claude/agents/`, and the repo's conventions (README, CLAUDE.md, CI).
     With `--edit`, read that workflow and its rules.
  2. **Interview:** a few questions at a time, never assuming.
     - **Process in plain words:** what the team does, step by step. The skill maps the steps to stages itself and
       proposes the mapping instead of asking field by field.
     - **Gates and risks:** where a human must sign off (`confirm_to_advance`, `checkpoint`), and what must never
       happen before what. That covers source edits (`blocks: tools`), commit, push, pr, merge, release, deploy and
       migrate (`blocks: actions`), required sections and `checks`.
     - **Start from the closest:** propose the closest existing or shipped workflow to adapt. Shipped workflows not
       installed in the repo are listed from the `stage.mjs workflows --shipped` output (below).
     - **Rules:** draft a `rules/<stage-id>.md` for every new stage id, and for existing stages the user wants
       changed, from the answers plus the repo's conventions.
     - **Limits:** state plainly that workflows can only use today's fields. If the user asks for a gate that doesn't
       exist (named approver, wait on ticket status), say it isn't supported and offer the closest option
       (confirmation, checkpoint, or block).
  3. **Summarize** the stages, gates and rules, and get approval.
  4. **Write the files** to a fresh folder under `<store>/drafts-tmp/<random>/`: `workflow.yml`, plus
     `rules/<stage-id>.md` for each rules file.
  5. **Validate:** run `node .shipline/bin/stage.mjs validate <that folder>`. Fix any errors and repeat until it's
     clean.
  6. **Hand over:**
     - **Draft mode:** run `node .shipline/bin/stage.mjs draft <workflow-id> --from <that folder>`, then tell the user
       the draft is ready to review in Setup.
     - **Terminal mode:** write `.shipline/workflows/<id>.yml` and the rules files into the repo. The agent_config
       rail's permission prompt applies to each edit. Finish with `stage.mjs validate .shipline` to confirm.
- **The store path** comes from `node .shipline/bin/stage.mjs draft --tmp`, which prints a fresh, empty temp folder
  path. The skill never computes store paths itself.

### Vendored commands (`packages/cli/templates/shipline/bin/`)

- **`stage.mjs validate <path>`**
  - `<path>` is a folder holding `workflow.yml` and an optional `rules/`, a single `.yml` file, or `.shipline` (every
    workflow in the repo).
  - Prints `ok` and exits 0, or prints one line per issue (`<file>: <field path>: <message>`) and exits 1.
  - Uses the shared validator against the repo's agents (`.claude/agents/*.md`) and existing stage ids.
  - Checks that every stage id has a rules file in the draft folder or in `.shipline/rules/`. A missing one is a
    **warning** line (exit 0), not an error.
- **`stage.mjs draft --tmp`** prints the path of a new empty folder `<store>/drafts-tmp/<random 8 hex>/` and creates
  it.
- **`stage.mjs draft <workflow-id> --from <folder>`**
  - `<folder>` must be inside `<store>/drafts-tmp/`; anything else is refused.
  - Runs the same validation; on errors it prints them and exits 1 without making a draft.
  - The `id` inside `workflow.yml` must equal `<workflow-id>`.
  - On success it replaces `<store>/drafts/<workflow-id>/` with the folder's contents plus `meta.json`, removes the
    temp folder, and prints the draft path.
- **`stage.mjs workflows --shipped`** lists the shipped workflows that aren't installed in this repo (id, name,
  description, stages). It's read from the shipped templates copy below.
- **Shared validator:** `validateWorkflow` and the helpers it needs move from `packages/cli/src/setup-schema.mjs`
  into a new vendored `packages/cli/templates/shipline/bin/workflow-check.mjs`. `setup-schema.mjs` re-exports them,
  so the Setup screen and the CLI keep one copy, as `store.mjs` does with `lib.mjs`.
- **Shipped workflow templates for `--shipped`:** the CLI's own `templates/shipline/workflows/` isn't present in a
  repo. `init` and `upgrade` therefore copy the shipped workflow definitions into `.shipline/bin/shipped/*.yml`
  (vendored, hash-tracked like the other bin files). This is read-only reference material for the skill.

### Draft store (per repo, outside the repo)

```
<store>/drafts/<workflow-id>/
  workflow.yml
  rules/<stage-id>.md   (only the rules files this draft adds or changes)
  meta.json             { "workflowId", "createdAt", "baseHash": sha256 of .shipline/workflows/<id>.yml when drafted, or null for a new workflow,
                          "rulesBase": { "<stage-id>": sha256 or null } }
<store>/drafts-tmp/<random>/   (scratch space; folders older than 24 h are deleted by `stage.mjs draft`)
```

- There's one draft per workflow id; a new one replaces the old.
- `guard.mjs`: these folders are **not** protected (Claude must write there). Its existing protection of the progress
  and approval files is unchanged.

### API (per repo, under `/api/repos/:repoId/`; auth as for the other per-repo routes)

- `GET setup/drafts` →
  `[{ workflowId, name, createdAt, isNew, stale, staleRules: [stageId], errors: [..], warnings: [..] }]`.
  - `stale` means the workflow file's current hash differs from `baseHash`. A new-workflow draft whose file now
    exists also counts as stale.
- `POST setup/drafts/:workflowId/preview` → the existing preview response shape (diff per file, validation, impact
  on open tasks), built from the draft's entries: the workflow, plus kind `rules` entries.
- `POST setup/drafts/:workflowId/save` with `{ overwrite: boolean }`.
  - It commits through the existing save path, then deletes the draft.
  - It answers 409 `draft-stale` if the draft is stale and `overwrite` isn't true, and 400 `invalid` if validation
    fails.
- `POST setup/drafts/:workflowId/discard` deletes the draft.
- **SSE `drafts` event** (with `repoId`, as for other per-repo events) carries the `GET setup/drafts` payload. It's
  sent whenever the repo's `drafts/` folder changes; the existing task watch is extended to that folder.

### UI (`packages/ui`)

- **Setup → Workflows section:**
  - A **"Describe a workflow"** button sits next to New workflow and Add shipped workflow. It starts a chat in this
    project with the message `/shipline-workflow-designer --draft`, the same way `SETUP_MESSAGE` starts
    `/shipline-setup` today, and navigates to that chat.
  - Each workflow gets a **"Change with Claude"** action that starts
    `/shipline-workflow-designer --draft --edit <id>`.
- **"Draft ready" banner** at the top of Setup for that project, one row per draft: name, new or changed,
  stale or invalid markers, and Review and Discard buttons.
- **Chat notice:** while a chat in a project is open and a `drafts` event shows a draft created after the chat
  started, the chat shows "Draft ready: <name>, Review", linking to the review.
- **Review:** route `#/setup/<repoId>/draft/<workflowId>` opens the existing save/preview dialog (`save-dialog.tsx`)
  fed by `setup/drafts/:id/preview`.
  - Save calls the draft save endpoint. If it's stale, the dialog says "This workflow changed since the draft was
    made" with **Overwrite** and **Cancel**.
  - Invalid drafts show their errors with Save disabled; Discard is always available.
- **Install wizard and Add shipped workflow** list all nine shipped workflows. The five new ones are unticked by
  default; the current four keep today's defaults.

### Five new shipped workflows (`packages/cli/templates/shipline/workflows/`)

| id | Stages (artifact; key gates) |
| --- | --- |
| `spike` (Spike / Research) | `question` (question.md; sections [Question, Success criteria]; confirm) → `research` (findings.md; agent researcher; sections [Findings, Recommendation]; confirm, checkpoint; blocks actions [pr, merge] until done) |
| `refactor` | `ticket` (optional) → `plan` (plan.md; agent planner; sections [Scope, Files to touch, Behaviour that must not change]; block; blocks tools Edit\|Write\|MultiEdit\|NotebookEdit; confirm, checkpoint) → `implement` (implementation.md; agent builder) → `verify` (verification.md; agent qa-bug-hunter; checks; sections [Checklist]; block; blocks actions [commit, pr]; confirm) → `pr` (pr.md) |
| `docs` | `ticket` (optional) → `outline` (outline.md; sections [Audience, Outline]; confirm, checkpoint) → `write` (writing.md; agent builder; enforcement block; blocks tools Edit\|Write\|MultiEdit with allow_paths [docs/\*\*, '\*\*/\*.md', '\*\*/\*.mdx']) → `review` (review.md; sections [Checklist]; confirm; blocks actions [commit, pr]) → `pr` (pr.md) |
| `deps` (Dependency bump) | `ticket` (optional) → `assess` (assessment.md; agent researcher; sections [Packages, Breaking changes, Risks]; block; blocks tools Edit\|Write\|MultiEdit\|NotebookEdit; confirm, checkpoint) → `upgrade` (upgrade.md; agent builder) → `verify` (as in refactor) → `pr` (pr.md) |
| `release` | `prepare` (release-notes.md; sections [Version, Changes]; confirm, checkpoint) → `verify` (verification.md; checks; sections [Checklist]; block; blocks actions [release, deploy]; confirm) → `publish` (publish.md; confirm) |

- **Rules files** for the new stage ids: `question`, `research`, `outline`, `write`, `review`, `assess`, `upgrade`,
  `prepare`, `publish`. They're short default rules in the style of the existing `rules/*.md`. Existing ids
  (`ticket`, `plan`, `implement`, `verify`, `pr`) reuse the existing rules.
- **Docs `write` stage:** the `allow_paths` block keeps source edits blocked while docs edits are allowed, for the
  whole Docs task.

## Files to Touch

**CLI templates (`packages/cli/templates`)**
- `claude/skills/shipline-workflow-designer/SKILL.md`: **create**. The skill as described above.
- `claude/skills/shipline-setup/SKILL.md`: **modify**. One line: to add or change a single workflow, use
  `/shipline-workflow-designer`.
- `shipline/bin/workflow-check.mjs`: **create**. `validateWorkflow` and its helpers, moved from
  `src/setup-schema.mjs`.
- `shipline/bin/stage.mjs`: **modify**. The `validate`, `draft --tmp`, `draft <id> --from` and `workflows --shipped`
  commands, plus usage text.
- `shipline/bin/lib.mjs`: **modify** only for store path helpers (`draftsDir`, `draftsTmpDir`) if they belong there
  next to `stateDir`.
- `shipline/workflows/spike.yml`, `refactor.yml`, `docs.yml`, `deps.yml`, `release.yml`: **create**.
- `shipline/rules/question.md`, `research.md`, `outline.md`, `write.md`, `review.md`, `assess.md`, `upgrade.md`,
  `prepare.md`, `publish.md`: **create**.
- `claude-md-section.md`: **modify** only if it lists the available skills; mention the new one.

**CLI (`packages/cli/src`)**
- `setup-schema.mjs`: **modify**. Import and re-export the validator from the vendored `workflow-check.mjs`.
- `install.mjs`: **modify**.
  - Install the new skill always; copy shipped workflow definitions to `.shipline/bin/shipped/`.
  - The five new workflows are offered but unticked by default (`init --yes` and the wizard defaults stay the
    current four).
  - `planWorkflowAdd` works for the new ones.
- `upgrade.mjs`: **modify**. Add the skill, `workflow-check.mjs` and `bin/shipped/` to existing repos, as other
  vendored files are added.
- `hashes.mjs`, `known-hashes.json`: **modify**. New template files and hash bookkeeping (2.0.0).
- `ui/setup.mjs`: **modify**. The drafts routes (list, preview, save, discard), built on the existing
  `prepare`/`commit` path.
- `ui/watch.mjs`: **modify**. Watch `<store>/drafts/` and send the `drafts` event.

**UI (`packages/ui/src`)**
- `pages/setup/setup-page.tsx`: **modify**. The Describe a workflow button, the Draft ready banner, and opening the
  review from the route.
- `pages/setup/workflow-editor.tsx` (or `stage-list.tsx`, wherever the per-workflow actions live): **modify**. The
  "Change with Claude" action.
- `pages/setup/save-dialog.tsx`: **modify**. A draft mode: the preview from the draft endpoint, Save with the stale
  Overwrite/Cancel step, and Discard.
- `pages/setup/add-workflow-dialog.tsx`, `pages/install/stages-step.tsx` (or wherever the wizard's workflow choice
  is): **modify**. List the new shipped workflows, unticked by default.
- `pages/chat/notices.tsx`, `pages/chat/chat-page.tsx`: **modify**. The "Draft ready, Review" notice.
- `lib/api.ts`, `lib/types.ts`, `lib/queries.ts`, `lib/events.ts`, `lib/routes.ts`, `app.tsx`: **modify**. The
  drafts calls, types and query, the `drafts` event, and the `#/setup/<id>/draft/<wid>` route.

**Docs**
- `docs/configuration.md`: **modify**. The new shipped workflows, the designer skill, and `stage.mjs validate` /
  `draft`.
- `docs/usage.md`: **modify**. Describe a workflow and Change with Claude in Setup; the skill in the terminal.
- `packages/cli/CHANGELOG.md`, `README.md`: **modify**. Add to the 2.0.0 entry.

**Existing tests (expectation updates only, no new tests)**
- `packages/cli/test/publish.test.mjs`, `packages/cli/test/install.test.mjs`, `packages/cli/test/upgrade.test.mjs`,
  `packages/cli/test/setup-schema.test.mjs` and any test asserting the template file list, hashes, shipped workflow
  list or wizard defaults: **modify**, updating expected lists and hashes only.

## Behavior & Edge Cases

- **Drafting without `shipline ui` running:** the draft still lands in the store, and Setup shows it the next time
  it opens.
- **Two drafts for the same id:** the later replaces the earlier (the chat notice and banner update through
  `drafts`).
- **Stale draft:** someone edits the workflow in Setup or by hand after the draft was made. Save is refused until the
  user picks Overwrite. A stale rules file is listed the same way.
- **Draft for a new id that now exists:** treated as stale.
- **Invalid draft** (possible only if someone edits the draft by hand, since `stage.mjs draft` validates first): the
  review shows errors and Save is disabled.
- **Draft referencing an agent that's not installed:** a validation error (the existing rule); the skill must pick an
  installed agent or none.
- **Change with Claude that removes or renames a stage open tasks use:** the existing impact list in the preview
  shows it, as for editing in Setup.
- **Discard while a chat is still drafting:** a later `stage.mjs draft` simply creates a new draft.
- **A repo on an older version without the new commands:** Setup's buttons stay, but the chat would fail. Setup
  hides the two buttons unless the repo's vendored `stage.mjs` supports `draft` (an interface or feature check from
  `repo.mjs`) and shows "Upgrade this repo to use Describe a workflow".
- **Terminal mode:** any validation errors after writing are shown, and the skill fixes and re-validates.

## Constraints

- Vendored scripts stay Node 18+ with no dependencies.
- `stage.mjs draft --from` only accepts folders inside `<store>/drafts-tmp/`, and draft ids must match `ID_RE`.
- The UI writes repo files only through the existing save path (preview, base hashes, impact check).
- Template changes go through the normal hash bookkeeping so `upgrade` handles them.

## Verification

Manual UI run, by the user:
1. Setup → Describe a workflow. Describe a process, and answer the interview in the chat.
   - The chat shows "Draft ready, Review" and Setup shows the banner.
   - Review shows the diff and validation; Save writes `.shipline/workflows/<id>.yml` and the rules, and the draft
     is gone.
2. Change with Claude on an existing workflow. Review shows a diff against the current file, with the impact on open
   tasks if any.
3. Edit the same workflow in Setup before reviewing a draft. Save asks to Overwrite or Cancel.
4. Discard a draft. It disappears from the banner.
5. Add shipped workflow lists the five new ones; add Docs and check that source edits are blocked and docs edits
   allowed during its `write` stage.

The existing suite must still pass after the expectation updates (run through test-runner when asked).

## Open Questions

- None blocking. The stage design of the five new workflows (table above) is a proposal to review in this draft.
