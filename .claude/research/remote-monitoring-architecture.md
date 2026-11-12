# Remote monitoring / reply for a local Claude Code session: architectures and security

Date researched: 2026-11-09. Depth: deep (single researcher, many fetches, cross-checked where possible).

## Question and scope

What are the viable architectures for a small open-source CLI with no server (Shipline, `@forgeyard/shipline`, Node 18+, MIT) to let a user watch and reply to a local Claude Code session from a phone, and what are the security risks? Compared: (1) hook-based notification only, (2) two-way chat bridges and the ways a reply gets back into a running session, (3) local web UI via tunnel as a PWA, (4) hosted relay with E2E encryption. Each is covered for how it works, build effort, who pays and runs the server, latency, sleep and offline behaviour, and failure modes. Then a threat model, mitigations, and a phased recommendation.

Labels: "(inference)" means my reasoning, not a fetched source. "(unverified)" means I could not confirm it from a primary source.

## Bottom line

1. **Claude Code now ships two first-party ways to do this: Remote Control and Channels.** Shipline should not build a transport. Remote Control (phone via the Claude app or claude.ai/code) covers "see it and send messages" with outbound-only connections and push notifications. Channels (an MCP server that pushes chat messages into the session) covers Telegram and Discord with a sender allowlist and optional permission relay. Both are documented on code.claude.com as of this research. Remote Control needs a claude.ai subscription login (API keys are not supported). Channels is a "research preview" whose flags may change.
2. **Shipline's real contribution is the gate, not the pipe.** Its gates ("Advance?" / "Not yet") are a small, bounded decision. That is the safest thing to expose remotely, much safer than free-text chat or arbitrary tool approval.
3. **Recommended v1 (smallest useful):** notification-only through hooks to a pluggable sink (ntfy as the default, with a custom webhook). This is a few hundred lines of Node, with no server and no inbound ports. The message says "Gate reached: Advance?" and deep-links to the Remote Control session when the user has it on. Phase 2 is a gate-only reply channel. Phase 3 is optional and only if demand is proven: a Shipline channel plugin or a hosted relay. See "Recommended phases".
4. **Do not use `tmux send-keys` / PTY injection as a supported path.** It has no authenticated structure, shares a keyboard with whatever is focused, and the audited community bridges flag it as high risk (details below).
5. **The biggest risk is the same in every design.** Anyone who can type to the session can act as the developer. Permission relay lets a chat reply approve Bash and Write calls. Anthropic's own docs say so plainly.

## Important prior art: what Claude Code already provides

