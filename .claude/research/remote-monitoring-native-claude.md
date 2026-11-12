# What Claude Code natively provides for monitoring and steering a local session from a phone (as of 2026-11-09)

## Question and scope

What do Anthropic and Claude Code already provide for watching and steering a locally running Claude Code session from a phone or another device? The report covers Remote Control, the mobile app and claude.ai/code, cloud sessions and teleport, push notifications, channels, Slack and Claude Tag, the Agent SDK, and remote permission approval. It ends with a gap analysis for Shipline (`@forgeyard/shipline`: staged workflow, hooks in `.claude/settings.json`, "Advance?" / "Not yet" approval gates).

Depth: deep, by one researcher. All feature claims below come from pages on code.claude.com or claude.com/docs that I fetched on 2026-11-09. Those docs describe fast-moving features with many version-specific notes. Anything I could not fetch is labeled "unverified".

## Bottom line

- Anthropic already ships most of the "I'm away from my machine" feature. **Remote Control** shows a live local session in the Claude phone app and at claude.ai/code. It lets you send messages and attachments and answer permission prompts and `AskUserQuestion` questions. It also sends push notifications when work finishes or a decision is needed. It works with an interactive `claude` session started with `claude --remote-control` or `/remote-control`. It needs a claude.ai subscription login. It does not work with API keys, Bedrock/Vertex/Foundry, or a custom `ANTHROPIC_BASE_URL`.
- A Shipline approval gate that is implemented as an `AskUserQuestion` call or as a normal permission prompt should therefore already reach a phone. The docs state that those two things are kept open and forwarded. Shipline does not need its own relay for that. I could not find a doc that mentions Stop hooks under Remote Control, so a gate built on a Stop hook is unverified.
- What Anthropic does not provide is any awareness of Shipline's workflow. Native surfaces show a chat transcript, not "stage 3 of 5, verify, waiting on gate". The only native extension points that run on your machine and that a third party controls are hooks, MCP servers, channels, and the local cross-session socket. Nothing lets a third-party tool add a custom panel to the Claude phone app.
- Recommendation: do not build a transport (relay, push service, mobile app, auth). Build only Shipline-specific content on top of native transport. Two options:
  - **Cheap:** hooks that tell Claude to call the native `PushNotification` tool, or that write stage state to a file or status line.
  - **More work:** a small Shipline channel plugin, an MCP server that declares `claude/channel` and the permission-relay capability, for users who want Telegram/Discord/iMessage-style stage summaries and "yes/no" approvals. During the research preview, a custom channel needs `--dangerously-load-development-channels`, or an official-marketplace listing or an org allowlist.

## Findings

### 1. Remote Control (local session, remote window)

