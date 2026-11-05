# Review: shipline-setup-wizard

## 1. Verdict
Ready after must-fixes (3 must-fix items).

## 2. Paraphrase

**What the plan proposes.** Today the browser UI refuses to start in a repo without `.shipline/config.yml`. The plan adds an "install mode" to `shipline ui`. A wizard collects choices (workflows, a has-UI flag, agents and skills, commands and tracker, CI check), and shows a Review step. Nothing is written until the user presses Install. The selection and planning logic from `init.mjs` moves into a shared `install.mjs`, so the terminal and the browser produce byte-identical files. The output is also trimmed: with `ui: false`, `ui_only` stages are cut from the workflow text, and agents are installed only if a remaining stage uses them. `reviewer` is off by default, and every agent not installed goes into `VERSION.excluded`. After a successful install the same server swaps its route table to normal mode, keeping the port and cookie. Interactive `init` gets a "terminal or browser?" question and a UI question. `init --yes` now installs fewer things. Setup also gets an "Add shipped workflow" action.

**How the existing system works, according to the plan.** `shipline ui` calls `resolveRepo`, which throws `NO_REPO` when there is no config, and the server then stops with a message. `init.mjs` holds the selection and planning code, and writes via temp files, `wx` and VERSION last, with rollback. Interactive `init` already lets the user choose workflows, agents, skills, commands, tracker and CI. `--yes` writes everything. The UI server builds the full app (log, store, hub, prompts, chats, watch, routes) in `startServer`. Setup's `POST /api/setup/agents` has preview and save shapes that add-workflow copies.

## 3. Must-fix

1. **The `selection` object has no defined shape** (Scope A, B, D, E). `defaultSelection`, `checkSelection`, `planInstall`, the preview and install POST bodies and `InstallSelection` all take it. The plan only says it "gains `ui: boolean`". The builder has to invent the fields for these choices:
   - workflows
   - agents
   - standalone agents
   - per-clash keep, use-ours or skip
   - replacement agent per stage
   - skills
   - commands
   - tracker
   - ci

   The existing shape in `init.mjs` may be reusable. If so, the plan should say "unchanged apart from `ui`" and list it. Fix: write the `InstallSelection` field list, or point to the existing shape explicitly.

2. **Trimming `ui_only` stages from workflow text is under-specified** (Scope B). Workflow files are YAML templates with comments (`templates/shipline/workflows/feature.yml`). The plan says to remove "the whole stage block" from text, but gives no rule for what counts as the block (comments above it, blank lines) or what happens to other fields that may reference the stage. It also gives no rule for how this combines with `applyStageAgents`. Byte-identical output across the three paths depends on one deterministic implementation. Fix: state the block boundary rule (for example, "from the `- id:` line to the line before the next `- id:` at the same indent, including leading comments"), or say the stage is removed by parse and re-emit using the existing yaml-emit code. Say which one.

3. **`installInfo.state: 'partial'` is not specified well enough** (Scope A, C). The plan says "partial" means only hooks or the CLAUDE.md block were found. It does not say how that is detected. The message needs a "<what>" value, but `installInfo`'s return shape has no field for it. It also does not say what terminal `init` does today or should do in that state. Fix: add a `partialFound: string[]` field and the detection rule, and say whether `init` is unchanged.

## 4. Optional (non-blocking)

- Scope F relies on a `startRepoMode(app, root)` function and a swappable route table without describing how `startServer` is structured today. The Open Questions section covers the risk. A test that makes concurrent requests during the swap would be worth adding.
- `GET /api/install/info` returns "`installInfo(root)` minus file contents", but the exact field list isn't given for `repoAgents`, `repoSkills`, `detected` and `trackerDefault`. The builder can infer it from the shapes needed in the wizard, but a TypeScript type in the plan would remove the guessing.
- Scope G's `baseVersionHash` and `baseHashes` are defined only by reference to `POST /api/setup/agents`. That is acceptable if those fields exist there. Confirm they do.
- Scope G's "Does this repo have a UI?" switch affects whether `ui_only` stages are included in a newly added workflow. That depends on the same trimming rule as must-fix 2.
- The `--yes` change is a breaking behaviour change in a minor release. The plan notes release notes. Consider whether a flag (`--all`) should restore the old behaviour.
- The scan cap for detection (5 000 entries) does not say what order the scan runs in. Depth-first and breadth-first give different results when the cap is hit.
- The plan lists `bin/shipline.mjs` as "only if needed". Decide now. The `init` to `ui` handoff can import the UI start function directly, so it is probably unneeded.

## 5. Files-to-touch check

- The following "modify" paths exist (checked with Glob): `packages/cli/src/init.mjs`, `init-prompts.mjs`, `ui/repo.mjs`, `ui/server.mjs`, `ui/diagnostics.mjs`, `ui/setup.mjs`, `packages/ui/src/app.tsx`, `pages/setup/setup-page.tsx`, `pages/setup/save-dialog.tsx`, `components/diff-view.tsx`, `components/file-viewer.tsx`, `lib/api.ts` and `lib/types.ts`.
- I did not check `bin/shipline.mjs`, `package.json`, `README.md` or the test files. The new files are correctly marked create.
- Nothing the plan describes is missing from the list. `packages/ui/src/pages/diagnostics.tsx` consumes `/api/status`. If `Status.mode` changes how that page types its data, it may need a touch, but this is likely only in `types.ts`.
- Not listed: whichever file holds the workflow templates or stage-removal logic (see must-fix 2). It would go in `install.mjs` or in a yaml-emit helper. Say which.
