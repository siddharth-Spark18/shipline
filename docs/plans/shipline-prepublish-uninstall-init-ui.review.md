# Review: shipline-prepublish-uninstall-init-ui

The reviewer was not allowed to write this file, so the main agent saved it from the plan-reviewer's report.

## Verdict

**Ready after must-fixes.** There are 4 must-fix items.

## Must-fix

1. **`POST /api/setup/agents` preview shape and `baseVersionHash` are not specified.**
   - The plan doesn't say what the `?preview=1` response contains.
   - It doesn't say what `baseVersionHash` is computed over, or whether files are checked for staleness too.
   - The save dialog's line counts depend on the preview's diff shape.
2. **The uninstall lock check names no mechanism for "held by a live process".** The plan should name the helper to reuse, or the liveness check.
3. **Interactive `init` on a repo that already has Shipline is not covered.**
4. **`--yes` keeps the repo's own agents on name clashes.** The plugin's `/shipline:init` behaviour changes as a result. Confirm that's intended, and tell the developer which agents were kept.

## Optional (not blocking)

- The `hash-templates.mjs` path is `packages/cli/scripts/hash-templates.mjs`.
- Check what the `legacy-0.6` fixture contains.
- "Closed by hand in this chat" needs a definition.
- The repo-skills line is printed at every stage, which adds noise.
- The `@inquirer/prompts` version pin is left to the builder.
- Confirm that the Tabs and Sheet components exist.
- `test/ui/helpers.mjs` isn't mentioned in the plan.

## Files-to-touch check

- Every "modify" path the reviewer checked exists, and so does `canvas-ribbon.tsx`, which is marked for deletion.
- Not checked: `index.css`, `packages/cli/package.json`, `packages/plugin/commands/init.md`, `README.md`.

## Re-review (final; the main agent saved it)

**Ready after 2 must-fix items.** All 4 earlier must-fix items are closed.

The 2 new must-fix items, both fixed in the plan:
1. Regenerate `pnpm-lock.yaml`, because CI installs with `--frozen-lockfile`.
2. "Keep yours" agent files need protection in the Setup agents toggle:
   - `remove` returns 400 `not-shipline`;
   - `add` replaces the team's file through a normal diff and moves the path from `excluded` to `files`.

The optional items are recorded in the plan's Open Questions as accepted trade-offs.