Source: [Remote Control docs](https://code.claude.com/docs/en/remote-control).

- **What it does:** The Claude iOS/Android app or claude.ai/code becomes a window into a Claude Code process running on your machine. Execution and filesystem access stay local. MCP servers, tools, and project config stay available. The conversation, subagent progress, and dynamic-workflow progress stay in sync across terminal, browser, and phone. You can send images and files from the phone. Sessions reconnect automatically after sleep or a network drop.
- **How to enable:**
  - `claude remote-control`: server mode, which handles multiple concurrent sessions in one process (default capacity 32; `--spawn worktree` gives each its own worktree). It shows a URL and a QR code.
  - `claude --remote-control` (or `--rc`): a normal interactive session that is also remote.
  - `/remote-control` or `/rc` inside a running session. This carries over the current conversation.
  - Auto-connect: `/config` -> "Enable Remote Control for all sessions", or `remoteControlAtStartup: true` in `~/.claude/settings.json`. A project `.claude/settings.json` can set `false` but its `true` is ignored, so Shipline cannot turn it on for users by committing a setting.
  - Also available in VS Code (`/remote-control`) and the Desktop app.
- **How it works:** The local process makes only outbound HTTPS calls and opens no inbound ports. It registers with the Anthropic API and polls for work, and the Anthropic server routes messages between the client and the local session over a streaming connection, using short-lived scoped credentials. The session transcript, including your messages, Claude's replies, and tool activity, is stored on Anthropic servers while connected.
- **Requirements:**
  - Pro, Max, Ultra, Team, or Enterprise plan. API keys are not supported.
  - On Team and Enterprise, an Owner must enable the toggle. Custom roles may need an extra permission.
  - A claude.ai login via `/login`.
  - Not available on Bedrock, Google's Agent Platform, or Foundry, with `ANTHROPIC_BASE_URL` pointing away from api.anthropic.com, or with a Claude apps gateway.
  - Not available with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK` set.
  - Not available for Zero Data Retention or HIPAA-configured orgs.
  - Optional "Trusted Devices" (beta) requires enrolled devices and a sign-in under 18 hours old.
- **What the phone sees and can do:**
  - It sees the live transcript, tool activity, and a diff pane of the git changes.
  - It can send messages and attachments.
  - It can change model and effort.
  - It can stop background subagents and workflows.
  - It can change permission mode to Manual, Accept edits, Plan, or Auto. It cannot select Bypass ([mobile docs](https://code.claude.com/docs/en/mobile)).
  - A subset of slash commands works from the phone: `/compact`, `/clear`, `/context`, `/usage`, `/model x`, `/effort x`, `/config key=value`, `/mcp`, and others. `/plugin` and `/resume` are local-only.
  - Docs state that "Claude Code keeps permission prompts and `AskUserQuestion` questions open until you answer them", so those prompts are visible and answerable remotely. Other forwarded dialogs expire after 5 minutes by default (`dialogExpiry`).
  - The docs do not describe how the permission prompt looks on the phone. The permission-modes page says it does not describe prompt delivery.
- **Limits:**
  - The machine must stay on and the `claude` process must keep running. Use tmux or screen over SSH.
  - An interactive process supports one remote session. Use server mode for several.
  - Server mode exits after about 10 minutes of network outage.
  - An interactive session retries indefinitely.
  - Server-mode resume works for about 4 hours after the server stops.
  - In server mode, a global flag such as `--settings` placed before `remote-control` makes it refuse to start, and `--sandbox` was removed.
  - Terminal-only dialogs, such as the Fable usage-credits consent prompt, are not forwarded.
- **Third-party hook-in:**
  - Hooks and MCP servers configured in the project run on the local machine, so they run in a Remote Control session. This is an inference, not a doc statement. I found no doc that explicitly confirms Stop or Notification hooks fire for remote-driven turns.
  - Claude Code exports a per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`) and token to hooks and Bash. A script or hook can post a message into its own session over it ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)). Messages from other sessions cannot answer a permission prompt.
  - Your own session's hook or child process is treated as "own child" and is delivered by default.
  - Native Windows requires an auth line with the token on the socket. macOS and Linux do not.

### 2. Claude mobile app and claude.ai/code

