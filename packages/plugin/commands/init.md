---
description: Install the Shipline workflow into this repo (runs `npx @forgeyard/shipline init --yes`)
allowed-tools: Bash(npx --yes @forgeyard/shipline init:*)
---

Run `npx --yes @forgeyard/shipline init --yes` in the current repository root using Bash and show its output to the developer. `--yes` installs the defaults (every workflow and agent) and keeps the repo's own agent files when a name clashes. If it aborts because of a name collision or an invalid `.claude/settings.json`, explain what it listed and that nothing was written; do not edit files to work around it. If it says Shipline is already initialized, say so. If the output has a "Kept your own agents" line, show that list to the developer and explain how to switch to Shipline's versions (`npx @forgeyard/shipline ui`, then Setup, Agents & skills). On success, tell the developer to run `/shipline-setup` next and to commit `.shipline/`, `.claude/` and `CLAUDE.md`. Also tell them that running `npx @forgeyard/shipline init` in a terminal offers interactive choices (which workflows, agents and repo skills to install).
