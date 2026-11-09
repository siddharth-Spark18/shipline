# Review: shipline-setup-polish

## 1. Verdict
Ready after must-fixes (3 must-fix, all small).

## 2. Paraphrase
**What the plan proposes.** Release 1.1.0 makes setup uniform. `init` opens the browser wizard by default (`--terminal` forces the prompts, `--yes` and `--dry-run` are unchanged, Node 18-19 falls back to prompts). The terminal flow is rebuilt as 7 numbered steps. It gains confirmations, a guardrails on/off switch and a branch-pattern question. It ends with a settings summary, a file list and a Y/n confirmation before writing. Both paths end with the same numbered next-steps checklist, produced by a new `nextSteps(selection)` helper. The wizard shows it on a final "You're set up" screen instead of reloading. The install selection gets two optional fields, `guardrails` and `branchPattern`. The plan also adds an npm README, updates the root README and the `/shipline-setup` skill (Guardrails topic, named-actions enforcement), and ships release files (version, CHANGELOG, additive known-hashes).

**How the existing system works, per the plan.** Terminal `init` asks "terminal or browser?" (`askWhere`) and writes without review. It never asks about confirmations, guardrails or the branch pattern. The wizard already has confirmations. `install.mjs` owns the selection (`defaultSelection`, `checkSelection`, `planInstall`) and is shared by the CLI and the UI server routes. `setup-schema.mjs` has a private branch-pattern validator. The npm page has no README. After install the wizard reloads after 600 ms.

## 3. Must-fix
1. **Guardrails-off and branch-pattern writing mechanism (Item 2, Files table `install.mjs`).** In `install.mjs`, `planWrites` edits config by parsing the YAML into a model and re-emitting it with `emitConfig(model, {layout, raw})`. The plan says `off` writes every rail as `off`, sets `protected_paths: []`, and adds a comment above `rails:`. It never says how to get that comment through `emitConfig`, or whether `emitConfig` keeps comments. It also leaves open whether a text patch or the model is used. "Only if the guardrails-off comment needs an anchor" pushes the decision to the builder. Fix: state the approach (model edit plus a specific comment mechanism, or a text patch of the `rails:` block) and say who enumerates the rail keys (read from the template, not hardcoded).
2. **Review step test and injection seam (Items 1 and 4, `init.mjs`).** Today `prompts` (injected) replaces the questions, and `where` is injected for tests. The plan removes `askWhere` and adds `askConfirmInstall()`. It does not say whether the review and Y/n run when `prompts` is injected, nor how tests inject the answer (new `confirmInstall` param?). It also doesn't say whether `where` is removed. Fix: name the new `runInit` parameters (for example `confirm`) and state that the review runs for the injected-`prompts` path.
3. **`checkPattern` reuse shape (Files table `setup-schema.mjs`).** `checkPattern(model, key, out)` pushes `{path, message}` objects into an array and returns nothing. The terminal re-ask, `checkSelection` (which throws strings) and the wizard need a message. The plan says to "export" it but not how callers turn the `out` array into a message. Fix: add one line, for example export a small `branchPatternError(value)` that returns the first message or null, and use it in both places.

## 4. Optional (non-blocking)
- `nextSteps(selection)` must be async-free and live in `install.mjs`. That is fine. Note that the CI-case step 1 text is given only prose-wise, so write the exact two variants into the tests.
- The 7 terminal steps hide the "Step n of 7" count when a step is skipped (for example, no UI question). Say it stays 7.
- `/api/install/info` `branchPatternDefault` is "if the wizard needs it". Decide now; the wizard hardcodes the default otherwise.
- The README line-count target (80-120) is arbitrary. Harmless.

## 5. Files-to-touch check
- All the existing modify paths I checked exist: `init.mjs`, `init-prompts.mjs`, `install.mjs`, `setup-schema.mjs`, `templates/shipline/config.yml` (listed as a conditional change only), `ui/server.mjs` and its `startServer`.
- Missing from the list: `packages/cli/test/publish.test.mjs` is covered by `test/**`. `config.yml` is mentioned in Surface Area but not in the Files table. List it as conditional or remove it.
- The root `README.md`, `packages/cli/README.md`, `CHANGELOG.md` and the hash script run (`hash-templates.mjs`) are all named. The hash regeneration step is not in the table. Add "run hash-templates without reset" next to `known-hashes.json`.
- `init.mjs` needs a refactor to share the dry-run file-list printer with the review. That is within its listed change.
