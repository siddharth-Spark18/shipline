---
name: shipline-workflow
description: How to run a Shipline workflow in this repo - detect the workflow type, confirm it, work through stages, save artifacts, record progress with stage.mjs, and resume unfinished tasks. Use for any request to build, fix or change something.
---

# Running a Shipline workflow

This repo defines how Claude works on tasks. Workflows live in `.shipline/workflows/*.yml` (feature, bugfix, hotfix by default), per-stage rules in `.shipline/rules/<stage>.md`, and settings in `.shipline/config.yml`. Everything is advisory except stages set to `block` or `warn`, which hooks enforce.

## 1. Detect and confirm

When the developer asks for a task (not a quick question or chatter), classify it and ask once: "This looks like a feature, so I'll follow the Feature workflow. OK?" They confirm or switch. Run `node .shipline/bin/stage.mjs workflows` to list what exists. If the work later clearly fits another workflow (for example a hotfix), ask before switching.

## 2. Start

```
node .shipline/bin/stage.mjs start --workflow <id> --title "<short title>" [--ticket PROJ-12] [--ui true|false]
```

This creates the task folder (`docs/shipline/<KEY>-<slug>/` by default), writes `manifest.json`, binds it to this session (needs `$SHIPLINE_SESSION`, otherwise pass `--session <id>` from the SessionStart context) and prints the first stage, its artifact and its repo rules. It also prints a suggested branch name; create that branch yourself before editing source, unless the developer says otherwise.

## 3. Work each stage

For the current stage: read its rules (printed by stage.mjs), delegate to the named agent if one is suggested, and write the stage's artifact into the task folder. Artifacts are the source of truth for later stages; read them instead of relying on memory.

- **jira:** use the Atlassian MCP if it is connected (read-only) to fetch the ticket and save the key facts to `ticket.md`. If it is not connected, say so, then either use details the developer pastes or skip the stage (`stage.mjs skip --reason "no Jira"`). Pass `--ticket` at start when you know the key.
- **feasibility:** write `feasibility.md`. If the verdict is *not feasible*, STOP after writing it: present blockers and alternatives and let the developer decide. If *partly feasible or uncertain*, carry the blockers into the questions stage.
- **plan:** state whether the work is UI-affecting, then run `stage.mjs flag ui true|false`. The wireframes stage runs only for UI work.
- **verify:** build the requirement checklist in `verification.md` (each acceptance criterion with evidence). For UI work run the app and check it in a browser. Run test, lint and build commands only if configured in `.shipline/config.yml`.
- **pr:** use `git` and `gh` with the developer's own credentials; link the artifacts in the PR body.

## 4. Advance

When the stage's artifact exists, record progress:

```
node .shipline/bin/stage.mjs advance            # stages with confirm_to_advance: false
node .shipline/bin/stage.mjs advance --confirmed # only AFTER the developer agreed
```

If the stage config says `confirm_to_advance: true`, summarize the result, ask the developer, and pass `--confirmed` only after they say yes. Never pass it on your own. Use `skip --reason "..."` for optional stages, `reopen <stage>` when earlier work must change, `status` to see where things are.

## 5. Guardrails

Hooks may deny a tool call (for example editing source before the plan is done, or committing before verify). The reason names the missing stage. Do not work around it: finish that stage, or tell the developer. In `warn` mode you get a reminder instead; treat it seriously.

## 6. Resume

At session start Shipline lists unfinished tasks ("PROJ-12 add-export: plan done, next: wireframes"). Offer to resume; if several are open list them and ask which (a task whose branch matches the current branch is the likely one). Resume with `node .shipline/bin/stage.mjs resume <task folder>`, then read the finished artifacts before continuing.
