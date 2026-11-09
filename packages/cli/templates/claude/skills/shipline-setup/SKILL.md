---
name: shipline-setup
description: Claude-led setup interview that customizes this repo's Shipline workflows - stages, per-stage enforcement and confirmation, per-stage rules and artifact locations. Run once after `shipline init`.
disable-model-invocation: true
---

# Shipline setup

You are customizing the Shipline files that `npx @forgeyard/shipline init` created. Be an interviewer: ask a few questions at a time, never assume, and show the developer a summary before writing anything. Without this setup the defaults already work, so the developer can stop at any point.

## 1. Read the repo first

Read `CLAUDE.md`, `.claude/agents/`, `package.json` (or the language's equivalent), CI config, README and the folder layout. Also read `.shipline/config.yml`, `.shipline/workflows/*.yml` and `.shipline/rules/*.md`. Note that `init` already detected the test/lint/build commands and shipped default rules in `.shipline/rules/*.md`; improve on them rather than starting from nothing. Note existing conventions (test/lint/build commands, branch and PR naming, docs folders, UI or not) and bring them into your questions as proposals.

## 2. Interview

Cover these topics, one group at a time:

1. **Workflows:** are Feature, Bugfix, Hotfix and Small change the right set? Which stages should each have, in what order? Which are optional? Which only apply to UI work (`condition: ui_only`)? Bugfix, Hotfix and Small change are only defaults.
2. **Enforcement per stage:** `guide` (instructions only), `warn` (allowed, with a reminder), or `block` (denied until the stage is done). Defaults: block source edits until plan (root cause for bugfix) is done; block the named actions `actions: [commit, pr]` until verify is done. The available actions are `commit`, `push`, `pr`, `merge`, `release`, `deploy` and `migrate`; ask whether other actions need blocking (for example `push` or `deploy`) and write them as `blocks` entries with `actions:`. Use `{ bash: 'regex' }` only as the escape hatch for a command no named action covers. Explain that blocking covers Edit/Write tools and matching Bash commands, not every possible way of changing files.
3. **Confirmation per stage:** should Claude ask the developer before advancing (`confirm_to_advance: true`) or advance by itself? The developer's own answer to a fixed question is what lets the stage advance (recorded by a hook, not by Claude); it is not cryptographic proof.
4. **Rules per stage:** repo-specific instructions for each stage (what a good plan contains here, coding conventions, what verify must check, PR template and reviewers). Write them to `.shipline/rules/<stage>.md`.
5. **Repo skills:** which of the repo's own skills in `.claude/skills/` should Claude be pointed to at every stage? List them in `skills: [name, ...]` in `.shipline/config.yml`.
6. **Tracker:** where does this team track work: nowhere (None, the default), GitHub Issues or Jira? Set `tracker: none`, `tracker: github` or `tracker: jira` in `.shipline/config.yml` (Linear and others are not supported; with None or an unsupported value the ticket stage is skipped).
7. **Naming and commands:** the branch pattern (`branch_pattern`, with `{type}`, `{key}` and `{slug}`; it must contain `{slug}`) and the test/lint/build commands the verify stage should run (leave empty if none).

8. **Confirmations:** ask Standard or Light. Standard: Claude asks before every stage marked `confirm_to_advance`. Light: Claude asks only at checkpoint stages (plan approval in Feature, root cause in Bugfix) and advances the rest on the deterministic checks; skipping a required stage, failed checks and the scope question still ask. Write `confirmations: standard` or `confirmations: light` in `.shipline/config.yml`.

9. **Guardrails:** these run inside Claude Code's hooks in every stage, with or without a task, and are set in `.shipline/config.yml`. Walk through them and ask what to change:
   - `rails:` each is `deny` (the call is refused), `ask` (Claude Code's permission prompt shows) or `off`. `force_push_default` (force-push to the default branch, `git branch -D` on it), `push_default` (any push to the default branch), `pipe_to_shell` (curl or wget piped into a shell), `print_credentials` (cat, grep, printenv and echo on .env, keys and tokens), `read_credentials` (the Read tool on those files), `deploy` (kubectl apply, terraform apply and the like), `migrate` (prisma migrate deploy, rails db:migrate and the like), `agent_config` (edits to `.claude/**`, `.shipline/**`, `CLAUDE.md` and `.mcp.json`).
   - `protected_paths:` globs relative to the repo root that need a permission prompt to change (migrations, infra, CI files, lockfiles by default). Propose paths that fit this repo.
   - `rails_commands:` extra `deploy:` and `migrate:` command prefixes, such as `make ship`.
   - `scope_check:` `enabled` (default true) and `sensitive_extra` (more globs to treat like test, lint and CI files). At Verify it lists those files and the files outside the plan's "Files to touch", and finishing the stage needs the developer's answer.
   Say plainly that guardrails are defence in depth: they stop mistakes, not a determined user. Hard limits need Claude Code's sandbox and managed settings.

## 3. Write

After the developer approves your summary, edit only: `.shipline/config.yml`, `.shipline/workflows/*.yml` (keep the field names; see the comment at the top of `feature.yml`), `.shipline/rules/*.md` (add a file for every new stage id), and, only if the developer asks, the `<!-- shipline:start -->` block in `CLAUDE.md`. The YAML parser supports a small subset: nested maps, lists, inline `[a, b]` lists, quoted strings, `#` comments. Use single quotes around regexes. Do not touch the hook scripts in `.shipline/bin/`.

As the last write, once the developer has approved the summary and the files are written, add `setup: done` as a top-level key in `.shipline/config.yml`. It stops the "default rules" reminder in Claude Code and the Setup page.

Finish by listing what changed and reminding the developer to commit `.shipline/`, `.claude/` and `CLAUDE.md` so teammates get the same flow on clone.
