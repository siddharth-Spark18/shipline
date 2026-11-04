@AGENTS.md

<!-- shipline:start -->
## Shipline workflow

This repo uses Shipline: tasks follow a defined workflow (Feature, Bugfix or Hotfix) with stages, per-stage rules and saved artifacts. Config lives in `.shipline/` (workflows, rules, config.yml); artifacts and progress live in the artifact root (default `docs/shipline/<task>/`).

- For any request to build, fix or change something, use the `shipline-workflow` skill: say which workflow you will follow, get the developer's OK, then work stage by stage and record progress with `node .shipline/bin/stage.mjs`.
- Read `.shipline/rules/<stage>.md` before each stage and follow it.
- If a hook denies a tool call, finish the missing stage or tell the developer; never work around it.
- Quick questions and chatter do not start a workflow.
- Customize with `/shipline-setup` or `npx shipline ui`. Requires Node 18+ (Node 20+ for the UI).
<!-- shipline:end -->
