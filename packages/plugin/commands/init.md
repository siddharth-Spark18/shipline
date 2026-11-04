---
description: Install the Shipline workflow into this repo (runs `npx @forgeyard/shipline init`)
allowed-tools: Bash(npx --yes @forgeyard/shipline init:*)
---

Run `npx --yes @forgeyard/shipline init` in the current repository root using Bash and show its output to the developer. If it aborts because of a name collision or an invalid `.claude/settings.json`, explain what it listed and that nothing was written; do not edit files to work around it. If it says Shipline is already initialized, say so. On success, tell the developer to run `/shipline-setup` next and to commit `.shipline/`, `.claude/` and `CLAUDE.md`.
