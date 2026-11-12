# Remote monitoring/steering of a local AI coding agent: landscape as of 2026-11-09

## Question and scope
How do third-party, open-source and first-party tools solve "I started a session on my machine, I'm away, I want to see it or message it from my phone"? Surveyed: Claude Code's own features, Happy, Happier, Paseo, Omnara, CloudCLI/claudecodeui, Vibe Kanban, Crystal/Nimbalyst, Conductor, opencode, Codex, Cursor, GitHub Copilot, chat-bot bridges, ntfy/Pushover hooks, and tmux+Tailscale+SSH. For each: architecture, phone capabilities, security, licence/pricing, maturity, complaints. The report ends with a comparison table and lessons for Shipline, a small CLI that installs staged workflow hooks and "Advance?" approval gates for Claude Code. Depth: deep. One researcher, no parallel fan-out. Most claims rest on vendor docs. Independent evidence is mostly GitHub issues and HN or Reddit mirrors.

## Bottom line
1. **Anthropic now ships this natively.** Claude Code Remote Control (`claude remote-control`, `claude --remote-control`, `/remote-control`) connects the Claude iOS/Android app and claude.ai/code to the local session. It supports messages, permission prompts and `AskUserQuestion` forwarding, a diff pane, push notifications, and file or photo attachments. Local hooks, MCP servers and project config keep running because execution stays on the machine. This is the default answer to Shipline's user story, and Shipline is a pure Claude Code add-on. ([official docs](https://code.claude.com/docs/en/remote-control))
2. **Every other major vendor has copied the same shape.** OpenAI Codex (via the ChatGPT app), GitHub Copilot CLI (`/remote on`), and Cursor's iOS app all use a vendor relay plus QR pairing to the user's own host. ([Codex](https://learn.chatgpt.com/docs/remote-connections), [GitHub](https://github.blog/news-insights/product-news/take-your-local-github-sessions-anywhere/))
3. **Third-party and open-source projects fall into four buckets.**
   - Relay-plus-mobile-app clients: Happy, Happier, Paseo.
   - Self-hosted web UIs: CloudCLI/claudecodeui, `opencode web`.
   - Bot or push bridges: Telegram/Discord channels, ntfy hooks.
   - DIY terminal: tmux, Tailscale and SSH.
   - The category is volatile. Vibe Kanban shut down its company, Crystal was deprecated, Terragon shut down, and Omnara pivoted away from remote Claude Code.
4. **Recommendation for Shipline: recommend and document; do not build a relay or app.** Add a small, optional integration layer in the repo's existing hook surface:
   - A `Notification`/`Stop` hook that pushes "gate waiting: Advance?" to the phone.
   - Docs for Remote Control (default), tmux+Tailscale (works with API keys, Bedrock or gateways), and optionally Happy/Happier.
   - Make sure gate prompts use a mechanism the remote surfaces actually forward (see lessons).
   Building any transport duplicates what Anthropic ships free with the subscription and carries a high maintenance and security burden.

## Findings

### A. First-party "remote control" features (the new baseline)

**Claude Code Remote Control** ([docs](https://code.claude.com/docs/en/remote-control), fetched 2026-11-09)
- Architecture: the local process makes outbound HTTPS only and opens no inbound ports. It registers with the Anthropic API and polls. Anthropic's server routes messages between the phone and the local session over a streaming connection.
- Security: all traffic goes through the Anthropic API over TLS, with short-lived scoped credentials. This is not described as E2E. The session transcript is stored on Anthropic servers while connected. Zero Data Retention and HIPAA orgs cannot enable it.
- Optional "Trusted Devices" (beta) requires an enrolled device plus biometric/passkey step-up if the last sign-in is over 18 hours old.
- Phone capabilities: it shows the live conversation and subagent/workflow progress, and you can send messages and attachments. A git diff pane is available. `/model`, `/effort` and `/compact` work from mobile, but `/plugin` and `/resume` do not. Per the docs, permission prompts and `AskUserQuestion` questions stay open until answered and are forwarded to the remote device. Push notifications fire when a task finishes or "when actions required" (permission prompts and questions), enabled via `/config`. Notifications are suppressed while you are at the terminal.
- Requirements and limits:
  - Needs a claude.ai subscription login. API keys, Bedrock, Vertex-style providers, `ANTHROPIC_BASE_URL` gateways and long-lived `setup-token` auth are not supported.
  - Team/Enterprise owners must enable it.
  - One remote session per interactive process unless you use server mode.
  - The local process and machine must stay up. Server mode exits after about 10 minutes of network outage. The docs recommend tmux/screen on remote machines.
- Maturity: still labelled research preview in some descriptions (third-party), and the docs reference versions through v2.1.318. A third-party guide dates the launch to Feb 2026 (unverified against Anthropic's announcement).
- Complaints:
  - Many GitHub issues on disconnects, sessions that cannot be reconnected, and stale "disconnected" sessions: [#33041](https://github.com/anthropics/claude-code/issues/33041), [#81155](https://github.com/anthropics/claude-code/issues/81155), and mirrors such as [claudeissues.com #34531](https://claudeissues.com/issue/34531-bug-remote-control-session-permanently-loses-sync-after-disconnection-rc-cannot).
  - An HN thread ([hn.nuxt.dev](https://hn.nuxt.dev/item/47148454)) describes it as "clunky and buggy". Reported problems: stop not interrupting, raw XML in output, `/clear` failing on mobile, and a permission prompt still showing on mobile after the desktop approval. Some reported the "not enabled" error on Max.
  - Some users disliked needing a GitHub connection on the mobile app.
  - Praise: a user reviewed and merged a PR from an exercise bike, and it needs no networking setup.
  - Caveat: the HN page was read only up to 100,000 of 112,653 characters.

**Claude Code Channels** ([docs](https://code.claude.com/docs/en/channels))
- Research preview. Telegram, Discord and iMessage plugins (Bun scripts, official repo) push messages into a running local session, and Claude replies through the same channel. You create your own bot token.
- Security model: sender allowlist plus a pairing code. Channels can declare a "permission relay" capability so you can approve or deny tool use from chat. The docs warn that anyone who can reply can approve, so allowlist carefully.
- Needs claude.ai or Console auth, and is not available on Bedrock, Vertex or Foundry. The `--channels` flag is currently restricted to an Anthropic allowlist, with a development flag for custom ones. A custom channel can be built.
- This is the sanctioned, officially supported "Telegram bridge".

**Claude Code hooks (Notification)** ([hooks guide](https://code.claude.com/docs/en/hooks-guide.md))
- The `Notification` event fires "when Claude is waiting for input or permission". Community guides use matchers `permission_prompt|idle_prompt` ([PyPI ntfy hook](https://pypi.org/project/claude-code-ntfy-notification-hook/)). I did not verify matcher timing against the hooks reference.
- Known reliability gaps: [Windows 11 non-firing on permission prompts](https://claudeissues.com/issue/56936-notification-hook-does-not-fire-on-permission-prompts-windows-11), and [a VS Code extension issue](https://claudeissues.com/issue/28774-notification-hooks-permission-prompt-dont-fire-in-vs-code-extension), which is reported closed.

**OpenAI Codex in ChatGPT mobile** ([docs](https://learn.chatgpt.com/docs/remote-connections); [coverage: dated May 14, 2026 preview](https://alternativeto.net/news/2026/5/openai-brings-codex-to-chatgpt-mobile-app-for-remote-coding-project-access/))
- Pairing is by QR from the desktop app (macOS or Windows), one phone per host, over an OpenAI "secure relay layer".
- The phone can start or continue chats, steer, approve commands, review diffs, terminal output and screenshots, and get notifications.
- The host must stay awake. Setup is not available from the CLI or IDE extension. Each host needs its own pairing.
- Encryption is not described by OpenAI in the fetched page.

**GitHub Copilot** ([GA announcement May 18, 2026](https://github.blog/news-insights/product-news/take-your-local-github-sessions-anywhere/), [mobile live notifications](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications))
- Two modes: the cloud coding agent, started and tracked from GitHub Mobile, and local CLI/VS Code/JetBrains sessions made remote via `/remote on`.
- The phone can watch plans, files and commands, steer with follow-ups, approve or deny permissions, and review or merge PRs. "Your sessions are only visible to you."
- The relay architecture and encryption are not described in the fetched post.
- Plan eligibility is not stated in the GA post.

**Cursor** ([TNW, June 29, 2026](https://thenextweb.com/news/cursor-mobile-app-coding-agents-phone), [search-result summary of docs and press](https://docs.cursor.com/background-agent/web-and-mobile))
- Cursor offers cloud ("background") agents at cursor.com/agents as a PWA. A native iOS app arrived in 2026-06 (public beta on paid plans per Pulse2).
- Sources conflict or are thin on whether the iOS app steers locally-running desktop agents. TNW says it "connects to the desktop version of Cursor" without detail. I could not fetch Cursor's own docs (redirect to a generic page).

### B. Third-party and open-source relay-plus-app tools

**Happy / Happy Coder** ([repo](https://github.com/slopus/happy), [vendor comparison page](https://happy.engineering/docs/comparisons/alternatives))
- MIT. About 24.6k stars, 4,654 commits, 679 open issues (GitHub page fetched 2026-11-09). The Releases section showed no version or date.
- Architecture: the `happy` CLI wraps the agent on your machine. A relay server (`happy-server`, open source, Dockerfile in the repo) syncs encrypted sessions to native iOS/Android apps. A Cloudflare Worker sends APNs/FCM push. The hosted relay is the default, and self-hosting is possible, though the README has no step-by-step guide. Newer versions run a "Happy Agent" runtime separate from the app window. Supports Claude, Codex, Grok, Gemini and ACP agents.
- Security: self-described E2E. The App Store listing says it uses TweetNaCl, "same encryption as Signal", and keys never leave the device. No independent audit found. A Reddit-mirror commenter says there is no public audit (anecdote).
- Pricing: free app. Voice is paid (per Happy's own page). The 2025 Show HN thread asked about a $19.99 "Plus" in-app purchase, which the author called a donation ([HN](https://hn.svelte.dev/item/44904039)).
- Complaints (primary): its issue tracker, first page sampled Oct 18 to Nov 8, 2026, clusters around daemon/machine connectivity (machine shows "online" when the agent isn't running, Android loses the machine after restart), session resume dropping IDs, permission mode lost when the app takes over a session, and iOS bugs (`/compact` sent as chat text). A user requested actionable Allow/Deny buttons on permission notifications (Oct 18). The sample is 25 of 679 issues. Windows sync bugs were acknowledged at launch. Third-party aggregator claims of crashes and permission bugs are unverified.

**Happier** ([repo](https://github.com/happier-dev/happier))
- MIT. About 2.2k stars. A faster-moving fork/descendant of Happy. Web, desktop and mobile clients, 30+ agents via ACP. A self-hostable relay (`happier relay host install`). Content is E2E encrypted, though the relay sees routing metadata (session IDs, timestamps, turn status, usage). Release cadence is not shown on the fetched page.

**Paseo** ([repo](https://github.com/getpaseo/paseo))
- Apache-2.0 per the repo page and Paseo's site. A secondary search summary said AGPL, so I treat Apache-2.0 as correct but flag the conflict. About 23.6k stars. A daemon on your machine/VM, with desktop, mobile, web and CLI clients connecting over an opt-in E2E relay or directly via LAN, Tailscale, VPN or SSH. Provides git worktrees, diff review, terminals and voice, and supports Claude Code, Codex, Copilot, OpenCode and others. Most of the claims about its features come from its own README and comparison pages (vendor).

**Nimbalyst (successor to Crystal)** ([search summary](https://www.sitepoint.com/nimbalyst-the-visual-workspace-for-building-with-claude-code-and-codex/), [Crystal repo](https://github.com/stravu/crystal))
- Crystal's final release v0.3.5 (Feb 26, 2026) says it will not be updated. Nimbalyst is a free desktop app (macOS/Windows/Linux) with a native iOS companion that pairs with the desktop. I did not fetch a primary Nimbalyst page, so the mobile feature set is secondary-sourced.

**Conductor** ([Paseo's description](https://paseo.sh/docs/alternatives/conductor), vendor-biased; [Happy's page](https://happy.engineering/docs/comparisons/alternatives))
- Closed-source macOS app (Melty Labs, YC). Local use is free. Cloud workspaces and a mobile app are in a $50/month Pro plan per both competitors. The relay is described as E2E (per Happy's page). Conductor's own docs were not verified, and sources conflict on whether its mobile app has shipped ("forthcoming" per Paseo, vs a skill listing mentioning an iOS app).

**Omnara** ([repo](https://github.com/omnara-ai/omnara), [pivot coverage](https://runtimewire.com/article/startup-spotlight-omnara-agent-control-plane))
- YC S25. It started as a wrapper streaming Claude Code CLI output to a mobile app. Its Launch HN post said this was fragile and hard to maintain. The repo is now an Apache-2.0 managed-agent platform (3.4k stars, Postgres, an `omnarad` outbound-connecting machine daemon, Slack/Discord/GitHub integrations). Per Happy's page and secondary reports it is no longer a remote for Claude Code. The date is reported as Jan 2026 but not verified from a primary company post. Whether the old app still works is unclear.

**Vibe Kanban**: the company announced shutdown on [April 10, 2026](https://vibekanban.com/blog/shutdown) (no viable business model for a mostly free user base). The project continues as Apache-2.0, community-maintained. Remote kanban was removed. Whether activity continues is disputed (one competitor site says yes, a May 2026 auto-generated page says halted). It is a desktop/web orchestrator, not primarily a phone tool.

**Terragon**: shut down. The repo was opened as an Apache-2.0 snapshot on Jan 16, 2026 with no maintenance promised ([summary](https://vibed-lab-agents.pages.dev/agent/terragon-labs-terragon-oss)). Wider "AI coding shakeout" pages list several other shutdowns, but I did not read them.

### C. Self-hosted web UIs and tunnels

**CloudCLI / claudecodeui (siteboon)** ([repo](https://github.com/siteboon/claudecodeui))
- AGPL-3.0-or-later with extra terms. About 14.5k stars, 158 open issues, no releases shown.
- Architecture: a Node server on your machine (port 3001) with a React web UI, terminal, file and git explorers. Reached at `ip:port`, so you need your own LAN, VPN or tunnel for mobile. There is also a managed "CloudCLI Cloud" option, and a native mobile app is "in the works". The README says tools are disabled by default.
- Security: at least three CVEs were published in 2026, including a CVSS 9.8 JWT/WebSocket auth bypass (CVE-2026-31975, fixed 1.25.0) and command-injection bugs fixed in 1.24.0 ([Mend](https://www.mend.io/vulnerability-database/CVE-2026-31975), [Tenable](https://www.tenable.com/cve/CVE-2026-31861)). Scores and version ranges differ between aggregators, so check the GitHub advisories. Lesson: web UIs that expose shells need rigorous auth.

**opencode** ([CLI docs](https://opencode.ai/docs/cli/web))
- `opencode web --hostname 0.0.0.0` serves a mobile-friendly UI. The server has no auth unless `OPENCODE_SERVER_PASSWORD` is set. The docs describe an official `opencode pair --remote` OpenTunnel (E2E per the docs summary), and community guides recommend Tailscale Serve for HTTPS. A GitHub issue ([#11997](https://github.com/anomalyco/opencode/issues/11997)) says `opencode web` starts a separate server with separate state from a running TUI. I did not verify whether it was fixed.

### D. Bot and push bridges (community)

- **Telegram bridges**: [RichardAtCT/claude-code-telegram](https://www.sourcepulse.org/projects/24047807) (about 2.3k stars, undated aggregator snapshot) and [hanxiao/claudecode-telegram](https://www.sourcepulse.org/projects/23423870) (about 600 stars). Many other small forks exist. They are typically a bot that spawns or drives a Claude CLI. Security rests on the bot token plus a user-ID allowlist. Anthropic's official Channels now covers this use case.
- **ntfy permission approvers**: [claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver) (MIT, 72 stars) and [claude-push](https://github.com/coa00/claude-push) (MIT, 8 stars).
  - A `PermissionRequest` hook publishes to an ntfy topic with Approve/Deny buttons, and waits on a response topic over SSE.
  - It falls back to the terminal prompt on timeout, with 90s (claude-push) or 300s (plan approvals in claude-remote-approver).
  - Security is a 128-bit random topic name (public ntfy.sh), with Basic Auth only if self-hosted. The author recommends self-hosting for sensitive work.
  - Limits: it only works for sessions started after installing the hook, and the notification shows only a brief summary.
  - Pushover and other variants exist ([example](https://hn.jakechampion.name/reader/https://github.com/teito-dev/claudecode-pushover-integration)).

### E. DIY: tmux + Tailscale/Mosh/SSH + Termius/Blink

- Claude runs inside tmux on the host, and the phone is a terminal client over Tailscale. Mosh handles network roaming, with the caveat that it does not forward the SSH agent ([guide](https://jacktan.bearblog.dev/remote-claude-code/), [harper.blog](https://harper.blog/2026/01/05/claude-code-is-better-on-your-phone/), [Zenn](https://zenn.dev/shimo4228/articles/termius-iphone-claude-code?locale=en); the Moshi/Grass pages are vendor-adjacent).
- Works with any plan, including API keys, Bedrock or gateways, and the full TUI. Reddit mirrors show strong loyalty ("tmux + SSH + Tailscale is all I need").
- Cons: setup friction, typing on a phone keyboard, a remote login surface (the HN thread advises disabling it on public Wi-Fi), and no push notifications unless combined with hooks.

## Disagreements and uncertainty
- **Remote Control plan eligibility.** Anthropic's docs list Pro, Max, Ultra, Team and Enterprise (admin enablement needed). Early press said Max-only or Pro/Max-only. The official docs win, though some users report "not enabled" errors.
- **Remote Control encryption.** Anthropic documents TLS and server-side transcript storage, not E2E. Happy markets E2E but with no known audit. "E2E" is a vendor claim everywhere I looked.
- **Paseo licence** (Apache-2.0 vs AGPL): flagged above.
- **Vibe Kanban and Omnara status:** secondary sources only, with disagreement on whether commits continue. Omnara's pivot date is unverified.
- **Cursor and Conductor mobile.** I could not verify whether the iOS apps steer local sessions or only cloud ones. Treat that as unknown.
- **Last release dates and GitHub star counts.** The GitHub pages I fetched did not show release dates for Happy, Paseo, CloudCLI or Omnara. Star counts are as shown on the fetch date. Third-party star counts are undated.
- **Reddit and HN coverage is thin.** The searches returned mostly bug-tracker pages and Reddit mirrors, not live Reddit threads. The Happy HN comments I could read were from the 2025 Show HN launch only.
- **Telegram bridge popularity.** The star counts are from undated aggregators.

## Patterns and lessons for Shipline
1. **The transport layer is now a platform feature.** Anthropic, OpenAI, GitHub and Cursor each built the same pattern: a local process makes an outbound-only connection to a vendor relay, with QR pairing. A small CLI cannot beat that on setup or reliability, and independent projects keep dying or pivoting: Vibe Kanban, Crystal, Terragon, Omnara. Building a relay or phone app carries maintenance, security-audit and App Store costs for little differentiated value. This is inference from the sources above.
2. **Wrapping the CLI is fragile.** Omnara itself said its CLI-streaming wrapper was hard to maintain against Claude Code's constant updates. Anything Shipline builds should hang off stable official extension points (hooks, channels, Remote Control) and not parse terminal output.
3. **The problem is approval, not display.** Users value remote access mostly because Claude stalls waiting for approval. The HN thread says Claude can wait indefinitely for approval. Shipline's gates make this worse: the agent deliberately stops and waits. A gate that is only a plain-text "Advance?" at the end of a turn would surface as an idle state, whereas a permission prompt or `AskUserQuestion` is explicitly forwarded by Remote Control and by the Channels permission relay. *Inference: the choice of mechanism for the gate matters for remote UX. This needs testing, as I did not verify how each mechanism renders on mobile.*
4. **Push notifications are the cheapest, most durable win.** The pattern "Notification/Stop hook posts to ntfy or Pushover" is common and small (a hook plus a topic). Remote Control's own push is configurable only via two toggles with no per-event configuration, per its docs. A Shipline hook could say "Stage: plan. Gate: Advance?" with the specific stage, which neither vendor push can do. Cautions: hooks have platform gaps (Windows non-firing reports), and a public ntfy topic is a shared secret, so default to a random topic and document self-hosting.
5. **Remote approval is a security decision.** Channels' docs say anyone who can reply can approve tool use. ntfy topics act as passwords. CloudCLI had critical auth CVEs. If Shipline ships any remote "Advance" action, it should default to read-only notification, fail closed to the terminal on timeout (as the ntfy approvers do), and never auto-approve a gate. Shipline's gates are meant to stop steps that shouldn't happen yet, so a remote Advance that could be spoofed or fat-fingered undermines the guardrail. The ntfy README itself warns about mis-taps with limited context.
6. **Where Remote Control does not apply, recommend DIY or Happy-family tools.** Remote Control excludes API-key, Bedrock, Vertex, Foundry and gateway users, and orgs on ZDR or HIPAA. For those, tmux + Tailscale (or Happy/Happier/Paseo, self-hosted relay) is the fallback. Shipline's docs should present a decision tree rather than pick one.
7. **Expect reliability complaints from every option.** Remote Control has many reconnect bugs. Happy has daemon and "online but not running" bugs. Shipline should state, in docs, that the terminal state is the source of truth, and that gate state should be recoverable from files in the repo after any reconnect. (That Shipline keeps stage state in the repo is an assumption from the brief.)

**Build / integrate / recommend summary**
| Option | Verdict |
|---|---|
| Build own relay, app or web UI | No. High cost, high security risk, duplicates vendors |
| Integrate: Notification/Stop hook to ntfy or Pushover with stage and gate context (opt-in, off by default) | Yes, small and fits the existing hook model |
| Integrate: check gate prompts work through Remote Control and Channels permission relay | Yes, test first |
| Recommend: Remote Control (default for subscription users) | Yes |
| Recommend: tmux + Tailscale (API-key, Bedrock or gateway users, and anyone wanting full TUI) | Yes |
| Recommend: Happy/Happier/Paseo (multi-agent, self-hosted relay) | Mention only, with a maturity and audit caveat |
| Telegram/Discord bridge | Point to the official Channels plugins, not third-party bots |

## Comparison table

| Tool | Architecture | Phone can | Security | Licence / price | Maturity (as fetched) | Main complaints |
|---|---|---|---|---|---|---|
| Claude Code Remote Control | Outbound-only poll to Anthropic relay; runs locally | Read, send, approve permissions, answer questions, diff, push | TLS only, not E2E; transcript stored on Anthropic; optional Trusted Devices | Included in claude.ai plans; no API key/Bedrock/gateway | First-party; many disconnect issues | Disconnects, can't reconnect, clunky |
| Claude Channels (Telegram/Discord/iMessage) | Bot plugin (Bun) pushes into local session | Chat, optional permission relay | Sender allowlist + pairing | Free with plans; research preview | Official, allowlisted plugins only | Preview, needs `--channels` restart |
| Happy | CLI wrapper + relay server (self-hostable) + native apps | Read, send, voice, push; permissions flows (issues open) | Claims E2E (TweetNaCl); no audit found | MIT; free (voice paid) | ~24.6k stars, 679 open issues | Daemon "online" bugs, session resume, Windows |
| Happier | Same lineage; self-host relay | Similar, 30+ agents | E2E; relay sees metadata | MIT | ~2.2k stars | Not assessed |
| Paseo | Daemon + E2E relay or Tailscale/SSH direct | Full orchestrator: diffs, terminals, voice | E2E relay opt-in (vendor claim) | Apache-2.0 (source conflict) | ~23.6k stars | Not assessed |
| Omnara | Platform with machine daemon + cloud API | n/a for Claude Code remote now | n/a | Apache-2.0 | 3.4k stars; pivoted | Wrapper fragility; pivot |
| CloudCLI / claudecodeui | Node web server on your host | Chat, terminal, files, git | Own auth; CVEs incl. 9.8 | AGPL-3.0+; free; paid cloud | ~14.5k stars | Critical vulns; need own tunnel |
| Vibe Kanban | Local/web orchestrator | Limited | n/a | Apache-2.0 | Company shut down Apr 2026 | Community-maintained only |
| Crystal / Nimbalyst | Desktop app (+ iOS companion) | Start, monitor, chat (secondary) | Not verified | Free for individuals | Crystal deprecated Feb 2026 | Not assessed |
| Conductor | macOS app; cloud sandboxes; E2E relay (per Happy) | Mobile app in $50 Pro plan (conflicting) | Not verified | Closed, free local | YC, $22M Series A (per Paseo) | Not verified |
| opencode web / pair | Built-in HTTP server; OpenTunnel | Full web UI | No auth unless password set; tunnel E2E per docs | Open source | Active | Separate state issue |
| Codex via ChatGPT | OpenAI relay to desktop host, QR pair | Start, steer, approve, diffs | Relay; approvals preserved | Included in ChatGPT plans | Preview since May 2026 | macOS/Windows desktop only, host awake |
| Cursor iOS / agents web | Cloud agents; iOS app | Start, review, interact | Not verified | Paid plans | iOS beta Jun 2026 | Local-steering unclear |
| GitHub Copilot mobile | GitHub-hosted; `/remote on` for CLI | Monitor, steer, approve, merge | "Visible only to you"; relay unspecified | Paid Copilot plans | GA May 2026 | Not assessed |
| ntfy/Pushover hooks | Hook posts to push service | Notify; some approve/deny | Topic = secret; self-host option | MIT; free | 72 and 8 stars | Notification hook gaps on Windows; sparse context |
| tmux + Tailscale + SSH | Direct; no vendor | Full TUI | Tailnet + SSH keys | Free (client app may cost) | Mature tools | Setup, phone typing, no push |

## Sources
- [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control) (fetched 2026-11-09)
- [Claude Code Channels docs](https://code.claude.com/docs/en/channels) (2026-11-09)
- [Claude Code hooks guide](https://code.claude.com/docs/en/hooks-guide.md) (2026-11-09)
- [HN: Claude Code Remote Control thread](https://hn.nuxt.dev/item/47148454)
- [GitHub issue anthropics/claude-code #33041](https://github.com/anthropics/claude-code/issues/33041) and [#81155](https://github.com/anthropics/claude-code/issues/81155) (appeared in search results only, not fetched)
- [Happy repo](https://github.com/slopus/happy), [Happy issues](https://github.com/slopus/happy/issues), [Happy alternatives page (vendor)](https://happy.engineering/docs/comparisons/alternatives), [Show HN 2025](https://hn.svelte.dev/item/44904039)
- [Happier repo](https://github.com/happier-dev/happier)
- [Paseo repo](https://github.com/getpaseo/paseo), [Paseo vs Conductor (vendor)](https://paseo.sh/docs/alternatives/conductor)
- [Omnara repo](https://github.com/omnara-ai/omnara), [runtimewire pivot article (search result only)](https://runtimewire.com/article/startup-spotlight-omnara-agent-control-plane)
- [CloudCLI/claudecodeui repo](https://github.com/siteboon/claudecodeui); [Mend CVE-2026-31975](https://www.mend.io/vulnerability-database/CVE-2026-31975); [Tenable CVE-2026-31861](https://www.tenable.com/cve/CVE-2026-31861) (search results only)
- [Vibe Kanban shutdown post, Apr 10 2026](https://vibekanban.com/blog/shutdown)
- [Crystal repo](https://github.com/stravu/crystal); [Nimbalyst on SitePoint](https://www.sitepoint.com/nimbalyst-the-visual-workspace-for-building-with-claude-code-and-codex/) (search results only)
- [Terragon snapshot summary](https://vibed-lab-agents.pages.dev/agent/terragon-labs-terragon-oss) (search result only)
- [Codex remote connections docs](https://learn.chatgpt.com/docs/remote-connections); [AlternativeTo on Codex mobile, May 2026](https://alternativeto.net/news/2026/5/openai-brings-codex-to-chatgpt-mobile-app-for-remote-coding-project-access/) (search result only)
- [GitHub blog: Copilot remote sessions GA, May 18 2026](https://github.blog/news-insights/product-news/take-your-local-github-sessions-anywhere/); [GitHub live notifications changelog, Feb 26 2026](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications) (search result only)
- [TNW: Cursor iOS app, June 29 2026](https://thenextweb.com/news/cursor-mobile-app-coding-agents-phone)
- [claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver); [claude-push](https://github.com/coa00/claude-push); [PyPI ntfy hook](https://pypi.org/project/claude-code-ntfy-notification-hook/)
- [opencode web docs](https://opencode.ai/docs/cli/web) and [issue #11997](https://github.com/anomalyco/opencode/issues/11997) (search results only)
- DIY guides: [jacktan.bearblog.dev](https://jacktan.bearblog.dev/remote-claude-code/), [harper.blog](https://harper.blog/2026/01/05/claude-code-is-better-on-your-phone/), [Zenn](https://zenn.dev/shimo4228/articles/termius-iphone-claude-code?locale=en) (search results only)
- Telegram bridges: [RichardAtCT/claude-code-telegram on SourcePulse](https://www.sourcepulse.org/projects/24047807) (search result only)
