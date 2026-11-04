---
name: shipline-setup
description: Claude-led setup interview that customizes this repo's Shipline workflows - stages, per-stage enforcement and confirmation, per-stage rules and artifact locations. Run once after `shipline init`.
disable-model-invocation: true
---

# Shipline setup

You are customizing the Shipline files that `npx @forgeyard/shipline init` created. Be an interviewer: ask a few questions at a time, never assume, and show the developer a summary before writing anything. Without this setup the defaults already work, so the developer can stop at any point.

## 1. Read the repo first

Read `CLAUDE.md`, `.claude/agents/`, `package.json` (or the language's equivalent), CI config, README and the folder layout. Also read `.shipline/config.yml`, `.shipline/workflows/*.yml` and `.shipline/rules/*.md`. Note existing conventions (test/lint/build commands, branch and PR naming, docs folders, UI or not) and bring them into your questions as proposals.

## 2. Interview

Cover these topics, one group at a time:

1. **Workflows:** are Feature, Bugfix and Hotfix the right set? Which stages should each have, in what order? Which are optional? Which only apply to UI work (`condition: ui_only`)? Bugfix and Hotfix are only defaults.
2. **Enforcement per stage:** `guide` (instructions only), `warn` (allowed, with a reminder), or `block` (denied until the stage is done). Defaults: block source edits until plan (root cause for bugfix) is done; block `git commit` and `gh pr create` until verify is done. Ask whether other actions need blocking (for example migrations or env files) and write them as `blocks` entries. Explain that blocking covers Edit/Write tools and matching Bash commands, not every possible way of changing files.
3. **Confirmation per stage:** should Claude ask the developer before advancing (`confirm_to_advance: true`) or advance by itself? Note that confirmation is recorded by Claude after asking; it is process discipline, not cryptographic proof.
4. **Rules per stage:** repo-specific instructions for each stage (what a good plan contains here, coding conventions, what verify must check, PR template and reviewers). Write them to `.shipline/rules/<stage>.md`.
5. **Naming and commands:** the branch pattern (`branch_pattern`) and the test/lint/build commands the verify stage should run (leave empty if none).

## 3. Write

After the developer approves your summary, edit only: `.shipline/config.yml`, `.shipline/workflows/*.yml` (keep the field names; see the comment at the top of `feature.yml`), `.shipline/rules/*.md` (add a file for every new stage id), and, only if the developer asks, the `<!-- shipline:start -->` block in `CLAUDE.md`. The YAML parser supports a small subset: nested maps, lists, inline `[a, b]` lists, quoted strings, `#` comments. Use single quotes around regexes. Do not touch the hook scripts in `.shipline/bin/`.

Finish by listing what changed and reminding the developer to commit `.shipline/`, `.claude/` and `CLAUDE.md` so teammates get the same flow on clone.
