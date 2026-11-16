---
name: shipline-workflow-designer
description: Creates a new Shipline workflow, or changes an existing one, from a plain-words description of the team's process - stages, gates, required sections and per-stage rules - and validates it. Use `--draft` from the Shipline UI (Setup) to leave a draft for review, or run it in a terminal to write the files.
disable-model-invocation: true
---

# Shipline workflow designer

You help the developer turn their process into a valid Shipline workflow (`.shipline/workflows/<id>.yml` plus `.shipline/rules/<stage>.md` for each stage). Assume they may never have seen the YAML: ask about their process in plain words and do the mapping to stages and fields yourself. Experts can skip ahead. Ask a few questions at a time, never assume, and show a summary before writing anything.

## Arguments

- `--draft`: UI mode. Write a draft for review in Shipline's Setup screen. Never write to `.shipline/` yourself.
- `--edit <workflow-id>`: change that existing workflow instead of creating a new one.
- Everything else is the developer's free-text description of the process. It may be empty; then start by asking.
- Without `--draft` you are in terminal mode: you write the repo files after the summary is approved.

## 1. Read first

Read `.shipline/config.yml`, every `.shipline/workflows/*.yml` (the comment at the top of `feature.yml` documents every field), `.shipline/rules/*.md`, the agents in `.claude/agents/`, and the repo's conventions (README, `CLAUDE.md`, CI config). With `--edit`, read that workflow and the rules of its stages closely. To see which shipped workflows this repo doesn't have yet, run `node .shipline/bin/stage.mjs workflows --shipped` (id, name, description and stages of each).

## 2. Interview

Cover these, a few questions at a time:

1. **The process in plain words:** what does the team do, step by step, from a request to done? Propose how the steps map to stages (ids are letters, digits, `-` and `_`; each stage has a name and usually an `artifact`, a file such as `plan.md` that must exist before the stage can finish). Confirm the mapping instead of asking field by field.
2. **Gates and risks:** where must a person sign off? A stage with `confirm_to_advance: true` asks the developer before moving on; add `checkpoint: true` for the few that must still ask in `confirmations: light` mode. What must never happen before what? Hold back source edits with `blocks: [{ tools: 'Edit|Write|MultiEdit|NotebookEdit' }]` (optionally `allow_paths: [globs]` for files that stay editable) and named actions with `blocks: [{ actions: [...] }]`. The actions are `commit`, `push`, `pr`, `merge`, `release`, `deploy` and `migrate`. A block holds back what it names until that stage is done, and only counts when the stage has `enforcement: block` (`warn` only reminds, `guide` only instructs). Use `{ bash: 'regex' }` only for a command no named action covers. Required headings in the artifact go in `sections: [...]`; `checks: true` makes the stage wait for a passing `stage.mjs check` run of the test, lint and build commands.
3. **Start from the closest:** propose the closest existing workflow in this repo, or a shipped one that isn't installed yet, and adapt it instead of starting from a blank page. With a shipped one, copy its stages from `.shipline/bin/shipped/<id>.yml`.
4. **Rules:** for every new stage id, and for existing stages the developer wants changed, draft `rules/<stage-id>.md` from their answers and the repo's conventions. Match the short, bulleted style of the existing files in `.shipline/rules/`. A stage whose rules file already exists and isn't changing needs no new file.
5. **Agents:** a stage's `agent` may only name an agent that already exists in `.claude/agents/`, or be left out. Never create or install agents.

State the limits plainly: a workflow can only use the fields above. If the developer asks for something that doesn't exist (a named approver, waiting for a ticket status, a new kind of gate), say it isn't supported and offer the closest option: a confirmation, a checkpoint or a block. You never change `.shipline/config.yml` here (rails, commands, tracker); that is `/shipline-setup` or Setup in the UI.

## 3. Summarize

Show the stages in order with what each requires (artifact, sections, confirmation, enforcement and blocks) and the rules you will write. Say what changes, with `--edit`. Get the developer's approval before writing anything. The workflow `id` is the file name without `.yml`; for a new workflow pick a short, lowercase id that isn't taken.

## 4. Write to a scratch folder

Get a fresh folder with `node .shipline/bin/stage.mjs draft --tmp`; it prints the path (inside Shipline's store, outside the repo). Never work out store paths yourself. Write there:

- `workflow.yml`: the complete workflow (with `--edit`, the full changed file, not a patch), with `id:` equal to the workflow id.
- `rules/<stage-id>.md`: one file for each rules file you add or change, and only those.

The YAML parser supports a small subset: nested maps, lists, inline `[a, b]` lists, quoted strings, `#` comments. Use single quotes around regexes and globs. Keep the comment header of the workflow you started from.

## 5. Validate

Run `node .shipline/bin/stage.mjs validate <that folder>`. It prints `ok`, or one line per problem as `<file>: <field>: <message>`. Fix every error and run it again until it is clean. A `warning:` line is not an error, but read it: a missing rules file means a stage has no repo rules, and a missing agent means the stage's agent isn't installed.

## 6. Hand over

- **`--draft` (UI mode):** run `node .shipline/bin/stage.mjs draft <workflow-id> --from <that folder>`. It validates again and stores the draft for review. Then tell the developer the draft is ready and that they can review it in Setup (the Shipline UI shows a "Draft ready" notice), where they choose Save or Discard. Don't write `.shipline/workflows/` or `.shipline/rules/` yourself in this mode.
- **Terminal mode:** write `.shipline/workflows/<id>.yml` and the rules files into the repo (Claude Code's permission prompt for `.shipline/` edits applies to each one), then run `node .shipline/bin/stage.mjs validate .shipline` to confirm the whole repo is clean. Fix anything it reports. Finish by listing what changed and reminding the developer to commit `.shipline/`.

Don't touch the hook scripts in `.shipline/bin/`.
