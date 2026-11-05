# Setup wizard: install Shipline from the browser, writing only the files a team chose

**Status:** Approved
**Requested:** 2026-11-05, by the author: "i want the init setup to be also done on the ui and we should not directly add all the files, the files should be only added after the setup so that only the required files are added".
**Release:** 0.12.0, on a new branch from `main`. Planned before Teams Phase 3 (see `docs/plans/shipline-teams-roadmap.md`). Phase 5's plugin distribution builds on it.

## Problem & Goal

The browser UI only works on a repo that's already installed: `shipline ui` (`src/ui/repo.mjs`) looks for `.shipline/config.yml` and stops with "No Shipline setup found here. Run `npx @forgeyard/shipline init` first."

Installing happens in the terminal.
- Interactive `init` already lets the developer choose workflows, agents, skills, commands, tracker and the CI check, and writes only those workflows and their stages' rules.
- `init --yes` writes everything.
- Even an interactive install writes agents no chosen workflow uses, and the wireframes pieces in repos without a UI.

**Goal:**
- A developer can install from the browser through a short wizard.
- Nothing is written until they press Install.
- Only the files their choices need are written.
- Teams can add a shipped workflow later from Setup.

**Done when** (author's criteria):
1. **Install from the browser:** `shipline ui` in a repo without Shipline opens the wizard. After Install, the normal UI opens on the installed repo, without restarting the command.
2. **Only chosen files:** a Bugfix-only install in a repo without a UI has:
   - no Feature workflow, no wireframes rules, and no `wireframe-proposer` or `planner` agent;
   - no `reviewer` unless picked;
   - no `.github/workflows/shipline.yml` unless the CI check was picked.
3. **Same result as the terminal:** the same answers in the wizard, interactive `init` and `init --yes` produce byte-identical files. `--yes` uses detection for "has a UI".
4. **Nothing written early:** opening the wizard, moving through its steps, previewing, or closing it writes nothing to the repo or the store.

## Scope

### In

**A. One install module, shared by the terminal and the browser**

- **A new module.** The selection and planning logic in `src/init.mjs` moves into **`src/install.mjs`** (create), so `init` and the UI server use the same code. It exports:
  - `installInfo(root)` → `{ workflows, agents, repoAgents, repoSkills, detected, trackerDefault, uiDetected, agentUse, state }`.
    - `agentUse` maps each shipped agent to the stages that use it.
    - `state` is one of:
      - `'installed'`: `.shipline/config.yml` exists;
      - `'partial'`: no config, but the CLAUDE.md `<!-- shipline:start -->` block or Shipline's hooks in `.claude/settings.json` are found. These are the same checks `init` uses today (`claudeMd.includes(START)`, `hasShiplineHooks`).
      - `'clean'`: none of these.
    - `found: ('claude-md-block' | 'hooks')[]` lists what a partial install has. The wizard's message names them, as "the CLAUDE.md block" and "Shipline's hooks".
    - **Terminal `init`** keeps today's behaviour for both `installed` and `partial`: "already initialized", with nothing written.
  - `defaultSelection(info)`.
  - `checkSelection(info, selection)`.
  - `planInstall(root, info, selection)` → `{ writes: [{ to, data, overwrite? }], settings: { before, after }, claudeMd: { before, after }, excluded, collisions }`, which reads files but writes nothing.
  - `applyInstall(root, plan, { base })`, which writes everything with the existing rollback (temp files, `wx`, and VERSION written last), after the re-check in scope F.
- **`init.mjs` becomes a thin wrapper** around these: the prompts, `--yes`, `--dry-run`, and the messages. Its terminal output and exit codes stay as they are today, except for the new questions below.

**The selection object.** It's used by `install.mjs`, the API bodies and the UI's `InstallSelection`:

```
{
  workflows: string[],                          // at least one shipped workflow id
  ui: boolean,
  agents: string[],                             // shipped agent names to install
  clashes: { [agent]: 'keep' | 'ours' | 'skip' },  // only for names the repo already has
  stageAgents: { ['<workflow>.<stage>']: string | null },  // replacement agent, or null for none
  skills: string[],                             // the repo's own .claude/skills names
  commands: { test: string, lint: string, build: string },
  tracker: 'jira' | 'github',
  ci: boolean
}
```

- **The API** (`POST /api/install/preview` and `POST /api/install`) requires every field. A missing or wrong-typed field gives 400 `invalid`, from `checkSelection`.
- **Terminal `init`** fills missing fields from `defaultSelection(info)`, as it does today.

**B. What gets trimmed** (the same in the wizard, interactive `init` and `--yes`)

- **The selection gains `ui: boolean`.** `uiDetected` from the new `src/detect-ui.mjs` gives the default, and the developer can change it.
  - **Detection** reads only files and runs nothing. `true` when either:
    - root `package.json` dependencies or devDependencies include `react`, `vue`, `svelte`, `@angular/core`, `next`, `nuxt`, `solid-js`, `preact`, `astro` or `@remix-run/react`;
    - a `.html`, `.jsx`, `.tsx`, `.vue` or `.svelte` file exists within 4 folder levels of the root, excluding `node_modules`, `.git`, `dist`, `build` and `vendor`, and scanning at most 5 000 entries.
  - **With `ui: false`,** stages with `condition: ui_only` (today Feature's `wireframes`) are removed from the written workflow text, with their whole stage block.
    - **How:** the text is edited line by line, like `applyStageAgents`, and the YAML is never re-emitted, so comments and layout are kept.
    - **A stage block** runs from its `  - id: <stage>` line up to, but not including, the next line matching `^  - id:` at the same indent, or the end of the file. The whole block is removed, including comment lines inside it.
    - **Comments above the `stages:` list** (the file header) are kept.
    - **Which stages are `ui_only`** is read from the parsed template, and the text edit removes those ids. Their rules files aren't written, because rules follow the stages that remain.
- **Agents:**
  - **Stage agents** (named by a stage of the shipped workflows, such as `researcher`, `planner`, `wireframe-proposer`, `builder` and `qa-bug-hunter`) are selected by default only if a stage that remains in a chosen workflow uses them. The developer can still tick others.
  - **Standalone agents** (not named by any shipped stage; today `reviewer`) are listed, **off by default**.
  - Every shipped agent that isn't installed goes into `VERSION.excluded`, as deselected agents do today, so `upgrade` doesn't add it.
- **The CI workflow** is written only when `ci: true`, as today.
- **Effect on `--yes`:** it uses `ui: uiDetected`, stage agents only for the chosen (all) workflows, and no standalone agents. That's a change from today's "everything", noted in its final message.
- **Interactive `init`** asks one more question after workflows: "Does this repo have a UI? (detected: yes/no)". It drops agents from the defaults as above, and shows a standalone section for `reviewer`.

**C. The browser entry point**

- **Install mode.** `shipline ui [dir]` in a folder with no `.shipline/config.yml` above it starts the server in **install mode**.
  - **Install root:** the git root of `dir` (`git rev-parse --show-toplevel`), or `dir` itself when it isn't in a git repo. The wizard then shows a note: "This folder isn't a git repository. Shipline works best in one."
  - **Same server safeguards:** the same server, the same 127.0.0.1-only binding, the same token-to-cookie exchange, and the same Host and Origin checks.
  - **No log, no store.** Nothing is written while in install mode: there's no UI log file and no store folder. Errors are printed to the terminal only.
- **`init` in a terminal (interactive, not `--yes`) first asks:** "Set up here in the terminal, or in the browser?"
  - "Browser" starts `shipline ui` on the same folder (as if `shipline ui` had been run), and `init` exits when the server stops.
  - It's offered only when Node is 20 or newer, which the UI needs. Otherwise it's skipped silently.
- **`state` other than clean:**
  - **`'partial'`:** the wizard shows "Shipline is partly installed here (found <the items in `found`>). Run `npx @forgeyard/shipline uninstall`, then set up again." It has no Install button.
  - **`'installed'`:** the normal mode starts, so this can't happen.

**D. The wizard (browser)**

- **A single page** with a step list on the left, styled like the existing Setup page (shadcn). The steps are below.
  1. **Workflows:**
     - checkboxes for the shipped workflows, with name and description; at least one is required;
     - "Does this repo have a UI?" (a switch, with "detected: yes/no");
     - each Feature stage that the answer removes is shown struck through.
  2. **Agents & skills:**
     - stage agents, each with "used by: Feature → Plan, …" and greyed when nothing chosen uses it;
     - standalone agents (off by default);
     - for each name clash with the repo's own agent: keep yours, use ours, or skip (default keep);
     - when a chosen stage's agent isn't selected: pick a replacement from the repo's own agents, or none, as the terminal does today;
     - the repo's own skills, as checkboxes.
  3. **Commands & tracker:**
     - test, lint and build, pre-filled from detection with "(from package.json)" hints, and editable;
     - tracker: Jira or GitHub Issues, defaulting to the remote-based choice.
  4. **CI check:** "Add a pull-request check" (default off), with one line on what it does.
  5. **Review:**
     - every file to be created (path, and a "view" link to its text);
     - every file to be overwritten ("use ours" clashes);
     - unified diffs for the two merged files, `.claude/settings.json` and `CLAUDE.md`;
     - the list of excluded agents;
     - any collisions block Install, with the message from today's `init`;
     - an **Install** button.
- **Moving between steps** recomputes nothing on the server, except the Review step, which calls preview.
- **Leaving or closing** the page writes nothing.
- **After Install succeeds,** the page shows "Installed. Opening Shipline…" and reloads. The server is now in normal mode (scope F), so the reload opens the normal UI, which shows the existing "default rules" banner offering **Set up with Claude**.

**E. API (install mode only, except `/api/status`)**

- **`GET /api/status`:**
  - In install mode it returns `{ mode: 'install', root, state, uiVersion }`.
  - In normal mode it gains `mode: 'repo'`. Everything else is unchanged.
- **`GET /api/install/info`** returns `installInfo(root)`, minus file contents. Workflows are `{ id, name, description, stages: [{ id, name, agent, condition }] }`, and agents are `{ name, description, usedBy: ['<wf>.<stage>'] }`.
- **`POST /api/install/preview`** takes `{ selection }` and returns:
  - `files: [{ path, action: 'create' | 'overwrite' | 'merge', text?, diff? }]`. `text` is given for create and overwrite. `diff` (hunks in the existing `DiffHunk` shape) is given for merge.
  - `excluded`;
  - `collisions`;
  - `base: { settings: <sha256 | null>, claudeMd: <sha256 | null> }`, the hashes of the current merge targets.
  - A 400 `invalid` error carries the `checkSelection` message.
- **`POST /api/install`** takes `{ selection, base }`. It re-plans and re-checks (scope F), applies, then switches the server to normal mode. It returns `{ installed: true }`.
  - **Errors:**
    - 409 `changed`: a merge target's hash differs from `base`;
    - 409 `collision`: a path to create now exists;
    - 409 `installed`: something else installed in the meantime;
    - 500 `install-failed`, after rollback, with the error message.
- **Every other `/api/*` route** returns 409 `not-installed` while in install mode. Static files are served normally.

**F. Writing safely, and switching to normal mode**

- **The re-check** inside `POST /api/install`, just before writing:
  - `installInfo(root).state` must still be `'clean'`;
  - the plan is rebuilt from the same selection;
  - `sha256` of the current `.claude/settings.json` and `CLAUDE.md` (or null) must equal `base`;
  - no path to create may exist.
  - Any mismatch gives a 409 with nothing written, and the wizard says "The repo changed since you reviewed. Review again." and returns to Review.
- **All-or-nothing:** `applyInstall` keeps today's behaviour. It writes every file with `wx` (or overwrite for "use ours"), then the merges, then VERSION last. It rolls back created files and restores overwritten ones if any write fails.
  - It also creates the store (`storeDir(root)`) first, as `init` does today, and fails before writing anything if the store isn't writable.
- **Switching to normal mode:**
  - The server builds the full app (`resolveRepo`, log, store, hub, prompts, chats, watch, routes) the same way `startServer` does today, via a shared `startRepoMode(app, root)` function.
  - It replaces the install route table with the full one.
  - It keeps the same port, the same auth (so the browser's cookie stays valid) and the same HTTP server.
  - It logs `start` and `installed` events to the new store's `ui.log`.

**G. Setup: "Add a shipped workflow" (installed repos)**

- **On the Setup page's workflow list:** an **Add shipped workflow** action, which lists the shipped workflows the repo doesn't have, plus a "Does this repo have a UI?" switch, defaulting to `uiDetected`.
- **What it adds:** it previews and then saves, writing:
  - the workflow file, with stage agents set to the agents that are present;
  - the rules files for its stages that don't exist yet;
  - any stage agents it needs that aren't installed, which are removed from `VERSION.excluded`, with their hashes recorded in `VERSION.files`.
- **The API:**
  - `POST /api/setup/add-workflow` takes `{ id, ui, baseVersionHash, baseHashes, preview? }`. Its response shapes match `POST /api/setup/agents`: preview gives `{ files }`, and save gives `{ written }`.
  - It uses `planInstall` for the file contents.
  - It returns 409 `exists` when the workflow is already there, and 409 `changed` on a stale base.

### Out

- Uninstalling or re-running the wizard from the browser, and editing choices after install (Setup does that).
- Choosing a different install folder in the wizard.
- `/shipline-setup` inside the wizard. The existing banner offers it afterwards.
- A wizard for upgrading an older install (`upgrade` stays a terminal command).
- Plugin and marketplace packaging (roadmap Phase 5).

## Surface Area

- **CLI:**
  - the new `src/install.mjs` and `src/detect-ui.mjs`;
  - `src/init.mjs` slimmed down;
  - `src/init-prompts.mjs` (the browser-or-terminal question and the UI question, with standalone agents off by default);
  - `bin/shipline.mjs`, if `init` needs to start the UI.
- **UI server:**
  - `src/ui/server.mjs` (install mode, `startRepoMode`, the swappable route table);
  - the new `src/ui/install-routes.mjs`;
  - `src/ui/repo.mjs` (returns no-repo cleanly);
  - `src/ui/diagnostics.mjs` (`mode` in status);
  - `src/ui/setup.mjs` (add-workflow).
- **Browser UI:**
  - the new `pages/install/` wizard;
  - `app.tsx` (renders the wizard in install mode);
  - the Setup page's add-workflow dialog;
  - `lib/api.ts` and `lib/types.ts`.
- **Data:** the selection gains `ui`. There are no new config or manifest fields. `VERSION.excluded` now also lists trimmed agents. `INTERFACE` stays 5, because the hooks are unchanged.
- **Behaviour change:** `init --yes` no longer installs every agent and stage.

## Files to Touch

- `packages/cli/src/install.mjs` (**create**): `installInfo`, `defaultSelection`, `checkSelection`, `planInstall` and `applyInstall`, moved from `init.mjs` and extended for `ui`, agent trimming, the `state` check and the base re-check.
- `packages/cli/src/detect-ui.mjs` (**create**): `detectUi(root)` → `{ ui: boolean, source }`, as in scope B.
- `packages/cli/src/init.mjs` (**modify**):
  - uses `install.mjs`;
  - the browser-or-terminal question for interactive runs on Node 20+;
  - the `--yes` message notes trimmed agents and stages.
- `packages/cli/src/init-prompts.mjs` (**modify**):
  - the "Does this repo have a UI?" question;
  - the stage-agent defaults from `agentUse`;
  - a standalone agents section, off by default;
  - the browser-or-terminal question.
- `packages/cli/bin/shipline.mjs` (**modify**, only if needed): lets `init` hand off to the UI server.
- `packages/cli/src/ui/repo.mjs` (**modify**): `resolveRepo` keeps throwing `NO_REPO`. A new `installRootFor(dir)` returns the git root, or `dir`.
- `packages/cli/src/ui/server.mjs` (**modify**):
  - install mode on `NO_REPO`, instead of `fail`;
  - `startRepoMode(app, root)` factored out of `startServer`;
  - a swappable route table;
  - status `mode`;
  - the switch after a successful install.
- `packages/cli/src/ui/install-routes.mjs` (**create**):
  - `GET /api/install/info`, `POST /api/install/preview` and `POST /api/install`;
  - the 409 `not-installed` fallback for other API routes in install mode.
- `packages/cli/src/ui/diagnostics.mjs` (**modify**): `mode` in `GET /api/status`.
- `packages/cli/src/ui/setup.mjs` (**modify**): `POST /api/setup/add-workflow`, with preview and save.
- `packages/ui/src/app.tsx` (**modify**): when `status.mode === 'install'`, render the wizard full-page with no sidebar.
- `packages/ui/src/pages/install/install-wizard.tsx` (**create**): the step list, the steps, Review and Install, with error handling for 409 and 500.
- `packages/ui/src/pages/install/review-step.tsx` (**create**): the file list, text viewer and merge diffs, using the existing `diff-view.tsx` and `file-viewer.tsx`.
- `packages/ui/src/pages/setup/add-workflow-dialog.tsx` (**create**): the add-workflow dialog, with the preview using the existing `save-dialog.tsx` patterns.
- `packages/ui/src/pages/setup/setup-page.tsx` (**modify**): the "Add shipped workflow" action.
- `packages/ui/src/lib/api.ts` and `packages/ui/src/lib/types.ts` (**modify**): `installInfo`, `installPreview`, `install` and `addWorkflow`, plus the types `InstallInfo`, `InstallSelection`, `InstallPreview` and `Status.mode`.
- `packages/cli/package.json` (**modify**): 0.12.0.
- `README.md` (**modify**): installing from the browser, what gets trimmed, `--yes` defaults, and Add shipped workflow.
- `docs/plans/shipline-teams-roadmap.md` (**modify**): add a note that the setup wizard ships before Phase 3.

### Tests (written separately, listed here)

- **`test/install.test.mjs` (create):**
  - `planInstall` for various selections;
  - Bugfix-only with `ui: false` writes no Feature workflow, wireframes rules, `wireframe-proposer` or `planner`;
  - `reviewer` is off by default;
  - excluded agents are recorded;
  - `ui: false` removes `ui_only` stages from the workflow text;
  - **byte-identical output** for the same selection through `init` (prompts stubbed), `init --yes` (with `ui` detected) and `applyInstall`;
  - `state` is clean, installed or partial;
  - the base re-check (changed and collision);
  - rollback on a failing write.
- **`test/detect-ui.test.mjs` (create):** each framework dependency; UI files at depth 4 and not at depth 5; ignored folders; the 5 000-entry cap; a broken `package.json`.
- **`test/init*.test.mjs` (modify):**
  - the new questions;
  - `--yes` trimming and its message;
  - the browser option is offered only on Node 20+ and interactive runs;
  - an unchanged dry-run format.
- **`test/ui/install.test.mjs` (create):**
  - install mode starts in a clean repo, using the git root when run from a subfolder;
  - status `mode: 'install'`;
  - other API routes return 409 `not-installed`;
  - info, preview (files, merge diffs, base hashes);
  - nothing is written to the repo or the store by info or preview;
  - install, then status `mode: 'repo'` with the full routes working on the same port and cookie;
  - the 409 `changed`, `collision` and `installed` paths;
  - a partial install shows `state: 'partial'`.
- **`test/ui/setup.test.mjs` (modify):** add-workflow preview and save (workflow, missing rules, missing agents un-excluded, VERSION updated); 409 `exists`; a stale base.

## Behavior & Edge Cases

- **Two browser tabs on the wizard, both pressing Install:** the second gets 409 `installed`, and its page reloads into normal mode.
- **Someone runs `init` in a terminal while the wizard is open:** Install gets 409 `installed` (or `changed`), and the page reloads.
- **The repo has its own `.claude/agents/planner.md`, and Feature isn't chosen:** there's no clash question for `planner`, because it isn't being installed. It's recorded as excluded, as today.
- **No workflow left with any stage agent** (an edge case with custom choices): fine, and no stage agents are installed.
- **Not a git repo:** install proceeds at `dir`, with the note shown. The fingerprint and CI features later return null, as designed in Phase 2.
- **`SHIPLINE_HOME` isn't writable:** Install fails before writing anything, with the store error, as `init` does today.
- **Windows:** paths come from `path.join`, git root detection uses `execFileSync`, and the diffs use the existing EOL handling for CRLF files.

## Constraints

- **No new dependencies.** The UI uses existing shadcn components only.
- **Nothing is written** to the repo or `~/.shipline` before Install succeeds, and that includes the UI log.
- **The terminal flow is unchanged** apart from the new questions and the `--yes` trimming. `--dry-run` still lists what would be written.

## Verification

1. **A fresh repo:** in a fresh Node repo without React, run `npx @forgeyard/shipline ui`.
   - The wizard opens.
   - Choose Bugfix only, keep the UI switch off, and leave the CI check off.
   - Review lists only Bugfix's files and its stages' rules and agents, with diffs for `settings.json` and `CLAUDE.md`.
   - Close the tab: `git status` is clean, and `~/.shipline` has no entry for the repo.
2. **Install:** reopen and press Install.
   - The page reloads into the normal UI.
   - `git status` shows exactly the files from Review.
   - There's no `wireframe-proposer`, `planner` or `reviewer`.
3. **Add a workflow:** in Setup, Add shipped workflow → Feature, with the UI switch on. It adds `feature.yml`, its missing rules, and `researcher`, `planner` and `wireframe-proposer`.
4. **The terminal matches:** run the same choices through interactive `init` in a copy of the repo. The files are identical (`diff -r`).
5. **Tests:** the suite and CI are green on all three operating systems.

## Open Questions

- **The `--yes` change** (no standalone agents, and no wireframes in repos detected as non-UI) changes what existing scripts get. That's intended, but call it out in the release notes.
- **UI detection is a heuristic.** The developer confirms it in the wizard and in interactive `init`, but `--yes` trusts it.
- **Switching to normal mode in-process** reuses the auth and port. If that proves fragile, the fallback is to restart the server process on the same port, which is more complex because of the port and cookie.
