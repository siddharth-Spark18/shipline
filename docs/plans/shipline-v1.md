# Shipline v1 — Plan

Status: approved 2026-10-26; revised and re-approved 2026-10-27 (local app + policy findings); **revised and re-approved 2026-10-28 (continuous flow + unified UI + shadcn), then again 2026-10-28 (b) (chat-first workspace).**

Context:
- Ideation: `~/Projects/docs/research/guardrailed-workflow-platform-2026-10-26.md`
- Research:
  - `~/Projects/docs/research/shipline-byo-claude-subscription-2026-10-27.md`
  - `~/Projects/docs/research/shipline-local-claude-wrapper-2026-10-27.md`

## Revision 2026-10-28: what changed and why

After running LEARNLOOP-1 through the first build, the loop at each stage (submit, then approve in the hub, then return to Shipline Local, close the chat, click Open, and start a new session) was too slow and fragmented. Two changes follow:

1. **Continuous flow, no approvals.** Once requirements are locked, the Jira assignee owns the ticket from start to PR. No PM, QA or approver steps in between. Roles only decide what a person can do in the repo. Claude proposes each stage transition and the user confirms it inline. One Claude conversation covers the whole ticket.
2. **One unified UI**, laid out like the Claude desktop app, in the hub web app:
   - Left: stage status.
   - Center: chat.
   - Right: changed files, diffs and opened assets.

   The browser talks to the local service, which runs Claude. Electron becomes a tray helper only. The separate Shipline Local UI goes away.

Removed:
- Approvals, approver roles, claim/assign, `allowSelfApproval`, the approval queue, the Plan update stage, and the per-stage close/open sessions.

## Revision 2026-10-28 (b): chat-first workspace

**Supersedes** anything below that conflicts with it: "Ticket start", Jira-assignee ownership, the Jira sync, BLOCKED stages, the three-pane workspace layout and the dashboard home. Everything not mentioned here stays as written.

**Why:** the workspace felt too Jira-centred. It should feel like VS Code where Claude does all the editing. Work starts from a chat, and stages show only when they're relevant.

### Work starts from a chat
- **New chat screen.** Pick a project (recent first), then type. Each chat gets a per-project ID straight away, built from a prefix the admin sets per project (e.g. `LL-12` for Learnloop). Below, "LL-n" means this ID.
- **Jira is optional.** In its first reply, Claude asks whether there's a Jira ticket, using new Shipline MCP tools: `search_jira_issues`, `get_jira_issue` and `link_jira_issue`. These go through the project's existing Jira connection, which stays read-only. If a ticket is linked, its details are pulled into the context.
- **The person who started a chat owns it.** Only they can run it; admins can view it.
- **Removed:** the auto-import of Jira-assigned tickets, the background sync loop (`jira-sync-loop.ts`), the "my Jira tickets" list, and the Jira reassignment handling.

