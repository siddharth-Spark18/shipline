# Shipline

One guardrailed workflow from a chat to a merged PR. Work starts from a chat (pick a project, type); the
person who started it owns it end to end, in one browser view and one continuous Claude conversation,
using their own Claude subscription with Shipline's agents and guardrails attached. Every chat gets a
per-project key (`LL-12`); a Jira ticket is optional and Claude asks about it in its first reply.
There are no approvals: Claude proposes each stage change and the owner confirms it inline.

Plan: `docs/plans/shipline-v1.md`.

## Install

Shipline's repo workflow is published on npm as `@forgeyard/shipline`. Run it from the root of the repo you
want to set up (Node 18+; the `ui` command needs Node 20+):

```bash
npx @forgeyard/shipline init       # install the workflow into this repo
npx @forgeyard/shipline upgrade    # update an installed repo and move its tasks to ~/.shipline
npx @forgeyard/shipline ui         # optional local web UI
```

`upgrade` shows a preview and asks before changing anything (`--dry-run` only previews, `--yes` skips the
question, `--force` also replaces Shipline files your team edited). It never commits: the removal of the old
in-repo task folder is staged for you to review.

## Hard rules

- Shipline never collects, stores or relays Claude credentials or session tokens. No Agent SDK, no
  `claude setup-token`, never `--bare`.
- Shipline Local spawns the user's own installed, unmodified `claude` CLI.
- Tool permission prompts go to the `approve_tool_use` MCP tool; decisions are made server-side by
  role policy and the chat's CURRENT stage (read at call time) and logged to `ToolDecision`. A role limit
  denies that one call with a reason ("Designers can't edit code"); no stage is ever blocked.
- Sessions start only in repos registered to a Shipline project, in a per-chat git worktree that starts
  detached; the named branch (`<JIRA-KEY>-<slug>` or `<KEY>-<slug>`) is created at the first file edit.
- The PR is raised by Claude with the user's own git credentials and `gh`; there is no GitHub App fallback.
- Hard enforcement is the GitHub App required check `shipline/gates`. GitHub repo permissions are
  managed manually (Shipline only warns on a mismatch).
- Jira is optional and read-only (read scopes; no write endpoints).

## Layout

```
apps/api        Express + Prisma + Postgres: REST, OAuth server, MCP server (/mcp), Jira, GitHub App, Google SSO
apps/web        React + Vite + TanStack Query + Tailwind v4 + shadcn/ui: the hub, including the work view
apps/local      Shipline Local: local Node service (spawns claude, browser API on 127.0.0.1:4777), Electron tray helper, `npx shipline`
packages/plugin Claude Code plugin: agents, skill, hooks, .mcp.json, version manifest
packages/shared Types and pure logic: stages, roles, policy, stream-json event model, versions
```

## Prerequisites

Node 20+ (22 recommended), pnpm 10, Postgres 14+, and for Shipline Local the Claude Code CLI
(`claude`) signed in with your own account.

## Setup

1. Install and build shared types:
   ```bash
   pnpm install
   pnpm build:shared
   ```
2. Database:
   ```bash
   createdb shipline
   cp apps/api/.env.example apps/api/.env      # fill in the values (see below)
   pnpm --filter @shipline/api exec prisma migrate reset   # continuous-flow revision: data reset, replays both migrations
   pnpm db:seed                                # seeds the Feature and Hotfix workflow templates
   ```
