<!-- shipline:start -->
## Shipline workflow

This repo uses Shipline: tasks follow a defined workflow (Feature, Bugfix, Hotfix or Small change) with stages, per-stage rules and saved artifacts. Config lives in `.shipline/` (workflows, rules, config.yml); task artifacts and progress are stored outside the repo, in the task folder that `stage.mjs` prints (under `~/.shipline`).

- For any request to build, fix or change something, use the `shipline-workflow` skill: say which workflow you will follow, get the developer's OK (for a small change, just announce "Using the Small change workflow" and start), then work stage by stage and record progress with `node .shipline/bin/stage.mjs`.
- Read `.shipline/rules/<stage>.md` before each stage and follow it.
- If a hook denies a tool call, finish the missing stage or tell the developer; never work around it.
- Confirmations (a stage that needs the developer's OK, or skipping a required stage) work only through the AskUserQuestion that `stage.mjs` prints; never pass `--confirmed` or `--force`, and never edit progress files in the task store.
- Quick questions and chatter do not start a workflow.
- Customize with `/shipline-setup` or `npx @forgeyard/shipline ui`. Requires Node 18+ (Node 20+ for the UI).
<!-- shipline:end -->
