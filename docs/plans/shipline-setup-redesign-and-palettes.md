# Setup redesign (task hub) and selectable palettes

**Status:** Approved
**Release:** 2.1.0, together with `docs/plans/shipline-guardrails-2-1.md`, on one branch from `main` (e.g. `feat/2-1`). **This plan is built first**; guardrails 2.1 then adds its controls to the new Guardrails page. This plan does not bump the version or write the changelog entry (the guardrails plan's release step does both, and its changelog entry should mention this redesign).
**Target layout:** `.claude/wireframes/setup-redesign/variant-3.html` (Variant 3, "task hub"). Palette tokens: `.claude/wireframes/setup-redesign/palettes.css`. Today's page for comparison: `baseline.html`.

## Revision 1 (2026-11-17): new palette set

After trying the built palettes, the user replaced Ultramarine, Ember and Harbor with simpler ones: **Graphite, Ink, Sage and Mocha**, plus Classic (kept). **Mocha is the default.**
- They have quiet near-neutral surfaces, a light sidebar (no coloured sidebar) and one muted accent each. Preview: `.claude/wireframes/palettes-v2/palettes.html`.
- Ids: `classic`, `graphite`, `ink`, `sage`, `mocha`. An unknown or old id (for example `ember` in an existing preferences file) reads as `mocha`.
- Light blocks are scoped to `[data-palette=x]:not(.dark)`, so they never leak into dark mode.
- Contrast: every text, sidebar, button and guide/warn/block colour is at least 4.5:1 in both modes. Light mode overrides `--stage-done`, `--change-added` (`#2a763c`) and `--stage-skipped` (`#6f6552`) in each new palette; Ink dark overrides `--stage-pending` (`#9e9e9e`).
- The palette names, the coloured sidebar and the contrast table below describe the first set and are superseded by this revision.

## Problem & Goal

Setup is one long page with a section nav, and every workflow stage expands inline into a big form. Users said it is **too long and cluttered**, **hard to find things in**, and **workflow editing is confusing**. The UI also looks generic; the user wants a **bold, branded** look, and wants users to **pick from a set of palettes** rather than one fixed colour.

Success:
- Setup opens on a hub of summary cards; every area is one click away and shows its state at a glance (counts, unsaved, installed).
- A workflow reads as a short list of stages; one stage is edited at a time on its own page, split into steps.
- Back/forward and reload keep the user's place inside Setup.
- Users can choose Classic, Ultramarine, Ember or Harbor; the choice applies to every project on the machine and to paired phones, live.

## Scope

**In**
- Setup restructured into a hub plus focused pages, with hash addresses (layout of Variant 3, desktop and phone).
- Workflow page: read-only stage rows with drag reorder, up/down buttons, delete, Edit, Add stage, and the other workflows.
- Stage page: a 5-step stepper (Basics, Enforcement, Blocks, Required sections, Rules) the user can jump around freely.
- Guardrails, Agents & skills, CI check, Phone access and Project config moved **as-is** (same content and controls) onto their own focused pages.
- An Appearance card on the hub: palette swatches plus light/dark/system.
- Four palettes (Classic = today's indigo, Ultramarine, Ember, Harbor), each in light and dark, applied app-wide through the shared colour tokens, including a branded coloured sidebar.
- A per-machine palette preference: file, API and live event.

**Out**
- Custom palette or colour editor (presets only).
- Per-repo colours.
- New automated UI tests (no UI test framework exists).
- Restyling other pages beyond what the token swap gives them.
- Redesigning the content of Agents & skills, CI check, Phone access and Project config.
- Guardrails 2.1 features (separate plan, built after this one on the same branch).
- Keeping unsaved edits across a reload or after leaving Setup (same as today: they are lost; see Behaviour).

## Surface Area

- **UI (`packages/ui`)**: Setup pages and routes, theme tokens, sidebar styling, an Appearance card, palette loading, and the SSE handler.
- **Server (`packages/cli/src/ui`)**: a new server-wide preferences module (file plus two routes plus an SSE event).
- **Data**: a new file `$SHIPLINE_HOME/ui-preferences.json`. No change to `projects.json` or any repo file.
- **API**: new `GET /api/preferences` and `POST /api/preferences` (server-wide, not under `/api/repos/:repoId/`). No existing request or response changes.
- **Templates**: none. No vendored file changes, so no hash bump.

### Preferences contract

- **File** `$SHIPLINE_HOME/ui-preferences.json`: `{ "version": 1, "palette": "ultramarine" }`.
  - Written atomically (tmp + rename, like `registry.mjs` `writeProjects`), mode 0600.
  - Other keys in the file are kept on write.
- **Palette ids**: `classic`, `ultramarine`, `ember`, `harbor`. Display names: Classic, Ultramarine, Ember, Harbor.
- **`GET /api/preferences`** → `{ palette }`.
  - A missing file, unreadable JSON or unknown palette all return `ultramarine`.
  - Reading never throws, and never rewrites the file.
- **`POST /api/preferences`** with body `{ palette }`:
  - Unknown or missing palette → 400 `bad-request` ("palette must be one of classic, ultramarine, ember, harbor").
  - On success it writes the file, broadcasts the SSE event `preferences` with `{ palette }` to every client, and returns `{ palette }`.
  - Write failure (read-only home) → 500 with message "Could not save the palette (<reason>)".
- **Auth**: same as every other API route. Paired phones may change it; it is cosmetic, and phones already have full Setup access.

## Files to Touch

**Server (`packages/cli`)**
- `packages/cli/src/ui/preferences.mjs`: **create**.
  - `readPreferences()` and `writePreferences(patch)` on `$SHIPLINE_HOME/ui-preferences.json`.
  - `PALETTES` list; `routes(app)` returning the two routes. POST calls `app.hub.send('preferences', { palette })`, which is a server-wide event with no `repoId`, like `projects`.
- `packages/cli/src/ui/projects.mjs`: **modify**. Add the preferences routes to the server-wide route table, next to `/api/projects` (around line 738).
- `packages/cli/test/ui/preferences.test.mjs`: **create**. A small node test (kept; approved by the user):
  - the default when the file is missing or corrupt;
  - a POST round-trip;
  - 400 on an unknown palette;
  - other keys kept on write.

 

**Theme (`packages/ui`)**
- `packages/ui/src/index.css`: **modify**.
  - `:root` and `.dark` stay as Classic (today's colours).
  - Add `[data-palette='ultramarine']`, `[data-palette='ember']` and `[data-palette='harbor']` blocks for light, plus `.dark[data-palette=…]` blocks for dark (next-themes puts `.dark` on `<html>`; the palette attribute goes on `<html>` too).
  - Map the wireframe palette values onto the existing shadcn tokens:
    - background, foreground, card, popover, primary(-foreground), secondary, muted(-foreground), accent(-foreground), border, input, ring, chart-1.
    - Sidebar: `--sidebar` ← the wireframe's `--sidebar` value (same name), `--sidebar-foreground` ← `--side-fg`, `--sidebar-primary` ← `--side-on`, `--sidebar-primary-foreground` ← `--side-on-fg`, `--sidebar-accent` ← a translucent `--side-on` (hover), `--sidebar-accent-foreground` ← `--side-fg`, `--sidebar-border` ← a darker `--sidebar`, `--sidebar-ring` ← `--side-on`.
  - Stage, enforcement, change and notice colours: keep today's values unless the contrast check (Constraints) fails on a palette; then override them in that palette's block only.
- `packages/ui/index.html`: **modify**.
  - An inline script before the app sets `document.documentElement.dataset.palette` from `localStorage['shipline.palette']` (falling back to `ultramarine`, wrapped in try/catch), so the first paint uses the cached palette.
  - The `theme-color` metas stay; the palette hook updates them at runtime.
- `packages/ui/src/lib/palette.ts`: **create**.
  - `PALETTES` (id, name, light/dark swatch colours for the picker).
  - `applyPalette(id)`: sets the `data-palette` attribute, writes the localStorage cache and updates `<meta name="theme-color">` to the palette's background.
  - `usePalette()`: a TanStack Query on `GET /api/preferences` under key `['preferences']`; it applies the server value when it differs from the cache.
  - `useSetPalette()`: a mutation that applies the palette optimistically and reverts with a toast on error.
- `packages/ui/src/lib/events.ts`: **modify**.
  - Add `queryKeys.preferences = ['preferences']`.
  - A `preferences` SSE listener that sets the query data and calls `applyPalette`.
  - Add it to the reconnect invalidation list.
- `packages/ui/src/lib/types.ts`: **modify**. `PaletteId` and `Preferences` types.
- `packages/ui/src/main.tsx` or `app.tsx`: **modify** (whichever already hosts app-wide hooks). Call `usePalette()` once at the app root.
- `packages/ui/src/components/app-sidebar.tsx`: **modify**.
  - Check the sidebar reads well on the coloured `--sidebar` (active item uses `sidebar-primary`, hover uses `sidebar-accent`). Remove any hard-coded colours that ignore the sidebar tokens.
  - Keep the Theme menu. Export `THEMES` as today (now also used by the Appearance card).
- `packages/ui/src/components/mobile-tab-bar.tsx`: **modify only if** it hard-codes colours that clash with the new tokens.

**Routes**
- `packages/ui/src/lib/routes.ts`: **modify**. Extend the `setup` route with a `sub` field:
  ```ts
  export type StageStep = 'basics' | 'enforcement' | 'blocks' | 'sections' | 'rules';
  export type SetupSub =
    | { page: 'hub' }
    | { page: 'workflows' }
    | { page: 'workflow'; workflowId: string }
    | { page: 'stage'; workflowId: string; n: number; step: StageStep }
    | { page: 'guardrails' | 'agents' | 'ci' | 'phone' | 'config' };
  // Route: { kind: 'setup'; repoId: string; sub: SetupSub; draftId: string | null }
  ```
  - `draftId` stays a separate field. `#/setup/<id>/draft/<wid>` parses as `sub: { page: 'hub' }` plus `draftId`.
  - Parse order: the draft pattern first, then the new sub-page patterns, and the bare `^/setup/<id>` catch-all last, so it no longer swallows sub-paths. Unknown sub-paths fall through to the catch-all (the hub). `n` must be a positive integer; an unknown step parses as `basics`.
  - The builders `setupSubHash(repoId, sub)` and the existing `setupHash` / `draftHash` return hash strings. `SetupPage` gets `navigate: (hash: string) => void` (the same `navigate` `app.tsx` already uses) and `sub: SetupSub`.
  - Addresses:
    - `#/setup/<repoId>`: hub.
    - `#/setup/<repoId>/workflows`: workflow list.
    - `#/setup/<repoId>/workflows/<wid>`: workflow page.
    - `#/setup/<repoId>/workflows/<wid>/stages/<n>[/<step>]`: stage page. `n` is the 1-based stage position. `step` is one of `basics|enforcement|blocks|sections|rules`, default `basics`.
    - `#/setup/<repoId>/guardrails`, `/agents`, `/ci`, `/phone`, `/config`: focused pages.
    - `#/setup/<repoId>/draft/<wid>`: unchanged, the draft review over the hub.
  - Add hash builders for each address. Unknown sub-paths parse as the hub.
- `packages/ui/src/app.tsx`: **modify**. Pass the parsed sub-route and a `navigate` callback into `SetupPage`. Page titles follow the sub-page.

**Setup (`packages/ui/src/pages/setup/`)**
- `setup-page.tsx`: **modify**, reduced to the shell.
  - It owns, as today: data and preview queries, `drafts` state, save/discard/reload, dialogs, the draft review, read-only mode and the default-rules call to action.
  - It renders the header (breadcrumb + Back), the sub-page for the current route, and the sticky unsaved bar ("N unsaved: files · Discard · Review and save").
  - The section nav (`AGENTS_KEY`, `CI_KEY`, … keys) and `MobileSettingsRows` are removed. Drafts state stays here so moving between sub-pages keeps unsaved edits.
- `setup-hub.tsx`: **create**. The hub, following Variant 3 screen 1 and phone screen 5:
  - Default-rules banner with "Run setup with Claude" and "Mark done".
  - Draft-ready cards (one per pending draft; each opens `draftHash`).
  - Summary cards:
    - **Workflows**: count, ids, unsaved count, "Describe a workflow".
    - **Guardrails**: "N deny / M ask", protected path count, extra command count.
    - **Agents & skills**: installed count, how many are the user's own.
    - **CI check**: Installed / Not installed and its skip rule.
    - **Phone access**: device count and Tailscale state, from the existing remote query.
    - **Project config**: tracker, plus "· N unsaved".
    - **Appearance**: see below.
  - Every summary is derived client-side from data the page already loads. No new endpoints except preferences.
- `appearance-card.tsx`: **create**.
  - Four palette swatches (light/dark preview chips, name, selected state, `aria-pressed`) using `useSetPalette`.
  - A Light/Dark/System segmented control using `useTheme` and `THEMES`.
  - Caption: "Palette applies to every project on this machine. Light/dark is saved in this browser."
- `workflows-page.tsx`: **create**. The workflow list: rows per workflow (name, description, stage count, unsaved and invalid badges), plus New, Add shipped and Describe a workflow (the existing dialogs).
- `workflow-editor.tsx`: **modify** into the workflow page (Variant 3 screen 2).
  - Header: name and description, "Change with Claude" (the existing designer flow and its unsaved guard), Rename/details (existing fields), Copy and Delete (the existing dialogs).
  - Stage rows, then "+ Add stage" (which opens the new stage's page at the Basics step), then an "Other workflows" chip row.
- `stage-list.tsx`: **modify**. Read-only rows: drag handle (dnd-kit, as today), name, enforcement badge (guide/warn/block colours), confirm, checkpoint and agent tags, up/down buttons, a row menu with Delete, and Edit (which navigates to the stage page). The inline collapsible editor is removed.
- `stage-page.tsx`: **create**. The stage page (Variant 3 screen 3):
  - Breadcrumb `Setup › Workflows › <wf> › <stage>`.
  - Stepper `1 Basics · 2 Enforcement · 3 Blocks · 4 Required sections · 5 Rules`: clickable, current step in the address, Back/Next buttons, "Back to stage list".
  - Steps:
    - **Basics**: id (editable only for fresh stages, as today), name, artifact, description, condition, agent, optional.
    - **Enforcement**: guide/warn/block as three option cards, each with a one-line meaning; plus confirm, checkpoint and run checks; plus the "What <level> does here" explainer.
    - **Blocks**: `BlocksEditor`.
    - **Required sections**: the sections editor.
    - **Rules**: `RulesEditor`.
  - Each step shows an error dot when validation flags its fields.
- `stage-editor.tsx`: **modify**. Split its fields into per-step components that `stage-page.tsx` uses (`StageBasics`, `StageEnforcement`, `StageSections`). Validation and update logic are unchanged. Keep the file as the home of those components (do not delete it, and do not duplicate the logic in `stage-page.tsx`).
- `guardrails-section.tsx`: **modify**. Rendered as the Guardrails page body. No behaviour change; small layout changes only (deny/ask/off as a segmented control per rail, as in screen 4, if the current control isn't one already).
- `agents-skills.tsx`, `ci-check.tsx`, `phone-access.tsx`, `config-form.tsx`, `other-fields.tsx`: **modify only for layout**. Each becomes a focused page body. No functional change.
- `new-workflow-dialog.tsx`, `add-workflow-dialog.tsx`, `save-dialog.tsx`, `draft-review.tsx`: **modify only if needed** for the new navigation. After New, Copy or Add, navigate to the new workflow page; after Discard draft or Save workflow, return to where the user was.

## Behaviour & Edge Cases

**Navigation and unsaved edits**
- Moving between Setup sub-pages keeps unsaved edits, since the drafts state lives in `setup-page.tsx`.
- The unsaved bar shows on every Setup page, and on the phone above the tab bar.
- Leaving Setup (chat, another project) or reloading drops unsaved edits, as today.
- Switching to another project's Setup resets the drafts, as today.

**Stage page addresses**
- Redirects (below) run only once the setup data query has loaded and the drafts are initialised. Until then the page shows its loading state, and it never redirects on half-loaded data.
- Range and existence checks use the stage list **with unsaved edits applied** (the `drafts` workflow), not the on-disk file. So a stage added in this session is reachable at its position. After a reload that stage is gone, and its address redirects to the workflow page, which is consistent with "edits are lost on reload".
- Stage `n` out of range (deleted, reordered from another tab, bad URL): replace the address with the workflow page. An unknown step is treated as Basics.
- Workflow id not found (deleted, renamed, bad URL): replace the address with the workflows list and show the toast "Workflow <id> not found".
- The workflow has a parse error: the workflow page shows today's parse-error state; stage addresses redirect to it.

**Reordering and deleting stages**
- Reordering keeps working with the stepper closed. Up/down buttons do the same as drag (keyboard and phone).
- Delete removes the stage from the draft with no extra dialog. It shows up in the unsaved bar, and the existing Review-and-save dialog already lists the open tasks that keep the old stage list, so that is where the impact is shown.

**Loading and read-only**
- Loading and error states: the hub shows skeleton cards while loading. On an error it shows today's error message with Retry. Focused pages show the same states.
- Read-only repos (`repo-newer`, `pre-1.0`): every page renders, edit controls are disabled as today, and the hub banner says why.
- Designer not supported: "Describe a workflow" and "Change with Claude" are disabled with today's upgrade hint.

**Palettes**
- First load in a new browser: Ultramarine paints, then the server value applies. Later loads paint from the cache.
- The server is unreachable or GET fails: keep the cached palette, with no error UI.
- A POST fails: revert to the previous palette and show the toast "Could not save the palette: <message>".
- Another tab or a phone changes the palette: the SSE `preferences` event applies it immediately. After an SSE reconnect the query is refetched.
- Classic matches today's look exactly, including the light sidebar. The other three use the coloured sidebar.
- Light/dark stays per browser, through next-themes as today.

**Phone (390 px)**
- Hub cards in one column, as list rows with chevrons (screen 5).
- The workflow page as rows with chevrons.
- The stage page shows the current step's name with numbered dots for the others; Back/Next are pinned at the bottom above the unsaved bar.
- Touch targets are at least 44 px.

## Constraints

- **Contrast:** for each palette, in light and in dark, the builder checks:
  - foreground, muted-foreground, primary-foreground on primary, accent-foreground on accent, and sidebar foreground, muted and active text on the sidebar must reach ≥ 4.5:1 against their backgrounds;
  - enforcement (guide/warn/block), stage and change colours must reach ≥ 4.5:1 as text on background, card and accent.

  Any failing token is overridden in that palette's block. Use a throwaway script (not committed), and record the final table in this plan under "Contrast results".
- **CI:** Prettier, the UI typecheck and `build-ui.mjs` must pass (`prettier --check packages/ui/src packages/cli/src/ui`).
- **Dependencies:** none new. dnd-kit, next-themes and shadcn are already present.
- **Server:** the server stays dependency-free.
- **Security:** the preferences file holds no secrets. It is still written 0600 like the other `$SHIPLINE_HOME` files, and the POST body is limited by the default `maxBody`.
- **Upgrade path:** do not break the existing addresses: `#/setup/<id>`, `#/setup/<id>/draft/<wid>` and the legacy redirects in `app.tsx`.

## Verification

Manual walkthrough (user's choice), on desktop and on a phone (or a 390 px window):
1. Open Setup. The hub shows correct counts against the repo's files. Each card opens its page; Back returns to the hub; reload keeps the page.
2. Workflows → bugfix:
   - reorder by drag and by up/down;
   - Edit Root cause, jump between steps by clicking, change enforcement to block;
   - Back to the hub: the unsaved bar shows both files;
   - Review and save writes them.
3. Add a stage: it opens at Basics with an editable id. Delete a stage. New, Add shipped and Copy each land on the new workflow page.
4. Describe a workflow and Change with Claude start chats as today. A draft card appears and opens the draft review.
5. Guardrails, Agents & skills, CI check, Phone access and Project config work exactly as before.
6. Bad addresses (stage 99, an unknown workflow) redirect as described.
7. Appearance: pick each palette in light and in dark, and check chat, Health, All projects and the sidebar. A second tab and a paired phone switch live. Reload shows no flash. Stop the server: the cached palette still paints.
8. A read-only repo shows everything disabled.
9. `pnpm` typecheck, Prettier and the UI build pass. `node --test packages/cli/test/ui/preferences.test.mjs` passes.

## Contrast results

Ratios (WCAG, 4.5:1 needed) computed from the final values in `packages/ui/src/index.css`. Each cell is the lowest ratio in its group. `*` marks a value below 4.5:1.

| Check (lowest ratio of the group) | classic light | classic dark | ultramarine light | ultramarine dark | ember light | ember dark | harbor light | harbor dark |
|---|---|---|---|---|---|---|---|---|
| foreground on background / card | 15.87 | 16.73 | 16.72 | 15.52 | 15.72 | 15.30 | 15.61 | 15.69 |
| muted-foreground on background / card / muted | 4.78 | 5.47 | 5.54 | 6.30 | 6.18 | 6.29 | 5.54 | 6.65 |
| primary-foreground on primary | 7.04 | 7.24 | 8.10 | 7.83 | 5.18 | 8.46 | 5.28 | 9.46 |
| accent-foreground on accent | 10.04 | 11.79 | 9.11 | 10.17 | 8.01 | 11.71 | 6.59 | 10.20 |
| sidebar-foreground on sidebar | 16.87 | 17.68 | 13.06 | 17.38 | 13.67 | 17.03 | 10.72 | 17.58 |
| sidebar muted text (foreground at 70%) on sidebar | 6.37 | 8.76 | 7.03 | 8.66 | 7.31 | 8.48 | 6.10 | 8.74 |
| sidebar active text on active item | 10.04 | 11.79 | 13.06 | 7.83 | 8.01 | 8.46 | 10.72 | 9.46 |
| sidebar-accent-foreground on hover (accent over sidebar) | 10.04 | 11.79 | 8.43 | 13.64 | 8.76 | 13.19 | 6.85 | 13.15 |
| stage colours (done, progress, pending, skipped) on background / card / accent | 4.05 * | 5.07 | 4.50 | 4.59 | 4.54 | 4.70 | 4.54 | 4.64 |
| enforcement colours (guide, warn, block) on background / card / accent | 4.88 | 7.07 | 4.79 | 5.93 | 5.08 | 6.57 | 4.93 | 5.37 |
| change colours (added, modified, deleted, renamed) on background / card / accent | 4.35 * | 7.07 | 4.50 | 5.93 | 4.54 | 6.57 | 4.64 | 5.37 |
| notice colours (blocked, reminder, denied) on background / card / accent | 4.88 | 7.07 | 4.79 | 5.93 | 5.08 | 6.57 | 4.93 | 5.37 |

Notes:
- Overrides made in the palette blocks (all other stage, enforcement, change and notice colours keep today's values): `stage-done`, `stage-skipped` and `change-added` darkened in the Ultramarine and Harbor light blocks (and `stage-skipped` in Ember light), and `stage-pending` lightened in the Ultramarine and Harbor dark blocks. Because the light blocks also match when `.dark` is set, the dark blocks restate today's dark values for those tokens.
- The Classic light `*` cells are today's own colours (`stage-done`, `change-added` and `stage-skipped` on the accent background, `stage-skipped` on the page background). They were left unchanged because Classic must match today's look exactly.
- "Sidebar muted text" is `--sidebar-foreground` at 70% over the sidebar, which is what the sidebar's group labels and chat subtitles use. The wireframe's `--side-mut` has no token of its own.
- "Sidebar active" uses `--sidebar-active` (added in this build): Classic keeps today's soft accent; the other three use `--sidebar-primary`.

## Plan review (2026-11-17)

Two must-fixes were applied: the route type and parse order, and redirects waiting for data and checking against the draft-applied stage list. Optional clarifications were applied too: the sidebar token wording, delete relying on the save dialog's impact list, keeping `stage-editor.tsx`, and the server-wide SSE event.

## Open Questions

- None. The preferences test is kept; the guardrails plan was updated to target the new Guardrails page.