3. Credentials (all in `apps/api/.env`, never committed):
   - `JWT_SECRET`, `ENCRYPTION_KEY`: `openssl rand -hex 32` each.
   - **Google SSO**: Google Cloud console > OAuth client (web). Redirect URI
     `{BACKEND_URL}/api/auth/google/callback`. Set `ADMIN_EMAILS` to your email to become admin.
   - **GitHub account link**: a GitHub OAuth App, callback `{BACKEND_URL}/api/auth/github/callback`
     (`GITHUB_CLIENT_ID/SECRET`).
   - **GitHub App** (the `shipline/gates` check): permissions Checks (read/write), Contents
     (read/write, only if you use commit-artifacts-to-repo), Pull requests (read), Metadata (read);
     subscribe to the Pull request, Pull request review and Pull request review comment events;
     webhook URL `{BACKEND_URL}/api/webhook/github`; set
     `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`; install it on the repo.
     Then in GitHub branch protection require the status check `shipline/gates`.
   - **Jira**: Atlassian OAuth 2.0 (3LO) app, scopes `read:jira-work read:me offline_access`,
     callback `{BACKEND_URL}/api/jira/callback` (`JIRA_CLIENT_ID/SECRET`). Claude searches and links
     tickets through it (`search_jira_issues`, `get_jira_issue`, `link_jira_issue`); there is no sync.
   - **MCP OAuth**: no extra secret; the API is its own OAuth authorization server (PKCE, dynamic
     client registration). Discovery: `{BACKEND_URL}/.well-known/oauth-authorization-server`.
4. Web: `cp apps/web/.env.example apps/web/.env` (defaults work for local dev). Optional
   `VITE_LOCAL_URL` (default `http://127.0.0.1:4777`) is where the browser reaches Shipline Local.
5. Run: `pnpm dev` (API on :3000, web on :5173). Sign in with Google, open **Admin**, create a project
   (GitHub repo `owner/name`, Jira key, chat key prefix such as `LL`), connect Jira there, and add members
   and roles in the project settings. Home is the new-chat screen: pick a project, describe the work.
   Re-run `pnpm db:seed` after registering Learnloop so its key prefix is `LL`.

## Shipline Local

The work view talks to Shipline Local straight from the browser. It binds to `127.0.0.1` only, allows
CORS for the hub origin only (`SHIPLINE_CLIENT_URL`, default `http://localhost:5173`) and needs a pairing
token on every request and WebSocket.

```bash
pnpm --filter @shipline/local build       # compiles the service and bundles the plugin
node apps/local/dist/server/cli.js   # headless
pnpm desktop                         # builds shared + local, then starts the Electron tray helper
pnpm dev:local                       # dev: the service on :4777 with file watching
```

Set `SHIPLINE_API_URL` (default `http://localhost:3000`) and `SHIPLINE_CLIENT_URL`. First run: the tray
(or the `pnpm dev:local` terminal) shows a one-time **pairing code**; open the hub, enter the code in the
pairing dialog, sign the service in to Shipline (banner button), and set each project's working-copy
folder under **Settings > Shipline Local**. Then start a chat: Shipline creates a git worktree at
`<working-copy>.shipline/<KEY>`, detached at the base branch, and starts one Claude conversation for the
whole chat in it (resumed with `--resume` after restarts). The hub signals the first allowed edit
inside `approve_tool_use`; Shipline Local then runs `git switch -c <name>` before the call runs. Install and sign in to
Claude Code (`claude`) and the GitHub CLI (`gh auth login`) yourself.

The Electron app is a tray helper only (status, pairing code, open hub, start at login); its signed
build is `pnpm --filter @shipline/local desktop:dist` with the standard electron-builder environment variables
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, ...). None are stored in the repo.

## Plugin and connector

- Bundled with Shipline Local (versioned with the app; `packages/plugin/.claude-plugin/plugin.json`).
  The MCP tools are `get_my_work`, `get_ticket_context`, `submit_artifact`, `propose_stage_transition`,
  `search_jira_issues`, `get_jira_issue`, `link_jira_issue` (and `approve_tool_use` for permission prompts).
- Private marketplace: `.claude-plugin/marketplace.json` at the repo root. Force-install it for your
  org with managed settings (`extraKnownMarketplaces` + `enabledPlugins`).
- Plain Claude Code / Desktop: add the connector `{BACKEND_URL}/mcp` (OAuth sign-in on first use).

## Open questions (plan section) and how v1 handles them

Search the code for `OPEN-QUESTION #` to find each decision point. Numbers 1-11 follow the plan;
`#12` marks judgment calls made in the continuous-flow revision (stage roles, base branch, merge ending
the chat); unnumbered `OPEN-QUESTION` comments mark the chat-first (b) revision's calls.

