# Review: shipline-teams-phase3

## 1. Verdict

Ready after must-fixes (5 must-fix items, all small clarifications).

## 2. Paraphrase

**What the plan proposes.** Add a command parser to the vendored `lib.mjs` that splits shell text into simple commands. It looks through wrappers such as env, sudo, `sh -c` and git global options. On top of it, the guard gets always-on "rails" (deny, ask or off) for force-push to the default branch, pushing to it, `curl | sh`, printing credentials, reading credentials, deploys, migrations and edits to agent config. It also gets "protected paths" (globs that trigger `ask` on edits), and named `actions` blocks for stages (`commit`, `push`, `pr`, ...) that replace hand-written regexes and catch bypasses. At Verify, `stage.mjs check` computes a scope report: tests, lint or CI files touched, and files outside the plan's "Files to touch". Finishing Verify then asks an extra confirmation, and the PR summary shows the scope. Setup UI gets a Guardrails section. New installs get the rails on. `upgrade` adds the keys with every rail `off`. README documents all of it and says hooks are defence in depth.

**How the system works today, per the plan.** The guard runs as a PreToolUse hook. It denies access to the task store first. Then, only if the session has a task, it walks the workflow stages and applies each stage's `blocks` (`{tools, allow_paths}` or `{bash: regex}`) as deny or warn according to the stage's enforcement mode. Protected paths exist only inside stage blocks. `stage.mjs check` runs configured commands, and Phase 2 added acceptance of failed commands and `confirm_to_advance` confirmations, recorded through `CONFIRM_OPTIONS` and `record-answer.mjs`. Config lives in `.shipline/config.yml`, validated by `setup-schema.mjs`. `upgrade` rewrites files, and `known-hashes.json` tracks shipped files.

## 3. Must-fix

1. **Rail ordering vs. the guard's early exits (scope B, Files to Touch / guard.mjs).**
   - In `guard.mjs`, a session with no task exits at line 125, and any file outside the repo exits at line 143. `~/.ssh`, `~/.aws` and `~/.kube` credential paths fall under that second exit.
   - The plan says "after the store protection", but not that rails and protected paths must also run before these exits. Nor does it say that the Read/Bash credential checks must handle paths outside the repo root.
   - Fix: state explicitly that rails and protected paths run right after the store check and before the "no task" and "outside repo" exits, and that `isCredentialPath` works on absolute and `~` paths.

2. **Protected-path and `agent_config` overlap is under-specified for Bash.** Scope C says `.claude/` and `.shipline/` are covered by `agent_config`. The Bash write detection (redirects, `tee`, `sed -i`, `mv`, `cp`, `rm`) is described under protected paths but `agent_config` borrows it ("the Bash writes from scope C"). Fix: say that one shared helper `bashWriteTargets(parts)` is used by both, and name it in the lib.mjs list.

3. **`ask` decisions with a stage in `block` mode (scope B, "the decision").** The plan says deny beats ask beats warn. It doesn't say what happens when only `ask` rails match and the stage is in `guide` mode (the guard skips guide stages), or no task exists. Probably the rail ask still fires. Fix: state that rails and protected-path asks fire regardless of stage mode and task state.

4. **`settings-hooks.json` matcher (Files to Touch).** The current matcher is `Edit|Write|MultiEdit|NotebookEdit|Bash`, with no `Read`. So the change is required, not conditional ("if it isn't covered already"). Also, existing installs get the hook config via `upgrade`/`install`, and the plan doesn't say how an upgraded repo's `.claude/settings.json` gets `Read` added. Fix: make the change unconditional and say whether `upgrade` patches the matcher in installed settings. If it doesn't, `read_credentials` silently does nothing on upgraded repos, which matters even though they start with rails off.

5. **Default-branch cache location (scope B).** "Cached per session in the session state file" writes to the state JSON, but sessions without a task have no state file (guard only reads it when a task exists). Also `stage.mjs start` overwrites the state file wholesale (line 109) and `lib.mjs` has `readSession` only. Fix: say which file holds the cache for task-less sessions, for example a separate `<sid>.branch` file in the state dir like `.lost-warned`, so it doesn't clash with start overwriting the state.

## 4. Optional (non-blocking)

- `printenv`/`env` with no command is denied by default. That is a very common debug command, so it goes against the "friction budget"; consider `ask`. The `print_credentials` rail is one id with one level, so the split would need a second rail.
- `pushing` rails and `actions: push` and `merge`: `merge` is defined as "`git merge` into the default branch (current branch is default)", which needs the same current-branch lookup as `push_default`. Say it reuses the helper.
- Package-script body check: which `package.json` is "nearest" when the `cd sub &&` part is present? The plan says `cd` doesn't change matching. A short sentence ("nearest to the hook's cwd, ignoring `cd`") would settle it.
- `outside_plan` "Listed means" parsing: say whether paths are repo-relative and how a directory entry such as `src/foo/` matches. One line would do.
- `INTERFACE` 6 and `MISSING_BEFORE`: the plan doesn't say what the entry contains. It is probably mechanical.
- The `ask` behaviour under auto/bypassPermissions is correctly flagged as open. Consider recording the verification result in the README rather than only the plan.
- Scope is large (parser, 8 rails, protected paths, actions, scope check, UI, upgrade). It's one release, but a build-order note would help the builder (parser, then rails/guard, then actions, then scope, then UI).

## 5. Files-to-touch check

- All "modify" paths that I checked exist: the five `bin/*.mjs` templates, `config.yml`, the four workflows, `settings-hooks.json`, the `src/*.mjs` files named, `known-hashes.json`, and the UI files `setup-page.tsx`, `blocks-editor.tsx` and `types.ts`. I did not separately verify `SKILL.md`, `package.json`, README, the roadmap doc, or `test/*` files.
- `guardrails-section.tsx` is a create and the directory exists.
- Missing from the list: the UI's config-save path may need changes in `config-form.tsx` or `draft.ts` (in `packages/ui/src/pages/setup/`), which hold the config draft model. The plan says `setup.mjs` only "if needed". If the draft model is typed per key, `draft.ts` needs an edit. Please check and list it.
- Missing from the list: `install.mjs` is described as "unchanged if it writes the template as is", and `setup.mjs` as "if needed". Both are conditional, so the builder has to decide. Say which.