Sources: [Mobile docs](https://code.claude.com/docs/en/mobile), [Platforms](https://code.claude.com/docs/en/platforms).

- The mobile app has no separate Claude Code app. The **Code** tab lists cloud sessions, projects, Remote Control sessions (computer icon with a green dot when online), and Dispatch tasks.
- Setup:
  - Install the Claude app, sign in with the same account and org, and open the Code tab.
  - `/mobile`, `/ios`, or `/android` in Claude Code shows a QR code for the app store.
  - claude.ai/code in any browser is the same surface.
- Limits:
  - It needs a claude.ai account. It does not work with a Console API key or third-party providers.
  - It is a thin client. It cannot extend or render Shipline-specific UI.
  - Dispatch needs a Pro, Max, or Ultra plan and is not available on Team or Enterprise.
  - Bypass permissions cannot be selected from the app.

### 3. Claude Code on the web, cloud sessions, teleport

Source: [Cloud docs](https://code.claude.com/docs/en/claude-code-on-the-web).

- **What it does:** A session runs on Anthropic-managed (or self-hosted-runner) infrastructure. It keeps running when your laptop is closed and can be steered from any device.
- **How to start:** From a browser, the Code tab on mobile, `claude --cloud "task"`, or the Desktop app. Cloud scheduled tasks also run as cloud sessions.
- **Requirements:**
  - Pro, Max, Ultra, or Team. Enterprise needs premium or Chat + Claude Code seats.
  - A claude.ai login, not an API key, with GitHub connected through the GitHub App or `/web-setup`.
  - Not available on Bedrock/Vertex/Foundry, Zero Data Retention, HIPAA, or customer-managed-key orgs.
- **Terminal to cloud:** `claude --cloud` creates a NEW cloud session from the current branch as it exists on GitHub, or uploads a bundle of the local repo. From the CLI, an existing local session cannot be pushed to the cloud. Only the Desktop app can send a local session to the cloud, via "Open in".
- **Cloud to terminal:** `claude --teleport <id>`, `/teleport`, or `/tasks` then `t`. This needs a clean git state, the same repo, the branch pushed, and the same account. After teleport, the terminal gets its own copy. New work there does not appear in the cloud session, and you must run `/remote-control` to steer it from the phone again.
- **Follow-ups:** `claude -p "msg" --cloud <session-id>` queues a message into a cloud session from any machine, and works from CI. It prints `{ok, session_id, url}` with `--output-format json`.
- **Limits:**
  - It needs GitHub, or a local bundle that cannot push back to a non-GitHub remote.
  - The VM is reclaimed after inactivity, and conversation history survives but running processes do not.
  - Rate limits are shared with the rest of your usage.
  - It runs from a fresh clone, so local MCP servers, uncommitted state, and untracked files are not there. Repo `.claude/settings.json` and `.claude/agents/` do load.
  - The `Shipline` hooks would run in the cloud VM only if committed in the repo. Local-only or user-level config would not follow.
- **Auto-fix PRs:** Claude subscribes to a PR and reacts to CI failures and review comments. This needs the Claude GitHub App.

### 4. Push notifications

Sources: [Remote Control, push section](https://code.claude.com/docs/en/remote-control#mobile-push-notifications), [Tools reference](https://code.claude.com/docs/en/tools-reference), [Hooks reference](https://code.claude.com/docs/en/hooks).

- **Native mobile push:**
  - While Remote Control is active, Claude can push to the phone when a long task finishes or when it needs a decision. You can also ask in a prompt ("notify me when the tests finish").
  - Enable it with `/config`: "Push when Claude decides" (proactive) and "Push when actions required" (permission prompts and questions). The docs say there is no other per-event configuration.
  - It needs the app installed, signed in, and OS notification permission.
  - Pushes are skipped while you are typing in the terminal. `CLAUDE_CLIENT_PRESENCE_FILE` extends that to "at the machine".
  - If `/config` shows "No mobile registered", open the app so it can refresh its push token.
- **`PushNotification` tool:** A built-in tool that Claude (the model) calls. It sends a desktop notification from a local session, and a phone push with Remote Control or in a cloud session. Push goes through Anthropic infrastructure, so it is not available on Bedrock, Vertex, or Foundry. It does not need permission. There is also a `SendUserFile` tool that sends a file (a report, screenshot, or artifact) to a connected Remote Control client or cloud session.
- **Notification hook:** This is local only and cannot block or modify anything. It fires on notification types including `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, and `agent_completed`. The input includes `message`, `title`, and `notification_type`. A hook can run any script (curl a webhook, ntfy.sh, Slack). `terminalSequence` output can emit OSC desktop notifications, but only in interactive sessions.
- **Third-party hook:** A third party can either call its own push service from a `Notification` or `Stop` hook, or have a hook tell Claude to call `PushNotification`. The second works for any hook that can inject text, such as `Stop` with `decision: block`/`reason`, or `additionalContext`, because the tool is model-invoked and not hook-invokable. This is my inference from the docs.
- **Known problems (unverified):** Search snippets point to GitHub issues, for example that `PushNotification` returns "Remote Control inactive" from scheduled tasks and non-RC sessions. They also report some "success but no banner" cases that are marked resolved. I could not open those issue pages (`claudeissues.com` did not resolve), and I did not verify their dates or resolution. The first point is consistent with the documented requirement that Remote Control be active.

### 5. Channels (Telegram, Discord, iMessage, your own server)

Sources: [Channels](https://code.claude.com/docs/en/channels), [Channels reference](https://code.claude.com/docs/en/channels-reference).

- **What it does:** A channel is an MCP server, run as a local subprocess over stdio, that pushes events into your running session as `<channel>` tags. Two-way channels add a `reply` tool. Officially supported: Telegram, Discord, iMessage (macOS only), and a localhost "fakechat" demo. These plugins need Bun.
- **Status:** Research preview. The `--channels` flag and protocol "may change". `--channels` accepts only plugins on an Anthropic allowlist, or an org allowlist (`allowedChannelPlugins`). The flags are not shown in `claude --help`.
- **How to enable:**
  - `/plugin install telegram@claude-plugins-official`, then `/telegram:configure <token>`, then restart with `claude --channels plugin:telegram@claude-plugins-official`.
  - Pair by DMing the bot, then `/telegram:access pair <code>` and `/telegram:access policy allowlist`.
  - A channel only receives events while the session is open. For always-on use, run Claude in a persistent process.
- **Requirements:**
  - A claude.ai login or a Console API key. Not available on Bedrock/Vertex/Foundry.
  - Team and Enterprise orgs must enable `channelsEnabled` (Owner, in admin settings or managed settings).
  - Pro, Max, and Ultra users without an org skip the org checks.
- **Remote permission approval:** A channel that declares `capabilities.experimental['claude/channel/permission']` receives `notifications/claude/channel/permission_request` messages with `request_id`, `tool_name`, `description`, and `input_preview`. It returns `notifications/claude/channel/permission` with `behavior: allow` or `deny`.
  - The terminal dialog stays open in parallel. Whichever answer arrives first wins.
  - It covers tool-use approvals (Bash, Write, Edit). It does NOT relay project-trust dialogs or MCP-server consent dialogs.
  - Claude Code 2.1.211 and later sanitizes and caps fields at 3,500 code points. 2.1.234 and later masks recognizable credential tokens.
  - The channel must gate on sender identity. Anyone who can reply through it can approve tool use.
  - The docs do not say whether `AskUserQuestion` prompts are relayed through this capability. Only Remote Control is documented to forward `AskUserQuestion`.
- **Extension:** Building your own channel needs `@modelcontextprotocol/sdk`, the `claude/channel` capability, and `notifications/claude/channel` events. A webhook receiver example is in the docs. While the preview lasts, custom channels need `--dangerously-load-development-channels` (interactive only, with a full-screen warning at each launch), or a listing in claude-plugins-official via an Anthropic partner contact, or an org allowlist entry. The community marketplace is not on the allowlist. Shipline's CLI cannot add flags to the user's `claude` launch, so users would need to launch Claude with these flags themselves.

### 6. Slack, Claude Tag, Dispatch

Sources: [Claude Code in Slack](https://code.claude.com/docs/en/slack), [Claude Tag overview](https://claude.com/docs/claude-tag/overview), [Desktop: Dispatch](https://code.claude.com/docs/en/desktop).

- **Claude Code in Slack (earlier version):**
  - It works on Pro, Max, and Ultra, only in Slack workspaces not connected to Claude Tag. `@Claude` in a channel (not DMs) starts a cloud session on GitHub repos.
  - The docs say the legacy bot "is retired effective October 5, 2026" in workspaces connected to an org. Per the docs it still serves individual-plan workspaces not connected to Claude Tag.
  - It posts progress and a completion DM, with "View session" and "Create PR" buttons.
  - It is cloud-only, so it cannot reach a local session.
- **Claude Tag:**
  - It is Public Beta, for Team and Enterprise plans only, and not for individual plans or third-party providers.
  - It runs `@Claude` in Slack as the org's shared identity, in an ephemeral sandbox, not on your computer.
  - It bills by usage against an org balance with a spend limit.
  - Admins extend it with connectors, plugins, and skills.
  - It can run scheduled jobs and watch monitors.
  - It is the wrong shape for steering a local session.
- **Dispatch:** Message a task from the phone app to the Desktop app (Pro, Max, or Ultra only, not Team or Enterprise). It spawns a local Code session. It sends a push when the session finishes or needs approval. Its approvals expire after 30 minutes.

### 7. Agent SDK / headless and remote approval

Sources: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input), [Hooks reference](https://code.claude.com/docs/en/hooks).

- **Headless:** `claude -p` supports `--output-format stream-json`, `--resume`, `--permission-mode`, and `--bare`. `--bare` skips hooks and auto-discovery and does not use subscription OAuth, so it takes `ANTHROPIC_API_KEY`. `-p` and SDK runs are not Remote Control sessions and do not appear in the phone app.
- **SDK approvals:**
  - `canUseTool` (TS and Python) fires on tool approvals and `AskUserQuestion`. It can stay pending indefinitely, so your own app can show these in any UI, including a web page or chat bot.
  - Streaming input lets you send new user messages mid-run.
  - The docs suggest a `PermissionRequest` hook for sending Slack, email, or push notifications when Claude is waiting.
  - A `PreToolUse` hook can return `defer`, honored only with `-p`. The process exits with `stop_reason: "tool_deferred"` and the caller resumes with `--resume`. This is a documented pattern for "pause, collect input elsewhere, resume".
- **Hooks as an approval layer:** `PermissionRequest` hooks can return `allow` or `deny` through `hookSpecificOutput.decision`. Exit code 2 is not honored there. For `AskUserQuestion`, a hook can return `updatedInput` with `answers`, so a hook can answer the question programmatically. Hook types are `command`, `http`, `mcp_tool`, `prompt`, and `agent`. An `http` hook POSTs the event JSON to a URL, which is a direct way to feed an external service.
- **Plan and cost implications:** Building Shipline's own remote layer on the SDK means a headless process owned by that tool. That process would not benefit from the native phone UI, and `--bare` plus API-key mode excludes subscription auth.

### 8. Remote permission approval, summary

| Route | Covers | Needs |
|---|---|---|
| Remote Control (phone/web) | Tool prompts and `AskUserQuestion`, kept open until answered | claude.ai login, RC on |
| Channel with permission relay | Tool-use prompts (not trust or MCP-consent dialogs) | Channel plugin, `--channels` or dev flag, org allowlist |
| `PermissionRequest` hook | Programmatic allow/deny (your own logic, including an external service) | Hook config, local |
| SDK `canUseTool` | All prompts for a process you own | Using the SDK, not an interactive CLI session |
| Dispatch | Approvals for Desktop-spawned sessions | Desktop, Pro/Max/Ultra, 30-minute expiry |

Third-party tools exist that use hooks instead of Remote Control, for example claude-remote-approver, ccgram, and claude-ntfy-hook. They turned up in search results, and I did not fetch them. They show a demand for approvals over ntfy or Telegram. Whether Remote Control satisfies that demand reliably is questionable, given the bug reports below.

## Disagreements and uncertainty

- **Remote approval reliability:** Search results listed several GitHub issues, for example "approving permission from phone hangs Claude Code on host", "phone-app approval dismisses popup but never reaches local process", and a report that a hook-approved command still prompts on the phone. Several were marked resolved. I could not open them, so dates, versions, and fixes are unverified. The official docs say nothing about these problems. Treat remote approval as working per docs but test it before relying on it for gates.
- **Hooks under Remote Control:** The docs do not say whether `Stop` and `Notification` hooks fire for turns driven from the phone. By design they run in the local process, so they should, but I found no primary confirmation.
- **Permission prompt presentation on phone:** Not described in the docs I fetched. The permission-modes page says it does not describe prompt delivery.
- **How a Shipline "Advance?" gate is implemented determines whether it reaches the phone.** I did not read Shipline's code. If it uses `AskUserQuestion` or a normal permission prompt, the docs say it is forwarded. If it is a plain text question at the end of a turn with a `Stop` hook, it appears as an ordinary message that the phone user can reply to, but without a purpose-built approve button.
- **Channel availability is in flux:** The docs call channels a research preview with a rolling rollout, an allowlist, and a protocol that may change. Channels and Remote Control also depend on a specific minimum Claude Code version for several features (for example permission relay behavior changed in 2.1.234).
- **Slack/Claude Tag retirement date:** The Slack page says the legacy bot was retired on October 5, 2026 for connected workspaces. I read the notice but did not verify it on a separate page.
- **Not checked:** Pricing or usage-limit specifics for Remote Control (the docs say only that sessions count toward plan usage), mobile-app screenshots, and the exact UI for approving on the phone. I did not read the `AskUserQuestion tool behavior` section of the tools reference. The `Monitor` tool, scheduled tasks, and background agents are out of scope here.

## Gap analysis for a Shipline remote feature

**Redundant to build (native already covers it):**
- A transport, auth, or relay between a laptop and a phone (Remote Control).
- A mobile client or web viewer for the live transcript, diff, and file attachments (Claude app and claude.ai/code).
- Basic push notifications for "finished" or "needs a decision" (`PushNotification` plus the two `/config` toggles).
- Tool-permission approval from the phone (Remote Control, or channels permission relay).
- Cloud execution, GitHub-based tasks, and PR auto-fix (cloud sessions, Claude in Slack/Claude Tag).
- Sending a message to a running session from another machine or script (cross-session socket; `claude -p --cloud <id>` for cloud sessions).

**What Shipline could add, in rough order of value for effort:**
1. **Make gates phone-friendly.** Make sure "Advance? / Not yet" is an `AskUserQuestion` with two options, not free text. The docs say Remote Control keeps those open and shows them. Add a `Notification`/`Stop` hook so a push fires specifically when a gate is waiting. Native "Push when actions required" may already cover `AskUserQuestion`. The docs say it covers "permission prompts and questions". Test this.
2. **Stage and progress summary.** Native surfaces show a transcript only. Shipline knows the stage, which hooks blocked what, and what is waiting. A hook could write a one-line status (stage, blocked step, gate pending) to a file, the status line, or the notification text. That would give a push like "Shipline: verify passed, waiting to advance to pr", instead of a generic one. A `PushNotification` call through the model is the lowest-cost delivery. A webhook or ntfy.sh call from the hook is the most reliable.
3. **A `/shipline-status` command or skill** that prints stage state as plain text. `/` commands that produce text output work from mobile, but skills may not be invocable from the phone like built-ins, so this needs testing.
4. **Remote Control hygiene helpers in `init`:** For example, a setup step that checks for a claude.ai login, shows `/remote-control` and `/config` push toggles, and warns when `ANTHROPIC_BASE_URL`, API-key auth, or a Bedrock/Vertex env makes Remote Control unavailable. Because project settings cannot enable auto-connect, this has to be guidance and not config.
5. **Optional Shipline channel plugin** (two-way, with permission relay) for users who prefer Telegram or Discord, or who must use API-key auth. It is the only native route that works with a Console API key. It is also the only route for custom, structured "Advance? yes/no" messages and stage digests in a chat app. It costs a lot to maintain: it needs Bun or Node, a sender allowlist, and pairing flow. Under the research preview it also needs `--dangerously-load-development-channels` each launch, or an allowlist listing, so it is a poor default.
6. **A fallback path for users native cannot serve:** API-key, Bedrock/Vertex/Foundry, gateway, ZDR/HIPAA, or strictly offline-from-Anthropic users. They get no Remote Control and no PushNotification. A hook-based `http`/ntfy.sh approval and notification path would be the one place where Shipline adds capability natively unavailable. Several third-party projects already do this (see section 8), so check whether they are good enough to recommend instead of building.

**Suggested scope:** Start with items 1, 2, and 4: hook content and docs, no new infrastructure. Treat 5 and 6 as separate, opt-in experiments to be justified by user demand. Before building anything, run a manual test of an `AskUserQuestion` gate through Remote Control on a phone, including with a `PreToolUse`/`PermissionRequest` hook in the loop, since the unresolved bug reports are about exactly that path.

## Sources

Fetched and read, on 2026-11-09:
- [Continue local sessions from any device with Remote Control](https://code.claude.com/docs/en/remote-control)
- [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Claude Code on mobile](https://code.claude.com/docs/en/mobile)
- [Push events into a running session with channels](https://code.claude.com/docs/en/channels)
- [Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Hooks reference](https://code.claude.com/docs/en/hooks) (first 200,000 of about 290,000 characters read)
- [Tools reference](https://code.claude.com/docs/en/tools-reference) (tool table read; per-tool behavior sections not read)
- [Platforms and integrations](https://code.claude.com/docs/en/platforms)
- [Claude Code in Slack](https://code.claude.com/docs/en/slack)
- [Claude Tag overview](https://claude.com/docs/claude-tag/overview)
- [Message your other Claude Code sessions](https://code.claude.com/docs/en/cross-session-messaging)
- [Handle approvals and user input (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Permission modes](https://code.claude.com/docs/en/permission-modes) (first 100,000 of about 120,000 characters read)
- [Desktop app, Dispatch section](https://code.claude.com/docs/en/desktop) (first 100,000 of about 225,000 characters read)

Search results only, not fetched or not openable (treat as unverified):
- GitHub issues on remote-approval and `PushNotification` behavior, as listed on claudeissues.com (issue numbers 49756, 52084, 62553, 59855, 29214, 59623, 48852) and github.com/anthropics/claude-code/issues/32493 and /60220. Fetch failed with a DNS error.
- Third-party approval tools: github.com/yuuichieguchi/claude-remote-approver, github.com/jsayubi/ccgram, adrian-gomez.github.io/claude-ntfy-hook.
- Blog posts on channels and the `PushNotification` tool, which I did not rely on for claims.
