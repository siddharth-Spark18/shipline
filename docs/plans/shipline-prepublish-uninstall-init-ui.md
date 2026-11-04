# Pre-publish: uninstall, interactive init, Small change workflow, changes view and centered chat

**Status:** Approved
**Branch:** `feat/phase1-storage-upgrade-publish`. This work stacks on PR #2 and ships with it as 0.7.0, which hasn't been published yet.
**Builds on:**
- `docs/plans/shipline-phase1-storage-upgrade-publish.md`: the store, `VERSION.files`, `upgrade` and `known-hashes.json`.
- `docs/plans/shipline-adoption-roadmap.md`: this plan brings forward part of Phase 2 (install) and Phase 3 (friction).

## Problem & Goal

Before publishing `@forgeyard/shipline`, the author wants six gaps closed. Without them, the tool is harder to adopt and less pleasant to use.

1. **No uninstall.** Removing Shipline from a repo today has to be done by hand. The author just did this on `brown-bg-tracker`, and the hooks that were left behind kept failing.
2. **Small changes have no fitting workflow.** A typo still goes through Feature, Bugfix or Hotfix. The author wants a light workflow that Claude can pick by itself, and doesn't want any workflow skipped.
3. **`init` is all or nothing.** Teams can't choose which workflows or agents to install, can't use their own agents or skills, and any name clash aborts the install.
4. **Setup has no way to create a new workflow.** Only copy and delete exist.
5. **Changes are shown poorly.**
   - Working-tree changes appear as raw git codes (`M`, `??`) in a flat list.
   - Diffs only open in a dialog, and long lines run outside it (author's screenshot, 2026-11-04).
6. **The chat layout is wrong.**
   - The chat should be a centered column like the Claude desktop app, with the task panel sliding in.
   - Questions should be grouped in tabs, like Claude Code's question UI.

**Done when** (the author's checks):
- **Uninstall and reinstall on brown-bg-tracker:**
  - `shipline uninstall` leaves no Shipline file behind and asks about task data.
  - After that, an interactive `shipline init` installs Shipline again.
- **Click-through in the UI:**
  - The chat is centered, and the task panel slides in when a task starts.
  - A real AskUserQuestion shows as tabs with a Submit tab.
  - The new changes view works on the Tasks page, in the chat panel and in the Setup preview.
  - "+ New workflow" works.
  - The Agents & skills section works.
- **Tests:** the existing test suite and CI must also stay green, because PRs can't be merged otherwise.

## Scope

### In

**A. `shipline uninstall [dir] [--yes] [--dry-run] [--purge]`**
- **What it removes:**
  - all of `.shipline/`, including the team's config, workflows and rules;
  - every Shipline-installed agent and skill recorded in `VERSION.files`, edited or not;
  - the `CLAUDE.md` block;
  - Shipline's hook entries and allow rules in `.claude/settings.json`.
- **What it never touches:** files recorded in `VERSION.excluded`, which are the team's own agents kept instead of ours.
- **How it runs:**
  - It shows a preview, then asks y/N, like `upgrade`. `--dry-run` only previews.
  - It asks a separate question about deleting this repo's task data in `~/.shipline/projects/<encoded>/`.
  - With `--yes`, the task data is kept unless `--purge` is passed.
- **Git and the UI:**
  - It only deletes files from disk. It never runs `git rm`, so the developer commits the removal.
  - It refuses while a live UI chat holds this repo's lock.

**B. The Small change workflow**
- **File:** a new template `workflows/small.yml` (id `small`, name "Small change").
- **Stages:**
  - `jira` (optional), then `implement`, then `verify` (`block` on `git commit` / `gh pr create` until done, confirm to advance), then `pr`.
  - These reuse the existing rules files.
- **How Claude uses it:**
  - Claude decides for itself when a change is small (a typo, a rename, a config tweak, a one-file fix).
  - It announces "Using the Small change workflow" and starts without waiting for an OK. Other workflows still need the OK.
  - The existing workflows stay as they are.

**C. Interactive `init`**
- **Choices it offers:**
  - workflows, from Feature, Bugfix, Hotfix and Small (all four selected by default);
  - Shipline's agents, from planner, builder, reviewer, qa-bug-hunter, wireframe-proposer and researcher (all six selected by default);
  - which of the repo's own `.claude/skills` to list in `config.yml` `skills:`, from none to all.
- **Name clashes:** when one of Shipline's agent names already exists in the repo, `init` asks per clash:
  - *keep yours*: the repo's file stays, is used for that stage, and is recorded in `excluded`;
  - *use ours*: Shipline's file replaces it;
  - *skip*: no file, and the agent counts as deselected.
- **Missing agents:** for every chosen workflow stage whose `agent:` is no longer installed, `init` asks which agent to use instead. The choices are the remaining Shipline agents, the repo's own agents, or none.
- **Non-interactive modes:**
  - `--yes` installs the defaults with no prompts, keeps the repo's file on every clash, and selects no repo skills.
  - Without a terminal and without `--yes`, `init` refuses ("run in a terminal or pass --yes").
- **Prompts:** `@inquirer/prompts`, the CLI's first runtime dependency, loaded only by `init`.
- **Repo already has Shipline:** the existing "already initialized" check (`.shipline/`, the `CLAUDE.md` block or the hooks) runs first, before any prompt, with or without `--yes`. Nothing is written. The message points to:
  - `shipline ui` → Setup → Agents & skills, to change choices;
  - `upgrade`, to update;
  - `uninstall` followed by `init`, to start over.

**D. Repo skills**
- `config.yml` gets an optional `skills: [name, …]`, a list of the repo's own skills.
- `stage.mjs` prints "Repo skills you can use: …" with every stage's description, so Claude sees them at each stage.

**E. Setup UI**
- **"+ New workflow":** a button at the top of the workflow list. It asks for an id and a name, and creates a blank workflow with one `implement` stage (`enforcement: guide`).
- **A new "Agents & skills" section:**
  - add or remove each Shipline agent, through the usual diff-and-confirm save. Removing one adds it to `VERSION.excluded`; adding one removes it from that list;
  - pick which of the repo's `.claude/skills` go in `config.yml` `skills:`;
  - each stage's agent picker lists both the installed Shipline agents and the repo's own agents.

**F. The changes view**
- It replaces how changes are shown in three places: the Tasks page, the chat task panel's Changes tab and the Setup save preview.
- **Files:**
  - grouped by folder, as a collapsible tree;
  - each file has a status shown as an icon, a colour and a word: Added (also used for untracked files), Modified, Deleted, Renamed;
  - each file shows `+N −M` line counts.
- **Diffs:**
  - clicking a file expands its diff inline, under the file;
  - unified diffs only;
  - long lines scroll horizontally inside the diff and never overflow their container.
- The diff dialog is removed for changed files. Artifacts still open in the file viewer.

**G. Chat layout and questions**
- **Layout:** the chat is a centered column, like the Claude desktop app.
- **The task panel:**
  - When a task starts, the panel slides in from the right with an animation of about 250 ms.
  - The centered column eases a little to the left but keeps its width.
  - The panel stays resizable.
  - A button in the chat header closes and reopens it.
  - The panel stays closed when there is no task.
- **Narrow screens:** below about 1200 px wide, the panel opens as an overlay sheet from the right, and the chat stays full width. This replaces the dot ribbon.
- **Questions:** each AskUserQuestion becomes a set of tabs.
  - There is one tab per question, labelled by its `header` (or "Q1", "Q2" and so on).
  - Answering a question moves to the next tab.
  - A final "Submit" tab lists every answer and has the Send button.
  - **Keyboard:** left and right arrows switch tabs, number keys 1–9 pick an option, and Enter goes to the next tab or submits.
  - Single-select, multi-select and "Other" keep working as they do today.

### Out

- Choosing optional *Shipline* skills. Shipline ships only the two required skills.
- A staged/unstaged distinction in the changes view.
- A side-by-side (split) diff.
- Changes to the Feature, Bugfix and Hotfix stages or their confirmations.
- Uninstall from the UI. Uninstall is a CLI command only.
- Publishing itself: the tag and `NPM_TOKEN`, which are already planned in Phase 1.
- The rest of roadmap Phases 2 and 3 not listed here: a Node preflight, and Jira in the `-p` chat.

## Surface Area

### Layers

- **CLI:** `init`, `uninstall` and `upgrade` tweaks.
- **Vendored templates:** a new workflow, `stage.mjs` output, the skill and `CLAUDE.md` wording.
- **UI server:** the setup and tasks API.
- **Browser UI:** Setup, the changes view and the chat.

### `VERSION` (still interface 3; 0.7.0 is unpublished, so no bump)

```json
{
  "package": "0.7.0",
  "interface": 3,
  "files": { "<path>": "<sha256>" },
  "excluded": [".claude/agents/researcher.md"]
}
```

**`excluded`** lists the Shipline-owned paths the team deliberately doesn't have: deselected agents and "keep yours" clashes.
- **`upgrade`** never adds, replaces or removes an excluded path.
- **`uninstall`** never deletes one.
- **The Setup Agents section** edits the list.
- **A missing `excluded`** is treated as `[]`.

### `config.yml`

The new optional key is `skills: [name, …]`, a list of names of the repo's own `.claude/skills/<name>`.
- **Validation:** each name matches `^[A-Za-z0-9_-]+$`. A name with no `.claude/skills/<name>/` directory is a warning, not an error.
- **The UI's config form** shows it in the Agents & skills section, not with the general config fields.

### API changes (UI server)

- **`GET /api/tasks`:** each `changes[]` entry becomes:

  ```
  { path, oldPath?, status: 'added'|'modified'|'deleted'|'renamed', additions: number|null, deletions: number|null }
  ```

  - **Status:** `status` replaces the raw `index`/`worktree` codes. Untracked files count as `added`.
  - **Counts:** from `git diff --numstat HEAD`, and for untracked files from `git diff --numstat --no-index /dev/null <path>`.
  - **Binary files:** `null` for both counts.
- **`GET /api/file?mode=diff`:** unchanged. The new view calls it when a file is expanded.
- **`POST /api/setup/workflows`:** gains `{ action: 'create', id, name }`.
  - **Effect:** writes `workflows/<id>.yml` with `{ id, name, stages: [{ id: 'implement', name: 'Implement', enforcement: 'guide', confirm_to_advance: false }] }`, using `wx`.
  - **Errors:** 400 `invalid` for a bad id, and 409 `exists` if a workflow with that id exists.
  - `copy` and `delete` are unchanged.
- **`GET /api/setup`:**
  - `agents` becomes `{ shipline: [{ name, installed: boolean, excluded: boolean, hash: string|null }], repo: [name] }`. `hash` is the SHA-256 of the installed `.claude/agents/<name>.md`, or `null` when the file is absent.
  - The response gains `skills: { repo: [name], selected: [name] }`.
  - The response gains `versionHash`: the SHA-256 of the raw `.shipline/bin/VERSION` text.
- **`POST /api/setup/agents`** (new):
  - **Request:** `{ add?: [name], remove?: [name], baseVersionHash, baseHashes: { "<path>": hash|null } }`. `baseHashes` holds the agent file hashes from `GET /api/setup`; `null` means "must not exist".
  - **Preview** (`?preview=1`): returns `{ files: [...], version: { before, after } }`.
    - Each `files` entry has the same shape as the existing `POST /api/setup/preview` entries (`{ kind, id, text, diff, removedComments, errors }`), with `kind: agent` and `id: <name>`.
    - For a removal, `text` is `null` and `diff` shows every line removed.
    - `version` holds the `VERSION` JSON before and after.
  - **Apply:**
    - The server re-checks `baseVersionHash` and every `baseHashes` entry, and returns 409 `changed` (with the paths that changed) on any mismatch.
    - It then writes or deletes `.claude/agents/<name>.md` (only Shipline's names) and updates `VERSION.files` and `excluded`, writing `VERSION` last.
  - **Team-owned agent files:** an agent that is in `excluded` but whose file exists is the team's own file (a "keep yours" clash).
    - `remove` on it returns 400 `not-shipline` and deletes nothing. The UI shows it as "Your own agent" with no remove toggle.
    - `add` on it replaces the team's file with Shipline's version. The preview shows this as a normal diff, and on apply the path moves from `excluded` to `files`.
  - **Errors:** 423 `repo-newer` per the existing rule.
  - The Setup save dialog shows these entries with `ChangesView`, and counts `+N −M` from the `add` and `del` lines in each entry's `diff` hunks.
- **Repo skills** are saved through the existing `POST /api/setup/save` on `config.yml`, with `skills` as a known field.

## Files to Touch

### A. Uninstall

- `packages/cli/src/uninstall.mjs` (**create**): `runUninstall({ target, yes, dryRun, purge })`. It runs in this order:
  1. **Refuse** if there's no `.shipline/` ("Shipline is not installed here").
  2. **Refuse** if a UI chat holds the lock:
     - read it with `readLock(root)` from `packages/cli/src/ui/sessions.mjs`;
     - it is held when `lock.json` exists, its `hostname` equals `os.hostname()` and `pidAlive(pid)` is true;
     - the refusal says "Stop the Shipline UI for this repo first (port <port>)";
     - a stale lock (dead process, or another host) is only noted in the preview and doesn't block the uninstall.
  3. **Build the removal list:**
     - all of `.shipline/`;
     - every path in `VERSION.files` that isn't in `excluded`;
     - every empty `.claude/skills/shipline-*` directory left afterwards;
     - the `CLAUDE.md` block, including the blank line before the start marker;
     - Shipline's hook entries in `.claude/settings.json`, matched by a command containing `.shipline/bin/`, and the exact allow rules `Read(~/.shipline/**)` and `Edit(~/.shipline/**)`. Empty arrays and objects left behind are removed.
     - If `VERSION` is missing (a legacy install), it falls back to Shipline's template inventory in `hashes.mjs`, plus any `.claude/skills/shipline-*`.
  4. **Show the preview.** This repo's store folder (path and size) is shown as a separate item.
  5. **Confirm:**
     - `--dry-run` exits here;
     - otherwise it asks y/N, then "Also delete this repo's task data at <path>? y/N";
     - `--yes` skips both questions and deletes the task data only with `--purge`;
     - without a terminal and without `--yes`, it refuses.
  6. **Apply:** edit `settings.json` and `CLAUDE.md`, then delete the files, then `.shipline/` last, then the store folder if that was chosen.
  7. **Print** "Removed. Commit the deletion so teammates no longer get Shipline."
- `packages/cli/bin/shipline.mjs` (**modify**): add `uninstall [dir] [--yes] [--dry-run] [--purge]`, plus help text for `uninstall` and for `init --yes`.
- `packages/cli/src/ui/sessions.mjs` (**modify**): export the existing `pidAlive(pid)` for `uninstall`. Its imports are only `store.mjs` and `log.mjs`, so nothing heavy is loaded.
- `packages/cli/src/hashes.mjs` (**modify**): export `removeShiplineFromSettings(settings)` and `removeClaudeMdBlock(text)`. They're the inverse of the existing merge helpers, and `uninstall` uses them.
- `README.md` (**modify**): an "Uninstall" section in Install.

### B. Small change workflow and D. repo skills

- `packages/cli/templates/shipline/workflows/small.yml` (**create**): the stages listed in scope B, with the standard workflow header comment.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` (**modify**):
  - list the Small change workflow, and say Claude chooses it for small changes;
  - give examples of small changes;
  - say Claude announces it and starts without asking;
  - mention the repo skills that `stage.mjs` prints.
- `packages/cli/templates/claude-md-section.md` (**modify**): "(Feature, Bugfix, Hotfix or Small change)".
- `packages/cli/templates/claude/skills/shipline-setup/SKILL.md` (**modify**): mention Small change and `skills:`.
- `packages/cli/templates/shipline/bin/stage.mjs` (**modify**): `describeCurrent` adds "Repo skills you can use: a, b" when `config.skills` is a non-empty list.
- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**): `loadConfig` passes `skills` through.
- `packages/cli/src/setup-schema.mjs` (**modify**): add `skills` to `KNOWN_FIELDS` for config, with validation as in Surface Area.
- `packages/cli/src/yaml-emit.mjs` (**modify**): add `skills` to the config layout so it's written in a stable place, after `commands`.
- `packages/cli/src/known-hashes.json` (**modify**): re-run `packages/cli/scripts/hash-templates.mjs` for 0.7.0 after the template changes.

### C. Interactive init

- `packages/cli/package.json` (**modify**): add `"dependencies": { "@inquirer/prompts": "<current major>" }`.
- `pnpm-lock.yaml` (**modify**): regenerated by `pnpm install` after adding the dependency. CI installs with `--frozen-lockfile`, so a stale lockfile fails the build.
- `packages/cli/src/init.mjs` (**modify**):
  - **Flags:** parse `--yes`. Without a terminal and without `--yes`, refuse.
  - **Detect** the repo's `.claude/agents/*.md` and `.claude/skills/*/`.
  - **Prompts:** these run in `init-prompts.mjs`. Their answers become a selection object that drives the existing copy logic:

    ```
    { workflows, agents, clashes: { name: 'keep'|'ours'|'skip' }, stageAgents: { '<wf>.<stage>': name|null }, skills }
    ```

  - **Writing the result:**
    - copy only the chosen workflows (their rules are copied for all stages they use, as today);
    - copy only the chosen agents, and apply the clash decisions;
    - set each stage's `agent:` in the copied workflow files to the chosen replacement (or remove it);
    - write `skills:` into `config.yml`;
    - write `VERSION` with `files` (what was written) and `excluded` (deselected agents and "keep yours" clashes);
    - the collision check no longer aborts on agent names. It still aborts on any other collision, as today.
  - **`--yes` defaults:** all workflows, all agents, "keep yours" on every clash, stage agents left as they are where the agent exists (otherwise removed), no skills.
  - **Summary:** the success output lists every kept clash: "Kept your own agents (used where Shipline's would be): <names>. To use Shipline's instead: `shipline ui` → Setup → Agents & skills, or uninstall and re-run `init` interactively."
- `packages/cli/src/init-prompts.mjs` (**create**): the `@inquirer/prompts` calls. It's imported only on the interactive path, so `ui`, `upgrade` and `uninstall` never load the dependency.
  - **Prompt order:**
    1. a workflows checkbox;
    2. an agents checkbox;
    3. a select per clash;
    4. a select per stage whose agent is missing;
    5. a repo skills checkbox, shown only if the repo has skills.
  - It returns the selection object.
- `packages/cli/src/upgrade.mjs` (**modify**): skip every path in `VERSION.excluded`, so it never adds, replaces or removes one, and keep `excluded` when it rewrites `VERSION`.
- `packages/plugin/commands/init.md` (**modify**):
  - run `npx --yes @forgeyard/shipline init --yes` and update `allowed-tools`;
  - tell Claude to show the developer the "Kept your own agents" list from the output, if there is one, and how to switch to Shipline's versions;
  - tell the developer that `npx @forgeyard/shipline init` in a terminal offers the interactive choices.

### E. Setup UI

- `packages/cli/src/ui/setup.mjs` (**modify**):
  - `GET /api/setup` returns the new `agents` and `skills` shapes;
  - `POST /api/setup/workflows` gains `create`;
  - add `POST /api/setup/agents` with preview and apply (see API changes).
- `packages/cli/src/ui/server.mjs` (**modify**): register `POST /api/setup/agents`.
- `packages/ui/src/lib/types.ts` (**modify**): the `SetupData.agents` and `skills` shapes, `AgentsChange`, `Change` (the new `status`, `additions`, `deletions`), and `WorkflowAction` with `create`.
- `packages/ui/src/lib/api.ts` (**modify**): `createWorkflow` and `agentsPreview` / `agentsApply`.
- `packages/ui/src/pages/setup/setup-page.tsx` (**modify**): a "+ New workflow" button at the top of the workflow list, and the new Agents & skills section in the Setup navigation.
- `packages/ui/src/pages/setup/new-workflow-dialog.tsx` (**create**): asks for an id (validated `^[A-Za-z0-9_-]+$`) and a name, then calls `create`, and selects the new workflow on success.
- `packages/ui/src/pages/setup/agents-skills.tsx` (**create**):
  - Shipline agent toggles, saved through the preview diff and confirm;
  - a repo skills checklist, saved into `config.yml` through the existing save flow.
- `packages/ui/src/pages/setup/stage-editor.tsx` (**modify**): the agent picker lists the installed Shipline agents and the repo's agents in two groups, plus "None".
- `packages/ui/src/pages/setup/config-form.tsx` (**modify**): keep `skills` out of the general config fields, since the Agents & skills section owns it.

### F. Changes view

- `packages/cli/src/ui/tasks.mjs` (**modify**): build `changes[]` with `status` and `additions`/`deletions` from `git diff --numstat HEAD` plus untracked numstat, as in API changes. Repos with no commits use `--no-index` for every file.
- `packages/ui/src/components/changes-view.tsx` (**create**):
  - **The tree:** files grouped by folder in a collapsible tree. Each file row shows the status icon, colour and word, the file name, and `+N −M`.
  - **Expanding:** a row expands inline to `<DiffView>`, loaded lazily from `/api/file?mode=diff`.
  - **Empty state:** "No changes".
  - **Errors:** a failed diff load shows an inline error with a retry.
  - **Used by** the Tasks page, the chat panel's Changes tab and the Setup save dialog (fed from the preview's diffs instead of `/api/file`).
- `packages/ui/src/components/diff-view.tsx` (**modify**): unified only. The container gets `overflow-x-auto min-w-0`, lines are `whitespace-pre`, and the gutter stays sticky on the left. This fixes the overflow in the author's screenshot.
- `packages/ui/src/components/task-panel.tsx` (**modify**): remove the old `ChangesList`; the canvas Changes tab and `TaskPanel` use `ChangesView`.
- `packages/ui/src/pages/tasks/tasks-page.tsx` (**modify**): use `ChangesView`.
- `packages/ui/src/pages/setup/save-dialog.tsx` (**modify**): show the per-file diffs with `ChangesView`'s tree and diff rendering. Every file in the save is `modified`, or `added` for a new workflow, and the line counts come from the preview's diff hunks.
- `packages/ui/src/components/file-viewer.tsx` (**modify**): remove the diff mode (artifacts only). Diffs live in `ChangesView` now.
- `packages/ui/src/index.css` (**modify**): add the tokens `--change-added`, `--change-modified`, `--change-deleted` and `--change-renamed` for light and dark, exposed through `@theme inline`.

### G. Chat layout and questions

- `packages/ui/src/pages/chat/chat-page.tsx` (**modify**):
  - **Wide screens (≥ 1200 px):**
    - replace the always-split layout with a centered chat column (max width about 760 px) plus the panel;
    - the panel slides in from the right over about 250 ms (ease-out) on its `ResizablePanel`;
    - the centered column moves left by half the panel's width, with the same easing, and keeps its width.
  - **Narrow screens:** the panel is an overlay `Sheet`.
  - **Opening:** the panel opens automatically when the chat gets a task, through the existing `task` event or a `task_dir` already set. A header toggle button closes and reopens it.
  - **Reduced motion:** when the user prefers reduced motion, there's no animation.
- `packages/ui/src/pages/chat/canvas-ribbon.tsx` (**delete**): replaced by the overlay sheet.
- `packages/ui/src/pages/chat/question-card.tsx` (**modify**):
  - **Tabs:** one tab per question (label = `header`, or `Q{n}`), plus a final "Submit" tab that lists every answer. Unanswered questions are marked, and Send stays disabled until all are answered.
  - **Moving between tabs:** answering a single-select question moves to the next tab. Multi-select questions have a "Next" button.
  - **Keyboard:** ←/→ switch tabs, 1–9 pick an option, and Enter goes to the next tab or submits.
  - **What's kept:** "Other", Skip (deny) and the request format sent to `POST /api/prompts/<id>`.

### Tests (kept green; CI is the merge gate)

- `packages/cli/test/uninstall.test.mjs` (**create**):
  - removes everything listed in scope A from a fresh `init`;
  - keeps `excluded` files;
  - the `CLAUDE.md` and `settings.json` edits keep the team's other content;
  - `--dry-run` writes nothing;
  - `--yes` keeps the store, and `--yes --purge` removes it;
  - refuses with no terminal and no `--yes`, while the lock is held, and when Shipline isn't installed;
  - works on a legacy install with no `VERSION`, using the fixture in `test/fixtures/legacy-0.6`.
- `packages/cli/test/init-interactive.test.mjs` (**create**):
  - **Existing install:** `init` (interactive or `--yes`) prints "already initialized" and writes nothing.
  - **`--yes` summary:** lists the kept clashes.
  - **Selection logic,** with the prompts module stubbed through an injected function: chosen workflows and agents only, all three clash outcomes, replacing a stage's agent, writing `skills`, `VERSION.excluded`.
  - **`--yes` defaults.**
  - **Refusing** with no terminal.
- `packages/cli/test/init-version.test.mjs`, `upgrade.test.mjs` and `setup-schema.test.mjs` (**modify**):
  - `excluded` is kept and skipped;
  - the `skills` field;
  - the `small.yml` template round-trips;
  - `init` now runs with `--yes` in tests that don't have a terminal.
- `packages/cli/test/helpers.mjs` (**modify**): `runInit` passes `--yes` by default.
- `packages/cli/test/ui/setup.test.mjs` and `tasks.test.mjs` (**modify**):
  - `POST /api/setup/agents`: `remove` on a kept team agent returns 400 `not-shipline` and leaves the file; `add` on it replaces the file and moves the path from `excluded` to `files`;
  - workflow `create` (ok, `exists`, `invalid`);
  - `POST /api/setup/agents` (preview, apply, `excluded` updated, 409 `changed`);
  - the new `changes[]` shape with `status` and line counts, including untracked and binary files.
- `packages/cli/test/publish.test.mjs` (**modify**): the dependency list now has exactly `@inquirer/prompts`, and the `small.yml` template is included in the package.

## Behavior & Edge Cases

- **Uninstall on a repo whose `.claude/settings.json` isn't valid JSON:** stop before changing anything ("fix .claude/settings.json first"), the same way `init` does today.
- **Uninstall when the team removed the `CLAUDE.md` markers by hand:** that step is skipped and the preview says so.
- **Uninstall while a Claude session is running in the repo:** allowed. Only the UI lock blocks it. That session's hooks will fail open with a visible warning until it's restarted, and the uninstall summary says so.
- **Interactive `init`, team deselects every workflow:** not allowed. At least one workflow is required, and the checkbox enforces it.
- **Interactive `init`, team deselects every agent:** allowed. Stages that suggest an agent then go through the "missing agent" prompt.
- **Missing-agent choices are computed after the clash decisions.** A "skip" clash counts as missing; a "keep yours" clash counts as present.
- **`skills` naming a deleted skill:** shows a Setup warning and is still printed by `stage.mjs`. Claude reports it if it can't find the skill.
- **"+ New workflow" with an id that already exists:** 409, shown inline in the dialog.
- **Agents & skills, removing an agent that a stage uses:** the preview lists the affected stages. The save goes ahead, and those stages show "agent not installed" in the stage editor until changed.
- **Changes view:**
  - **Binary files** show "binary" instead of line counts, and their diff area says "Binary file, no preview".
  - **A diff over 3000 lines** is truncated, with a note (existing server behaviour).
  - **A deleted file's** diff shows all lines removed.
  - **A renamed file** shows `old → new`.
- **Chat panel:**
  - **Window resized across 1200 px:** the layout switches between side-by-side and overlay. The message list and the composer draft must not remount: keep them in one component tree and only swap the panel container. This fixes the draft loss known from the redesign.
  - **A task starts while the panel was closed by hand:** the panel stays closed. Opening automatically only happens if the user hasn't closed it in this chat.
- **Question tabs:**
  - **A single question** shows no tab bar, just the question and Send.
  - **A prompt resolved elsewhere** (timeout, or another tab) removes the card, as today.

## Constraints

- **Node versions:** the vendored hooks stay dependency-free and run on Node 18. `@inquirer/prompts` is loaded only on `init`'s interactive path.
- **Package version:** stays 0.7.0. It's unpublished, so `INTERFACE` stays 3. `known-hashes.json` is regenerated for 0.7.0 after the template changes.
- **The UI bundle** must stay under the 400 KB gzip budget. No new UI dependencies: the animation uses CSS transitions and Tailwind.
- **Accessibility:** tabs use the ARIA tab pattern (Radix `Tabs`). Status icons have text labels. Animations respect reduced motion.

## Verification

1. **On `~/Projects/pocs/brown-bg-tracker`:**
   1. `shipline uninstall --dry-run` lists every Shipline file, the `CLAUDE.md` block and the settings entries.
   2. `shipline uninstall` asks about the task data. Afterwards, `git status` and a search show no Shipline files, hook entries or allow rules, and the `.env` deny rules are still there.
   3. `shipline init` (interactive) offers workflows, agents, clashes and repo skills. Picking a subset installs only that subset, and `VERSION` records `excluded`.
2. **Click through `shipline ui` on that repo:**
   - the chat is centered, and the panel slides in when Claude starts a task;
   - resizing the window across 1200 px keeps the composer draft;
   - an AskUserQuestion with two or three questions shows tabs, then a Submit tab, and keyboard navigation works;
   - the Tasks page and the chat Changes tab show the folder tree, labels and line counts, and inline diffs scroll horizontally inside their box;
   - the Setup save dialog uses the same view;
   - "+ New workflow" creates a workflow;
   - the Agents & skills section adds and removes an agent and saves skills.
3. `cd packages/cli && npm test`, the UI type check and the CI workflow are green.

## Open Questions

- The exact `@inquirer/prompts` major version to pin. The builder uses the latest stable version at build time and records it here. **Pinned: `^8.7.5` (major 8, resolved 8.7.5, 2026-11-04).** Its `engines` are Node `^20.17 || ^22.13 || >=23.5`, so interactive `init` needs Node 20.17+; on Node 18 the prompts fail to load and `init` says to use `--yes`. `--yes`, `upgrade`, `uninstall` and the hooks stay on Node 18.
- "Claude decides when a change is small" depends on the skill's wording. If Claude picks Small change too often or too rarely in practice, the examples in `shipline-workflow/SKILL.md` will need tuning.
- **Accepted from the plan re-review (optional items, not blocking):**
  - **Merge helpers:** the existing settings and `CLAUDE.md` merge helpers live in `init.mjs`. `isShiplineHookEntry` and `HOOK_MARK` are in `hashes.mjs`. The new inverse helpers go in `hashes.mjs` and may import from either.
  - **`server.mjs`:** it already spreads `...setupRoutes(app)`, so the new agents route needs no change in `server.mjs` if it's added inside `setup.mjs`.
  - **Renames in numstat:** builder default is `git diff --numstat -M -z HEAD`. With `-z`, a rename record is `adds\tdels\t\0old\0new`, so `oldPath` comes from that record.
  - **`git diff --no-index`** exits with code 1 when there are differences. That's success, not an error.
  - **Prompt stubbing in tests:** `runInit` accepts an optional `prompts` function in-process. Tests inject a stub that returns a selection object.
  - **Missing-skill warning:** shown in the Agents & skills section next to that skill's name, and in `setup-schema` validation warnings.
  - **Repo-skills line at every stage:** accepted, though it adds some noise.