## CLI: `npx @forgeyard/shipline init` (v2 direction)

Plan: `docs/plans/shipline-v2-repo-init.md`. The `packages/cli` package installs Shipline into any repo so
that everyone using Claude Code there follows the same workflow, with nothing to install on clone.

```bash
npx @forgeyard/shipline init          # in the target repo (add --dry-run to preview)
# then, in Claude Code:  /shipline-setup
```

`init` vendors, and you commit to the repo: `.shipline/` (config.yml, workflows feature/bugfix/hotfix,
`rules/<stage>.md`, dependency-free `bin/*.mjs` hook and stage scripts), `.claude/agents`,
`.claude/skills/shipline-setup` and `shipline-workflow`, hooks merged into `.claude/settings.json`
(SessionStart, UserPromptSubmit, PreToolUse) and a `<!-- shipline:start -->` block in `CLAUDE.md`.
It never overwrites: any name collision aborts with nothing written, and re-running it reports "already
initialized". Needs Node 18+ on teammates' machines.

- Workflow config is YAML, read by a tiny built-in parser (a constrained subset), so hooks have no deps.
- Per stage: `enforcement` (`guide` | `warn` | `block`) and `confirm_to_advance`. By default source edits
  are blocked until plan is done and `git commit` / `gh pr create` until verify is done. Malformed config
  fails open with a visible warning.
- State: tasks (`manifest.json` plus artifacts), session state and UI data are stored outside the repo, in
  `$SHIPLINE_HOME/projects/<repo path, non-alphanumerics as "-">/` (`SHIPLINE_HOME` defaults to `~/.shipline`),
  the same way Claude Code keeps its chats. They are personal, not shared through git; a new session resumes
  unfinished tasks from the manifests there. `init` adds `Read(~/.shipline/**)` and `Edit(~/.shipline/**)` allow
  rules so Claude can write artifacts without prompts; with a custom `SHIPLINE_HOME` Claude asks for permission
  instead. If you move or rename the repo folder the store key changes and its tasks appear to be gone (the old
  store folder stays on disk).
- Claude records progress with `node .shipline/bin/stage.mjs start|advance|skip|reopen|status|resume`.
- `packages/plugin` is now only a wrapper exposing `/shipline:init`. The hub (`apps/*`) is untouched and
  is removed in a later phase.

### `npx @forgeyard/shipline ui` (optional)

```bash
npx @forgeyard/shipline ui [dir] [--port <n>] [--no-open]   # Node 20+ for this command; init and the hooks stay on Node 18
```

Starts a local web server on `127.0.0.1` (random port unless `--port`) for the checkout it is run in, and
opens `http://127.0.0.1:<port>/?t=<token>` in your browser; Ctrl+C stops it. The token is swapped for a
cookie on first load, and requests with a foreign `Host` or `Origin` are refused. It is optional: the hooks
enforce the workflow with or without it. Phase 1 has two screens:

- **Setup:** a form for `config.yml`, `workflows/*.yml` and `rules/<stage>.md`. Saving shows a diff first,
  keeps fields it doesn't know, keeps the comments of the shipped templates (other comments are listed as
  removed before you confirm) and lists open tasks that keep the old stage list. Commit the files after
  saving. `/shipline-setup` and the UI can be used in either order.
- **Tasks:** each unfinished task with its stages, task-folder files and the working-tree changes, updated
  live as files change. A Diagnostics view shows versions, watch mode and the tail of
  `<store>/ui/ui.log`.

Banners: a repo initialized by an older Shipline (`.shipline/bin/VERSION` missing or lower interface) shows
an information banner listing what its hook scripts lack. A repo set up by a newer Shipline makes saving
read-only and shows the `npx @forgeyard/shipline@<version> ui` command to run. If something breaks, nothing is lost:
the repo files are plain files, and a Claude session can always be continued in a terminal with
`claude --resume <id>`.