### Remote Control (first party)
- Connects claude.ai/code or the Claude iOS/Android app to a session running on the user's machine. Execution and filesystem stay local. ([Remote Control docs](https://code.claude.com/docs/en/remote-control))
- Local Claude Code "makes outbound HTTPS requests only and never opens inbound ports". It registers with the Anthropic API and polls for work. Traffic goes through the Anthropic API over TLS, with short-lived scoped credentials. The session transcript (messages, responses, tool activity) is stored on Anthropic servers while connected. It is not described as end-to-end encrypted. ([same](https://code.claude.com/docs/en/remote-control))
- Sleep and network loss: "if your laptop sleeps or your network drops, Claude Code reconnects automatically when your machine comes back online." But the computer must stay on and the `claude` process must keep running. After `claude remote-control` is stopped, sessions can be revived for about four hours. ([same](https://code.claude.com/docs/en/remote-control))
- Requirements: Pro/Max/Ultra/Team/Enterprise. API keys not supported. Not available with Bedrock/Vertex/Foundry, a custom `ANTHROPIC_BASE_URL`, or ZDR/HIPAA orgs. Some env vars that disable telemetry or feature flags make it unavailable. ([same](https://code.claude.com/docs/en/remote-control))
- Push to phone: with Remote Control active, `/config` can enable "Push when actions required" for permission prompts and questions. ([same](https://code.claude.com/docs/en/remote-control))
- Trusted Devices (beta): optional device enrollment plus a sign-in no older than 18 hours, with biometric step-up. Off by default. ([same](https://code.claude.com/docs/en/remote-control))
- `remoteControlAtStartup` set in project settings can only turn it off, never on, so a checked-in file cannot enable Remote Control for everyone. ([same](https://code.claude.com/docs/en/remote-control))
- One third-party summary reported disconnect and reconnect stability issues in early testing. This is weak evidence; see Disagreements.

### Channels (first party, research preview)
- A channel is an MCP server that Claude Code spawns over stdio. It pushes `notifications/claude/channel` events into the running session. A two-way channel exposes a `reply` tool. Chat plugins poll the platform's API, so there is no URL to expose. Events arrive only while the session is open. ([Channels](https://code.claude.com/docs/en/channels), [Channels reference](https://code.claude.com/docs/en/channels-reference))
- Official Telegram, Discord, iMessage and a localhost "fakechat" demo exist. Setup uses a BotFather token (stored at `~/.claude/channels/telegram/.env`), a pairing code, then `/telegram:access policy allowlist`. They need Bun. ([Channels](https://code.claude.com/docs/en/channels))
- Custom channels are not on the approved allowlist. They need `--dangerously-load-development-channels`, which is ignored in `-p` mode and under the Agent SDK. Team and Enterprise orgs must enable channels. Pro/Max users without an org skip those checks. ([Channels reference](https://code.claude.com/docs/en/channels-reference))
- Permission relay: a channel that declares `claude/channel/permission` gets tool-approval prompts (Bash, Write, Edit) with a 5-letter request ID. The terminal dialog stays open, and whichever answer arrives first wins. Claude Code sanitizes and credential-masks `description` and `input_preview` (v2.1.211 and later, and v2.1.234 and later). Secrets without a recognizable prefix are not masked. ([Channels reference](https://code.claude.com/docs/en/channels-reference))
- Docs on security: "An ungated channel is a prompt injection vector." Gate on sender ID, not chat or room ID. "Anyone who can reply through the channel can approve or deny tool use in your session." ([Channels reference](https://code.claude.com/docs/en/channels-reference), [Channels](https://code.claude.com/docs/en/channels))
- The permission dialog on the terminal and project-trust or MCP-consent dialogs do not relay. The latter two appear only locally. ([Channels reference](https://code.claude.com/docs/en/channels-reference))

### Hooks (the only extension point a no-server CLI controls on its own)
From the [hooks reference](https://code.claude.com/docs/en/hooks) (I read the first ~100k of ~290k characters, so PermissionRequest and async details are partial):
- `Notification` has matchers `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`. It has no decision control. It is for side effects such as pushing a notification.
- `Stop` fires when Claude finishes responding and includes `last_assistant_message`. It can block (`decision: "block"` plus `reason`, or exit 2) to keep Claude working.
- `PreToolUse` can `allow`, `deny`, `ask` or `defer`. `PermissionRequest` can allow or deny on the user's behalf.
- Default timeout for command/http/mcp_tool hooks is 600 s. A timed-out `PreToolUse` hook does not block by default. `"onFailure": "block"` (v2.1.295+) changes that. **Fail-open versus fail-closed matters for any hook that waits on a phone answer.**
- `async: true` hooks run in the background and Claude Code does not enforce their timeout. `asyncRewake` wakes Claude on exit 2 with stderr as a system reminder.
- `http` hooks exist as a hook type.

### Headless and SDK
- `claude -p` with `--resume <session_id>` or `--continue`, `--output-format stream-json`, and `--permission-prompt-tool` or a `PermissionRequest` hook for approvals. In manual mode a call needing approval is denied unless something approves it. Without `--bare`, `-p` runs the project's hooks and `.mcp.json` servers even in an untrusted folder. ([Headless docs](https://code.claude.com/docs/en/headless))
- `-p` runs a new process per message. It cannot attach to an interactive session that is already running (inference from the docs: resume creates a new run from the transcript file). Two processes writing one transcript is a possible conflict (unverified).

## Option 1: Notification only via hooks

**How it works.** Shipline installs `Notification`, `Stop` and gate-specific hooks that run `shipline notify` and POST to a sink.

| Sink | Notes |
|---|---|
| ntfy.sh or self-hosted ntfy | HTTP PUT/POST, no sign-up. "The topic is essentially a password" on the public server. Up to three action buttons, including `http` actions that POST back. Self-hosted: set `auth-default-access: deny-all` and use `tk_` tokens (tokens grant full account access). iOS instant delivery needs `upstream-base-url: https://ntfy.sh`. Only the message ID and a hash of the topic URL go upstream, not the body. ([publish docs](https://docs.ntfy.sh/publish/), [config docs](https://docs.ntfy.sh/config/)) |
| Telegram bot sendMessage | Needs a BotFather token. Single-chat limit about 1 message per second. The FAQ does not claim E2E encryption. ([FAQ](https://core.telegram.org/bots/faq)) |
| Slack/Discord webhooks | Webhook URL is a secret. Not fetched in this research; details are common knowledge (unverified here). |
| Pushover | Paid app; not fetched (unverified). |
| Web Push to a PWA | iOS needs 16.4+, a Home-Screen-installed web app with a standalone manifest, and a permission request from a user gesture. Delivery goes via APNs. ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) A PWA also needs somewhere to host it and a push server holding VAPID keys, which pushes this toward Option 3 or 4 (inference). |

- **Effort:** low. Hooks plus an HTTP POST, no state. One wizard step to pick a sink and paste a topic or token.
- **Cost / who runs the server:** free on ntfy.sh or Telegram. The user may self-host ntfy. Shipline runs nothing.
- **Latency:** seconds. iOS via self-hosted ntfy is slow without the upstream relay ("delivery can take hours" in some phone states, per ntfy docs).
- **Sleep/offline:** if the laptop sleeps, Claude is not running, so no events fire. Nothing is queued. The phone gets nothing and the user cannot tell "waiting at a gate" from "machine asleep". A heartbeat cannot fix this without a server (inference).
- **Failure modes:** guessable or leaked topic (public ntfy) lets anyone read gate text. Notification text can leak code or secrets from `last_assistant_message`, so send a short generic message by default (inference). A hook failure is non-blocking by default, so notifications silently stop. Hooks that call the network can slow or stall Claude if not run async or with a short timeout (inference from the hook timeout docs).
- **Gate replies:** ntfy `http` action buttons could POST "Advance" to a reply topic that a local watcher polls. That is a two-way design; see Option 2.

## Option 2: Two-way chat bridge (and how replies re-enter the session)

Ways a reply can get back, from safest to least safe:

| Mechanism | How | Strengths | Weaknesses |
|---|---|---|---|
| **A. Hook that blocks and polls** (Shipline-specific) | A gate hook (`Stop` or `PreToolUse`/`PermissionRequest`) sends "Advance?" to the phone, then polls a local file or the sink for "yes/no" until timeout, then returns allow/deny or block | Answers go only to a bounded decision; no free text reaches Claude. Works with the user's normal interactive session. No new auth surface beyond the sink. | Needs the hook alive up to the 600 s default timeout (adjustable). A timed-out `PreToolUse` hook fails open unless `onFailure: block`. A hook that blocks also holds the terminal. Does not allow free-form instructions (inference). Behaviour of `Stop` hooks that wait for a human is not documented as a pattern; test it (unverified). |
| **B. Channels MCP server** (first party) | A Shipline MCP server with `claude/channel`, a `reply` tool, optional permission relay, a sender allowlist | Supported injection path into the live session. Anthropic's own plugins show the pairing and allowlist pattern. | Research preview. Custom channels need `--dangerously-load-development-channels` (interactive only) until allowlisted. Needs claude.ai or Console auth; Team/Enterprise must opt in. Not on Bedrock/Vertex/Foundry. Needs Bun for the official plugins, though Node works for custom ones. ([Channels reference](https://code.claude.com/docs/en/channels-reference)) |
| **C. Remote Control** (first party) | `claude --remote-control` plus the Claude mobile app | Full two-way, no work, outbound-only, push notifications, device trust option | Not E2E (transcript stored by Anthropic). Subscription login required. No Shipline-specific UI, so a gate looks like normal chat unless Shipline adds hooks. |
| **D. Agent SDK or `claude -p --resume` per message** | The bridge owns the session; each phone message starts a run with `--resume`, `--permission-prompt-tool` for approvals | Fully scriptable, structured (stream-json) | It is not the user's live interactive session. Hooks and project MCP servers run unless `--bare` is used. Two processes may touch one session. A full agent host is a big build. |
| **E. `tmux send-keys` / PTY write** | Chat text typed into the terminal | Works with the unmodified TUI | The audited bridges flag it as arbitrary command execution. Text can be injected as keystrokes. A GitHub issue reports queued stale input from a hung `send-keys -l` being processed later as new prompts. Generic key relays let the sender drive the whole TUI and read scrollback. Needs tmux and a fixed pane. Many guides pair it with `--dangerously-skip-permissions`. ([security summary, secondary sources](https://cdn.jsdelivr.net/npm/claude-telegram-mirror@0.2.27/SECURITY.md)) Use only as an escape hatch (inference). |

- **Effort:** A is small. B is medium (MCP server, pairing, allowlist, tests). C is zero. D is large. E is small but risky.
- **Cost / who runs the server:** Telegram and Discord are free and hosted by the vendor. The bot polls outbound (`getUpdates`), so no inbound port is needed ([Telegram FAQ](https://core.telegram.org/bots/faq)). Channels plugins poll the same way ([Channels reference](https://code.claude.com/docs/en/channels-reference)).
- **Latency:** seconds. Telegram polling is near real time. Telegram suggests no more than about 1 message per second per chat.
- **Sleep/offline:** Telegram queues messages server-side while the poller is down, but a stale approval could be applied later when the poller resumes (inference; use request IDs and expiry). Channels: "events only arrive while the session is open" and "there is no persistent daemon" for closed sessions. Remote Control reconnects after sleep.
- **Failure modes:** leaked bot token (anyone can read messages the bot sees and impersonate the bot, but cannot message the session unless the sender allowlist is bypassed; the official plugin stores the token in `~/.claude/channels/telegram/.env`). Group chats: gating on chat ID rather than sender ID lets anyone in the group inject (docs call this out). Telegram stores message content on its servers; bots are not shown as E2E (the FAQ page is silent on this).

## Option 3: Local web UI exposed via tunnel (PWA)

**How it works.** Shipline runs a local HTTP server (the wizard already proves Shipline can do this) with a status page and gate buttons. A tunnel makes it reachable from the phone:

| Tunnel | Key facts |
|---|---|
| Tailscale Serve | Shares a local service "within your tailnet"; automatic HTTPS cert; `Funnel` is the separate command that exposes it publicly. ([Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)) Identity headers and whether the phone needs the Tailscale app were not stated on that page; the phone almost certainly needs the app and login (inference). |
| Cloudflare Tunnel | `cloudflared` makes outbound-only connections; the origin needs no public IP. ([Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)) Quick Tunnels need no account, but are "for testing and development", have no uptime guarantee, **do not support SSE**, and the hostname changes each time. ([Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)) Authentication needs Cloudflare Access plus an account and domain (not covered on the pages I fetched). |
| ngrok | Not fetched. Free plan limits and auth options are unverified here. |

- **Effort:** medium to high. Needs a UI, an auth layer, a session/event model, the tunnel setup, PWA manifest and service worker, and (for notifications) Web Push with VAPID keys and a push endpoint that must be reachable even when the page is not open.
- **Cost:** Tailscale free personal tier (not verified here). The user owns accounts and installs a second tool. Shipline runs nothing, but supports a tunnel the user must configure.
- **Latency:** low when connected (SSE or websockets).
- **Sleep/offline:** worst case of all options. A sleeping laptop is unreachable, a tunnel drop means no view, and nothing is queued. A PWA cannot work offline against a local origin.
- **Failure modes:** public URL with weak or no auth equals remote shell. Tailnet-only is far safer than Funnel or a public hostname. Quick Tunnel URLs are random but are not authentication. Browser origin attacks against a localhost server (DNS rebinding, CSRF) are a risk for the local listener (inference, general web security).

## Option 4: Hosted relay with E2E encryption (Happy Coder style)

**How Happy works** (open source MIT; CLI, mobile app, and a relay server; sources partly third-party, flagged):
- The relay stores only encrypted blobs; the phone catches up when it reconnects, so no messages are lost if the phone had no signal. ([how it works](https://happy.engineering/docs/how-it-works))
- Security doc: a master secret on the user's phones, a per-session AES-256 key, per-machine keys in `~/.happy/access.key`, QR pairing with a temporary keypair. A compromised CLI machine exposes its sessions. A lost CLI machine is not fully revoked (it keeps its machine key and the last 14 days of session keys). The doc says it does not address phone compromise, metadata leakage or traffic analysis. ([security](https://happy.engineering/docs/security))
- The repo has a `happy-server` relay and a Cloudflare Worker `happy-push-server` for push; the original CLI is described as in maintenance mode with the desktop app taking over. ([GitHub](https://github.com/slopus/happy))
- Cipher details conflict between third-party pages (TweetNaCl versus AES-256-GCM); the official security page describes AES-256 for session keys. Treat the cipher claims as unverified at the code level. I did not read the source.

**For Shipline:**
- **Effort:** highest. Pairing protocol, crypto, a server (even a minimal Worker plus durable storage), a mobile client (PWA or native), push, key rotation, revocation. Getting crypto right is the real cost.
- **Cost / who runs the server:** someone must. Either the project (operating cost, abuse handling, a security-incident liability for a project with no backend today) or the user (self-host, a high bar). Alternatively reuse Happy itself rather than build one (inference).
- **Latency:** low (persistent socket).
- **Sleep/offline:** best of the options for the phone (the relay queues), but the machine still has to be awake and the CLI running to act on anything.
- **Failure modes:** relay compromise leaks metadata (timing, sizes, session counts) even with E2E, and a compromised relay can drop, delay or replay messages unless the protocol authenticates and sequences them (inference). The QR pairing screen is a high-value secret while it is displayed. Lost-phone recovery versus revocation trade-off, as the Happy docs state.
- Anthropic's Remote Control already fills this role for subscription users, without E2E. That removes most of the reason to build this (inference).

## Comparison table

| | 1 Notify (hooks) | 2 Chat bridge | 3 Tunnel + PWA | 4 E2E relay |
|---|---|---|---|---|
| Build effort | Low | Low (gate-only) to medium (channel) | Medium to high | High |
| Who runs a server | Vendor (ntfy/Telegram) | Vendor (Telegram/Discord) | User's tunnel provider | Project or user |
| Two-way | No (ntfy buttons possible) | Yes | Yes | Yes |
| Laptop asleep | Silent, nothing | Silent, queued server-side | Unreachable | Phone can read history; machine can't act |
| Inbound ports | None | None (polling) | None (outbound tunnel) | None |
| Main risk | Info leak via notification text | Bot/sender identity, approval via chat | Public exposure, web auth | Crypto/relay bugs, ops burden |
| First-party overlap | Remote Control push | Channels | Remote Control web UI | Remote Control |

## Security: threat model

Premise: any remote path that can influence the session is, in effect, remote code execution on the developer's machine, because Claude Code can run Bash and edit files. Recent history shows the hosting tool itself has had real bugs: for example CVE-2026-24887 (command injection that bypassed a confirmation prompt, fixed in 2.0.72) and CVE-2025-59536 / CVE-2026-21852 (malicious repo config; MCP traffic redirected before trust prompt; API key exposure). These are from search-result summaries I did not verify against NVD or Anthropic advisories, so treat the specifics as unverified. The general point stands: keep Claude Code updated, and do not assume the permission prompt is a perfect boundary.

| Threat | What happens | Mitigations |
|---|---|---|
| **Stolen or unlocked phone** | Attacker can read sessions and approve gates or tool calls | Remote actions limited to gate answers by default. Require a second factor on the phone for approvals (biometric via OS, or Remote Control's Trusted Devices). Short-lived pairing. A "revoke all" command on the laptop. Do not allow free text from remote by default. |
| **Leaked bot token or webhook URL** | Attacker can read what the bot sends and, if sender gating is weak, send commands | Sender-ID allowlist (not chat ID). Pairing code that expires and is single use. Keep tokens in files with 0600 permissions, never in the repo. Rotate via BotFather. Never put secrets in notifications. Public ntfy topic: unguessable name, or self-host with `deny-all` ACL. |
| **Relay compromise** (Option 4 or a third-party sink) | Metadata and, without E2E, content exposed; messages dropped or replayed | E2E with authenticated, sequenced messages. Minimize metadata. Self-hostable relay. For Options 1 and 2, send only generic text and fetch details locally. |
| **Prompt injection via a remote message** | Free-text from the phone is just another prompt; injected text in a forwarded message (or in content Claude reads) steers Claude | Gate-only replies: map phone input to a fixed token set (`advance`, `not_yet`, `stop`) and never forward raw text. Docs explicitly call an ungated channel a prompt injection vector. Treat any forwarded `input_preview` or `description` as untrusted (docs say so). |
| **Approving dangerous tool calls remotely** | A thumbs-up on a phone approves Bash or Write based on a truncated, sanitized preview. Previews cap at 3,500 code points per field, and secrets without known prefixes are not masked | Do not relay tool permission prompts in v1. If added later: show the full command or a hash, require the request ID, deny by default on timeout, and block categories (network, `rm`, `git push`, `curl|sh`) from remote approval entirely. Do not combine remote approval with `--dangerously-skip-permissions`. |
| **Stale or replayed approvals** | A queued "yes" is applied later to a different prompt | Single-use request IDs bound to a specific gate and session, with expiry (the Claude Code relay uses single-use 5-letter IDs and drops repeats). |
| **Exposed local server** (Option 3) | Open port or public tunnel without auth = remote shell | Bind 127.0.0.1. Tailnet-only, not Funnel. Per-device token or passkey. Check Origin/Host headers. No SSE through Quick Tunnels anyway. |
| **Hook tampering / supply chain** | A malicious repo or teammate edits `.claude/settings.json` hooks to exfiltrate notifications or auto-approve | Keep the sink config in user scope (`~/.shipline`), not the repo. Claude Code already refuses to let project settings turn on Remote Control, a good precedent. |
| **Fail-open hooks** | A gate hook that crashes or times out lets the step proceed | Use `onFailure: "block"` (v2.1.295+) for gate enforcement hooks. Make "no answer" mean "stay blocked." |

**Mitigation checklist (apply to all phases):** pairing with a one-time code or QR; allowlist by sender ID; short-lived, single-use, session-bound tokens; remote scope limited to enumerated gate answers; an append-only local audit log of every remote action (who, when, what, which gate), written to a file the remote path cannot edit; rate limiting; an explicit `shipline remote off` kill switch and an auto-expire for pairing; no secrets in notification text; run Claude Code in manual or default permission mode, not skip-permissions, whenever a remote path is live.

## Recommended phases

**Phase 0 (do nothing new, document):** Tell users that Remote Control and Channels exist, how to turn them on (`claude --remote-control`, `/config` push toggles), and how Shipline gates behave under them. Zero build, immediate value. The gate text should read well in a phone app (inference).

**Phase 1 (v1, smallest useful): outbound notifications.**
- `shipline notify` plus hooks on `Stop` (gate reached, task done) and `Notification` (`permission_prompt`, `idle_prompt`). Default sink ntfy with a randomly generated unguessable topic, plus a generic webhook option. Run notifications asynchronously with a short timeout so they cannot stall Claude.
- Message contents: project name, stage, and "waiting at gate: Advance?" only. No code, no `last_assistant_message` by default.
- Add to the existing wizard: pick sink, generate topic, send a test notification, show a QR for the ntfy subscription.
- No inbound path, so the threat model is only information leakage. Done in days (inference).

**Phase 2: gate-only reply.**
- Add reply buttons to the notification (ntfy `http` actions or Telegram inline buttons) writing `advance` / `not_yet` to a per-gate token. A local blocking hook (mechanism A) polls for it, with `onFailure: block`, expiry, and an audit log. The remote path can answer exactly one question and can never inject text.
- Needs a way for the local side to receive the answer without an inbound port: poll an ntfy reply topic (self-hosted with auth is better) or Telegram `getUpdates` with a sender allowlist.
- Validate first that a `Stop` or `PreToolUse` hook blocking while it waits behaves acceptably for the Shipline gate flow (unverified).

**Phase 3 (optional, only on demand): richer two-way.**
- A Shipline channel plugin (mechanism B) for free-text messages and viewing summaries, once Channels leaves research preview or Anthropic allowlists third-party channels. Until then it needs `--dangerously-load-development-channels`, which is a bad default for a distributed tool.
- Alternatively recommend Remote Control for free-text steering and keep Shipline to gates.

**Phase 4 (probably never): own relay.** Only worth considering for users who cannot use Remote Control (API-key, Bedrock/Vertex, ZDR orgs) and want E2E. Consider pointing them to Happy (MIT, self-hostable relay) instead of building one. Operating a relay changes the project from a CLI into a service with real security liability.

**Explicit non-goals:** tmux/PTY injection, public tunnels without an identity layer, relaying tool permission approvals in v1, forwarding raw phone text into the session.

## Disagreements and uncertainty

- **Remote Control stability.** One third-party summary says early testers reported disconnects and reconnection problems. The official doc says it reconnects automatically. I found no primary evidence either way beyond the docs.
- **Happy's cipher.** Third-party pages conflict (TweetNaCl vs AES-256-GCM); the official security page describes AES-256 keys. I did not audit the code. The "Signal-grade" claims come from blogs.
- **Channels details drift.** Docs say custom channels are not on the allowlist, and "flags may change." Some blogs describe platform support differently (for example whether iMessage is included). The official doc lists Telegram, Discord, iMessage and fakechat.
- **CVE details** came from search-result summaries and one aggregator snippet (a "CVE-2026-63077" the summary could not tie to Claude Code; I ignored it). Verify any CVE on NVD or the Anthropic advisory page before citing.
- **Not fetched / unverified:** Pushover, Slack, Discord webhook specifics; ngrok limits and auth; Tailscale free-tier limits and phone-app requirement; Cloudflare Access setup; Telegram's E2E status (FAQ silent); whether a waiting `Stop` hook is a supported pattern; PermissionRequest hook details (hooks page only partly read); behaviour of two processes sharing one session with `--resume`.
- **Pricing and plan terms** for Remote Control and Channels (which subscription tiers, future changes) may change; the docs fetched are dated by the research date only (no publication dates shown on the pages).
- Several sources on tmux bridges are auto-generated skill audits and a project SECURITY.md; they show common risk patterns, not a measured incident.

## Sources (all fetched 2026-11-09 unless noted)

- Claude Code, Remote Control: https://code.claude.com/docs/en/remote-control
- Claude Code, Channels: https://code.claude.com/docs/en/channels
- Claude Code, Channels reference: https://code.claude.com/docs/en/channels-reference
- Claude Code, Hooks reference (partial read): https://code.claude.com/docs/en/hooks
- Claude Code, Run programmatically (headless): https://code.claude.com/docs/en/headless
- Happy, security: https://happy.engineering/docs/security
- Happy, how it works: https://happy.engineering/docs/how-it-works
- Happy repo (slopus/happy): https://github.com/slopus/happy
- ntfy publish docs: https://docs.ntfy.sh/publish/
- ntfy config docs (partial read): https://docs.ntfy.sh/config/
- Telegram Bots FAQ: https://core.telegram.org/bots/faq
- WebKit, Web Push on iOS/iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Tailscale Serve: https://tailscale.com/kb/1242/tailscale-serve
- Cloudflare Tunnel overview: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- Search-result summaries only (not fetched; unverified): tmux bridge security (https://cdn.jsdelivr.net/npm/claude-telegram-mirror@0.2.27/SECURITY.md), Claude Code CVE coverage (thehackernews.com/2026/02/claude-code-flaws-allow-remote-code.html, wiz.io CVE-2026-24887), third-party channels explainers