### Worktree and branch
- **The worktree is created at chat start, detached** (no branch: a snapshot of the project's base branch). Claude runs in it from the first message, because Claude Code ties a conversation to the folder it started in and `--resume` must keep working.
- **The named branch is created just before the first file edit.** Shipline does this automatically when `approve_tool_use` sees the first allowed Edit, Write or NotebookEdit, or a Bash call that isn't on the read-only list.
  - The branch is named `<JIRA-KEY>-<slug>`, or `<LL-n>-<slug>` if no ticket is linked.
  - If a Jira ticket is linked after the branch exists, the branch keeps its name and the Jira key goes into the PR title.

### Roles and stages
- **No stage is ever shown as BLOCKED.** That status is removed.
- **Role limits apply to individual actions.** If a person's role doesn't allow an action, only that one call is denied, with a reason (e.g. "Designers can't edit code"). It shows as a denied tool chip in the chat.
- **Per-stage tool limits stay**, on top of role limits (e.g. no code edits during Plan).
- **`shipline/gates` stays required.** It matches the PR by the LL-n ID or the linked Jira key, in the branch name or the PR title.

### Layout: wireframe variant A plus a module sidebar and variant B's status bar
Wireframes: `.claude/wireframes/ticket-workspace/variant-1.html` (A) and `variant-2.html` (B, status bar only).
- **Far left:** a slim, collapsible icon sidebar (shadcn Sidebar, `collapsible="icon"`) with Chats, Projects, Admin and Settings.
- **Chats module:**
  - **Chat list:** "+ New chat", with chats grouped into Waiting on you, Running and Idle. Each row shows the title, the LL-n ID, the status dot, and a Jira tag if one is linked. This list is the switcher.
  - **Center:** a wide chat (about 720px max) with tool chips, Confirm / Not yet cards, AskUserQuestion cards, file chips, and a "N files changed +x −y" summary card.
  - **Right panel:** read-only diffs and the file viewer (markdown, sandboxed HTML, images). It's hidden until you click a file chip, a changed file or the summary card, and it can be closed and resized. The branch-vs-base / uncommitted toggle lives here.
- **Stages, shown on demand:**
  - A "Build · 4/8" pill in the chat header opens a popover with every stage.
  - An inline completion card appears when a stage finishes, with a compact stepper, the deliverable chip and the next step.
  - A **bottom status bar** shows the project, branch, the LL-n ID or Jira key, "N chats waiting", PR status with "N new comments → Send to Claude", and the stage item, which opens the same popover.
- **Removed:** the workspace left panel (ticket header, stage timeline, my tickets) and the dashboard-style ticket home page. Home becomes the new chat screen. Admin, Projects and Settings stay as pages in the module sidebar.

### Data and API
- **`Ticket` becomes a chat-backed work item:**
  - `key` (LL-n, unique per project; `Project.keyPrefix` and a per-project counter)
  - `jiraKey` (now nullable)
  - `ownerId` (replaces `assigneeId`)
  - `title`, set from the first message and editable
  - `branch` (null until the first edit)
- **Removed:** the `BLOCKED` status, the Jira assignee fields and the sync loop.
- **DB reset and reseed again** (dev data only).
- **New MCP tools:** `search_jira_issues`, `get_jira_issue`, `link_jira_issue`.
- **New routes:** `POST /chats` (project + first message), plus listing the user's chats with state.
- **Local service:** creates the detached worktree at chat start, and creates the branch on the hub's first-edit signal before the tool call is allowed.

### Out of scope (added)
- Handing a chat over to another person
- Editing files by hand (unchanged: read-only everywhere)
- Writing back to Jira (unchanged)

### Verification (replaces the earlier list)
1. **Chat with Jira:** start a chat in Learnloop. Claude finds and links LEARNLOOP-1, and the branch is created at the first edit as `LEARNLOOP-1-…`. Run it through to a merged PR that passes the gate.
2. **Chat without Jira:** start a chat, get LL-n, see the branch created at the first edit, and the PR passes the gate.
3. **Role denial:** in a Designer's chat, a code edit is denied with a reason, and no stage ever shows blocked.
4. **Layout:**
   - The module sidebar collapses to icons.
   - The diff panel opens from chips and changed files, and closes.
   - The stage pill and the status bar both open the stage popover.
   - The completion card appears when a stage finishes.

### Open questions (added)
- Bash commands that write files without editing source (e.g. `npm install` changing the lockfile) currently count as the first edit. Is that right?

## Problem & Goal

**Problem (user's team):** inconsistent process (people skip research/plan/design/QA), role overreach (people change things outside their role), and ad-hoc AI use with no shared agents or guardrails.

**Goal:** one guardrailed workflow from Jira ticket to merged PR. The assignee runs it end to end, in one view, with one continuous Claude conversation. They use their own Claude subscription, and Shipline's agents and guardrails are attached.

**Success:**
- LEARNLOOP-1 goes from Start to a merged PR without leaving the single browser view or closing and reopening a session.
- `shipline/gates` still blocks a PR until the required stages are done.
- The diff/asset panel is correct:
  - the branch-vs-base and uncommitted toggles show the right changes;
  - asset chips open plan, wireframe and image files in the right panel.
- Longer term: every merged PR is traceable through its stages, with less rework after merge.

## Scope

### In
- **Workflow templates**
  - *Feature:* Research\* → Plan → Wireframes\* → Build → QA → Self-review → Raise PR → Resolve PR comments → Done (when merged). (\* optional)
  - *Hotfix:* Build → Self-review → Raise PR → Resolve PR comments → Done. QA happens afterwards, outside the gate.
  - *Admin override:* skips gates with a required reason; logged and visible on the PR check.
- **Ownership:** the Jira assignee owns the ticket end to end. There are no approvals, claim or assign.
- **Roles (Developer, Designer, PM, QA):** they control what a person can do in the repo, through the per-project, per-role edit and tool policy. Stages the person's role can't perform are blocked. For example, a Designer can do Research, Plan and Wireframes; Build and later stages show "reassign this ticket in Jira to a developer".
- **Stage transitions:**
  - Claude calls a Shipline MCP tool (`propose_stage_transition`) to propose:
    - completing the current stage (its artifact must exist);
    - skipping an optional stage (Claude suggests whether Research or Wireframes are needed at the start, and before Wireframes);
    - going back to an earlier stage, which resets the later stages to pending.
  - An inline card in the chat asks the user to **Confirm** or **Not yet**. On Confirm, the server advances the stage, and Claude is told the new stage and its policy in the same conversation.
- **Enforcement stays:**
  - stage order;
  - per-stage tool policy through `approve_tool_use` (e.g. no `src/` edits in Plan);
  - the `shipline/gates` required check.
- **One Claude session per ticket:**
  - It is started once with `claude -p` stream-json and resumed with `--resume <claudeSessionId>` across restarts.
  - Stage changes appear as markers in the chat.
  - Stage-specific permission checks happen in `approve_tool_use`, which reads the ticket's current stage at call time, so launch flags no longer need to change per stage.
  - When a stage-specific system prompt or agent is needed, Shipline injects a user-visible stage-change message instead of restarting the session.
- **QA stage:** Claude asks each time: manual testing by the user (results reported in chat) or the QA agent (qa-bug-hunter against the plan's requirements). The QA report is the artifact.
- **Self-review stage:** Claude reviews the branch diff against the plan (code-reviewer agent) and fixes findings. The review report is the artifact.
- **Raise PR:** Claude commits and pushes with the user's local git credentials and opens the PR with the user's `gh`, so the user is the PR author. The PR link is the artifact.
- **Resolve PR comments:**
  - The hub receives GitHub review and comment webhooks. The left panel shows "N new comments" with a **Send to Claude** button, which posts them into the chat.
  - Claude fixes, commits and pushes.
  - The stage is Done when the PR is merged (from the webhook).
- **Ticket start:**
  - Jira tickets assigned to the user appear in their ticket list.
  - **Start** creates a git worktree on a branch `<KEY>-<short-title-slug>` from the project's base branch, in a sibling folder `<working-copy>.shipline/<KEY>`, and starts the session.
- **Multiple tickets at once:** each ticket runs in its own worktree and Claude process. A ticket switcher shows each ticket's state: running, waiting on you, or idle.
- **Unified UI (hub web app, `apps/web`):**
  - **Left panel:**
    - ticket title and Jira link;
    - stage timeline: done, current, pending, skipped or blocked;
    - current-stage policy summary;
    - PR status and the new-comments badge;
    - switcher for other tickets.
  - **Center:** the chat, carried over from the current Local chat view:
    - tool chips, collapsible output, AskUserQuestion card, permission prompts;
    - stage-transition cards and stage-change markers;
    - assets appear as **file chips** (name, type, size), never rendered inline;
    - terminal-mode fallback switch.
  - **Right panel**, with two tabs:
    - **Changes:** a file list with +/− counts, each file expandable into a unified diff. A toggle switches between *Branch vs base* (default: committed and uncommitted) and *Uncommitted only*. It updates live after each Edit, Write or Bash tool result and on a file watcher, debounced.
    - **Asset viewer:** opened by clicking a file chip.
      - Markdown is rendered, with a raw toggle.
      - HTML wireframes load in a sandboxed iframe (`sandbox="allow-scripts"`, no same-origin).
      - Images display inline.
  - **Other pages in the same app:** home and ticket list, plus admin (projects, members and roles, Jira and GitHub connect, templates and policy, override). Existing hub pages are folded in. The separate Shipline Local UI (`apps/local/ui`) is removed.
- **UI kit: shadcn/ui** (Radix + Tailwind + CVA + lucide icons):
  - Install it in `apps/web` via `shadcn init`, after upgrading `apps/web` to Tailwind v4.
  - It replaces the hand-rolled `src/components/ui/*` (button, badge, card, input, modal, data-table, empty-state, spinner).
  - Layouts are built from shadcn blocks rather than custom:
    - **App shell:** shadcn *Sidebar* block (collapsible icon sidebar: Tickets, Admin, Settings, user menu).
    - **Home / ticket list:** *dashboard-01* block pattern, with summary cards (assigned, running, waiting on you, PRs with new comments) and a data table (TanStack Table) of the user's tickets.
    - **Ticket workspace:** three *Resizable* panels.
      - Left: sidebar-style stage timeline.
      - Center: chat in a *ScrollArea*.
      - Right: *Tabs* (Changes / Asset).
      - *Collapsible* diffs and tool output.
      - *Toggle Group* for base/uncommitted.
      - *Dialog* for pairing and override.
      - *Sonner* toasts and *Skeleton* loading states.
    - **Admin pages:** shadcn *Form* (React Hook Form + Zod), *Table*, *Select*, *Switch*.
  - Light/dark theme via shadcn CSS variables.
- **Local service (`apps/local`):**
  - It keeps spawning the unmodified `claude`, now with a browser-facing API:
    - session start/resume/stop/stream;
    - git diff (both modes) and file content for assets;
    - worktree create;
    - status.
  - CORS allows only the configured hub origin.
  - **Pairing:** the tray shows a one-time code, which the browser enters once. The service issues a token, stored in the browser and sent as a header (this replaces the `?t=` URL token).
  - Served on `127.0.0.1` only.
- **Electron:** a tray/menu-bar helper only. It starts the local service (optionally at login), shows its status and the pairing code, and opens the hub URL. It has no windows of its own. `npx shipline` still runs the service headless for developers.
- **Local service unreachable:** the ticket list and admin pages still work. The work view shows a blocking banner ("Start Shipline Local") with install and pairing steps, and retries automatically.
- Everything from the earlier plan not listed under Removed stays:
  - Jira pull-only
  - Google SSO + GitHub link
  - MCP connector
  - plugin
  - artifacts in Shipline with optional commit-to-repo
  - wireframes as HTML or a Figma link
  - per-project QA target
  - the plugin version gate

### Out
- Approvals of any kind inside Shipline (GitHub PR review is the only human review)
- Inline comments on diff lines that get sent to Claude
- Editing files in the right panel (it is read-only)
- Mobile layout (desktop browser widths only)
- Migrating existing data: a DB reset and reseed is fine
- Carried over from before:
  - multi-tenant/billing
  - workflow-builder UI
  - server-side Claude execution
  - Agent SDK, setup-token, or any handling of Claude credentials
  - analytics
  - Jira write-back
  - automatic GitHub permission management

## Surface Area

- **`packages/shared`:**
  - stage statuses: `PENDING | IN_PROGRESS | DONE | SKIPPED | BLOCKED`
  - DTOs for stage transition proposals, diffs (file list with +/−, per-file hunks), assets, local pairing, and PR comments
  - policy: `decideToolUse` reads the current stage; new transition rules
- **`apps/api`:**
  - **Prisma, reset migration:**
    - remove `Approval`, `approverRole`, `approverOverride`, `allowSelfApproval`, `skipRoles`, and the `SUBMITTED/APPROVED/REJECTED/LOCKED/OPEN` states
    - `Ticket`: add `assigneeId` (from Jira), `branch`, `worktreePath` (per user, kept locally), `claudeSessionId` (moved from `StageRun` to `Ticket`), `prNumber`, `prState`
    - `StageRun`: becomes a status row per stage, with `completedAt`, `skippedReason`, `reopenedCount`
    - new `StageTransition` (proposedBy: claude|user, kind: complete|skip|reopen, decision, timestamps) for audit
    - new `PrComment` (synced from webhooks, `sentToClaudeAt`)
  - **Routes:**
    - remove the approve, reject, claim and assign routes
    - add the transition propose/confirm routes and the PR comments list / mark-sent routes
  - **Jira sync:** import assignee
  - **GitHub webhook:**
    - `pull_request`, `pull_request_review` and `pull_request_review_comment` update the PR state and comments
    - `shipline/gates` passes when every required pre-PR stage (Plan, Build, QA, Self-review, or the Hotfix subset) is DONE or SKIPPED, or an override exists
  - **MCP:**
    - add `propose_stage_transition`
    - `get_ticket_context` returns the artifacts of all done stages
    - remove `claim_stage`
    - `submit_artifact` attaches to the current stage without changing its status
    - `approve_tool_use` uses the ticket's current stage
- **`apps/local`:**
  - **Server:**
    - one session per ticket (not per stage run)
    - browser API + CORS + pairing
    - diff endpoint (`git diff --numstat` / unified, base or uncommitted) and file watcher pushing "diff changed" over the session WebSocket
    - asset file read, restricted to the worktree
    - worktree/branch creation
    - stage-change message injection
  - **Electron:** tray-only
  - **UI:** delete `apps/local/ui`
- **`apps/web`:**
  - new three-pane work view (`pages/ticket-workspace`) with left/center/right components
  - chat components moved over from `apps/local/ui`
  - local-service client (pairing, fetch/WS to `127.0.0.1:4777`)
  - ticket list showing the user's assigned tickets
  - admin pages kept
  - approval UI removed
- **`packages/plugin`:**
  - agents/skills updated with stage instructions: propose transitions, suggest skips, the QA choice, self-review, the PR via `gh`, and resolving comments

## Behavior & Edge Cases

- **Proposal while one is pending:** only one pending proposal per ticket; a new one replaces the old.
- **Completing without an artifact:** the server rejects the transition, and Claude is told what's missing.
- **Reopen (Claude proposes going back):**
  - Later stages reset to PENDING and their artifacts keep their versions.
  - If a PR exists, `shipline/gates` turns failing until the stages are done again.
- **Blocked stage for role:** the stage shows BLOCKED with a reason; Claude is told not to proceed. Reassigning the ticket in Jira to a permitted user (sync) unblocks it.
- **Jira assignee changes mid-ticket:**
  - The ticket leaves the old user's list and their session is stopped.
  - The new assignee starts their own session; the Claude conversation is per-machine, so they get a fresh session seeded with the done-stage artifacts.
- **Concurrent tickets:** separate worktrees, so there's no shared working tree. Prompts that are waiting on the user show on the switcher.
- **Worktree exists / branch exists:** reuse it if it belongs to this ticket; otherwise show an error naming the path.
- **Diff:**
  - Base is the merge-base of the project base branch and HEAD.
  - Binary files are listed without hunks.
  - Very large diffs are truncated per file, with a "show full" option.
  - Deleted and renamed files are shown as such.
- **Asset viewer:** reads only files inside the worktree or Shipline-stored artifacts. HTML is sandboxed. Unknown types show "open in editor" (path).
- **PR comments:** webhook dedupe by comment id. Comments outdated by a force-push are still listed and marked outdated.
- **`gh` not installed or not authenticated:** the Raise PR stage tells the user to run `gh auth login`. Claude does not fall back to the GitHub App.
- **Local service down mid-session:** the banner shows. On reconnect, it resumes with `--resume`.
- **Pairing token invalid or revoked:** re-pair.
- **Carried over:** usage limit, Claude logged out or wrong org, CLI version, terminal fallback, untrusted repos, Jira ticket orphaned, GitHub permission mismatch warning.

## Constraints

- **Claude usage stays in each user's own unmodified Claude Code.**
  - Never `--bare`, the Agent SDK, setup-token, or handling of credentials.
  - The policy risk on chat mode is unchanged. Terminal mode must keep working inside the center pane.
- **Browser → localhost:**
  - The service binds to `127.0.0.1`, uses a strict CORS allowlist for the hub origin, and requires a pairing token on every request and WS.
  - Private-network-access/mixed-content: the hub on HTTPS calling `http://127.0.0.1` must be verified in Chrome and Safari. Fallback: the tray opens the hub with a pairing deep link.
- **Hard enforcement** is unchanged: the required check, repo permissions, and server-side tool decisions.

## Verification

1. Reset the DB and reseed, then reconnect Jira and GitHub. Run LEARNLOOP-1 (assigned to the user in Jira) end to end in one browser tab:
   - Claude suggests skipping Research; confirm.
   - Plan, then Wireframes with an HTML wireframe chip opened in the right panel.
   - Build, with the diff panel updating live; toggle between base and uncommitted.
   - QA, choosing the QA agent.
   - Self-review.
   - PR via `gh`.
   - A GitHub review comment arrives → **Send to Claude** → fix pushed → merge → Done.
2. Open a PR before QA is done → `shipline/gates` fails; after Self-review it passes.
3. Have Claude propose going back from QA to Plan → the later stages reset; the gate fails on the open PR until they're redone.
4. Run a second ticket concurrently in its own worktree and switch between them.
5. Stop the tray app mid-session → the banner shows → restart → the session resumes.
6. One Hotfix through its template, and one admin override.

## Open Questions

1. **Anthropic written confirmation** (before relying on chat mode beyond the pilot): the seven questions in `shipline-local-claude-wrapper-2026-10-27.md`.
2. **Browser-to-localhost** from an HTTPS hub (Chrome Private Network Access, Safari): confirm it works, or adopt the deep-link/tray fallback.
3. **Whether stage changes need stage-specific system prompts or agent switching** that only a restart can apply. The current assumption is that an injected message plus server-side tool policy is enough.
4. **When a reassigned ticket moves to another person**, whether they need the prior Claude conversation (currently: no, artifacts only).
5. For people using plain Claude Code without Shipline Local: how hooks learn role/stage.
6. Artifact storage: DB vs object storage; size limits for HTML mockups.
7. Figma artifact: link only, or exported frames?
8. Repo path and branch for committed artifacts when `commitArtifactsToRepo` is on.
9. Working copy and git credentials for non-dev roles (Designer doing Plan/Wireframes needs a worktree too).
10. Hosting / deployment target for the Shipline hub.
11. ~~Tailwind version~~ Decided 2026-10-28: upgrade `apps/web` to Tailwind v4 as part of the shadcn redesign.
