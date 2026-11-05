---
name: shipline-workflow
description: How to run a Shipline workflow in this repo - detect the workflow type, confirm it, work through stages, save artifacts, record progress with stage.mjs, and resume unfinished tasks. Use for any request to build, fix or change something.
---

# Running a Shipline workflow

This repo defines how Claude works on tasks. Workflows live in `.shipline/workflows/*.yml` (feature, bugfix, hotfix and small by default), per-stage rules in `.shipline/rules/<stage>.md`, and settings in `.shipline/config.yml`. Everything is advisory except stages set to `block` or `warn`, which hooks enforce.

## 1. Detect and confirm

When the developer asks for a task (not a quick question or chatter), classify it. Run `node .shipline/bin/stage.mjs workflows` to list what exists.

- **Small change:** you decide this yourself. A change is small when it is a typo, a rename, a config or copy tweak, or a one-file fix with an obvious cause. Announce "Using the Small change workflow" and start it right away, without waiting for an OK. If the change turns out to be bigger (several files, a behavior change, unclear cause), say so and ask before switching to Feature or Bugfix.
- **Anything else:** ask once: "This looks like a feature, so I'll follow the Feature workflow. OK?" They confirm or switch. If the work later clearly fits another workflow (for example a hotfix), ask before switching.

No workflow is skipped: even a one-line change goes through Small change.

## 2. Start

```
node .shipline/bin/stage.mjs start --workflow <id> --title "<short title>" [--ticket PROJ-12 | 123] [--ui true|false]
```

This creates the task folder (outside the repo, under `~/.shipline`; `stage.mjs` prints its absolute path, named `<KEY>-<slug>` or `<slug>`; for a GitHub issue the key is `issue-123`), writes `manifest.json`, binds it to this session (needs `$SHIPLINE_SESSION`, otherwise pass `--session <id>` from the SessionStart context) and prints the first stage, its artifact and its repo rules, and, when `.shipline/config.yml` lists `skills:`, a "Repo skills you can use" line at every stage. Use those skills when they fit the stage; if one cannot be found under `.claude/skills/`, tell the developer. It also prints a suggested branch name; create that branch yourself before editing source, unless the developer says otherwise.

## 3. Work each stage

For the current stage: read its rules (printed by stage.mjs), delegate to the named agent if one is suggested, and write the stage's artifact into the task folder that `stage.mjs` prints. Artifacts are the source of truth for later stages; read them instead of relying on memory.

- **ticket:** `.shipline/config.yml` says which tracker the repo uses (`tracker: jira`, the default, or `github`); `stage.mjs` names it when the stage starts. Read the ticket (read-only, never create or edit issues) and save the key facts to `ticket.md`. If the developer pastes ticket details, use those instead. Pass `--ticket` at start when you know the key or issue number.
  - **jira:** use the Atlassian MCP if it is connected. If the Atlassian tools are not available (not connected, or needing authentication), skip the stage with `stage.mjs skip --reason "Jira not connected"`.
  - **github:** run `gh issue view <n> --json number,title,body,labels,url,state` and save the result to `ticket.md`. If `gh` is missing, not signed in, or the call fails, skip the stage with `stage.mjs skip --reason "GitHub not connected"`. Start the task with `--ticket 123` (or `#123`), so the branch is `feature/issue-123-...` and `pr-summary` adds `Closes #123`.
  - The stage is optional, so skipping needs no question to the developer. Workflows from before 0.10.0 may call this stage `jira`; it is the same stage.
- **feasibility:** write `feasibility.md`. If the verdict is *not feasible*, STOP after writing it: present blockers and alternatives and let the developer decide. If *partly feasible or uncertain*, carry the blockers into the questions stage.
- **plan:** state whether the work is UI-affecting, then run `stage.mjs flag ui true|false`. The wireframes stage runs only for UI work.
- **verify:** build the requirement checklist in `verification.md` (each acceptance criterion with evidence). For UI work run the app and check it in a browser. Run the test, lint and build commands configured in `.shipline/config.yml` and record each result; skip any that are not set.
- **pr:** use `git` and `gh` with the developer's own credentials; summarize the plan and the verification result in the PR body. Don't link task files; they're local. Run `node .shipline/bin/stage.mjs pr-summary` and paste its output unchanged at the end of the PR description (for a GitHub issue its first line is `Closes #<n>`; keep it, so merging closes the issue).

## 4. Advance

When the stage's artifact exists, record progress:

```
node .shipline/bin/stage.mjs advance
```

If the stage config says `confirm_to_advance: true`, `advance` is refused and prints a question. Summarize the result, then ask the developer exactly that question with the AskUserQuestion tool, word for word. When they answer "Advance", run `advance` again and it goes through. If they answer "Not yet", carry on with the stage and ask again later. Skipping a stage that isn't optional works the same way: `skip` prints its own question. The recorded answer is the only confirmation that counts, so never try to confirm for the developer.

Never pass `--confirmed` or `--force` (they no longer exist), and never edit progress files (`manifest.json`, session state or approvals in the task store) or run `record-answer.mjs`; hooks block this. Use `skip --reason "..."` for optional stages, `reopen <stage>` when earlier work must change, `status` to see where things are.

## 5. Guardrails

Hooks may deny a tool call (for example editing source before the plan is done, or committing before verify). The reason names the missing stage. Do not work around it: finish that stage, or tell the developer. In `warn` mode you get a reminder instead; treat it seriously.

## 6. Resume

At session start Shipline lists unfinished tasks ("PROJ-12 add-export: plan done, next: wireframes"). Offer to resume; if several are open list them and ask which (a task whose branch matches the current branch is the likely one). Resume with `node .shipline/bin/stage.mjs resume <task folder name or absolute path>`, then read the finished artifacts before continuing.
