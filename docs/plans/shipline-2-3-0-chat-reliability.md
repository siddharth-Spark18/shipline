# Shipline 2.3.0, part C1: chat reliability and control

**Status:** Approved

Part C1 of the 2026-11-19 audit follow-up (C2 = chat output, performance and power-user features, 2.4.0). Release
2.3.0 on branch `release/2-3-0`, cut from `main` after 2.2.0 (plans A + D) has merged. UI and UI server only: no hook
contract change, INTERFACE unchanged.

## Problem & Goal

The browser chat is meant to replace the terminal for driving Claude, including from a phone. Today it loses track of
state and gives fewer controls than the CLI:

- **Stuck "working":** after an SSE drop the browser's automatic reconnect never resyncs (`packages/ui/src/lib/
  events.ts:123` refetches only after a backoff, `:241` returns early on CONNECTING); the `result`/`busy:false` event
  is lost and the live `busy` override wins (`chat-page.tsx:486`). Send stays disabled until reload.
- **Lost and reordered messages:** `mergeHistory` (`timeline.ts:353-393`) dedupes history against live items by
  text and always puts history first. A repeated "yes"/"Done." disappears; messages sent from another tab clump at
  the top (the server never echoes user messages).
- **Silent cap:** history is capped at 500 items (`transcript.mjs:10`) with no notice; compact summaries
  (`isCompactSummary`) and `<local-command-stdout>` entries render as user bubbles.
- **Tools stuck "Running"** after a stop, crash or interrupt (`tool-call.tsx:98`).
- **No interrupt control:** the visible "Stop" kills the process; interrupt exists only as Esc (`chat-page.tsx:543-555`).
- **Prompts:** permission prompts auto-deny after 5 min (`prompts.mjs:15`) with no notification; the card offers only
  Allow/Deny with a fixed deny message, button order differs from the dock, no keyboard.
- **No type-ahead:** Send is disabled while busy (`composer.tsx:123`, server 409 `busy` at `chat.mjs:786`).
- **Focus/a11y:** the composer is disabled and blurred during send; new prompts don't take focus; the timeline has no
  live region.

**Success:** a phone that sleeps mid-turn shows the correct state on wake without reload; no message is ever dropped
or reordered across reloads and tabs; Claude can be interrupted with one tap; a permission prompt notifies you and
offers allow-for-chat / always-allow / deny-with-reason from the keyboard; you can type the next message while Claude
works.

## Scope

### In

- C1.1 Server-ordered chat log: one ordered entry list per chat with `pos`/`ver`/`epoch`, history and live in the same shape;
  user-message echo; UI folds entries in pos order (no text dedupe).
- C1.2 Reconnect catch-up: version-based catch-up (since=version, epoch), full refetch fallback; busy/ended from the server.
- C1.3 History paging (last 200 items, "Load earlier"), images by reference; compact summaries and command output
  not shown as user messages.
- C1.4 Open tool calls marked Cancelled when the turn ends, the chat stops or crashes.
- C1.5 Interrupt button; header "Stop" → "End chat" with confirm.
- C1.6 Browser notifications (permission prompt/question, stage gate, turn finished while hidden, chat crashed/ended)
  + tab-title badge; per-device opt-in and toggles.
- C1.7 Permission card: Allow once / Allow for this chat / Always allow in this repo / Deny with a message; one button
  order everywhere; keyboard 1–4, Enter, Esc.
- C1.8 Prompt timeout: verify the longest safe MCP wait; raise to 30 min if it works; visible countdown.
- C1.9 Server-side type-ahead queue (one message per chat).
- C1.10 Focus & a11y: composer keeps focus; prompts take focus/announce; timeline `role="log"`.
- C1.11 Shift+Tab in the composer cycles the existing permission mode control.

### Out (explicitly)

- Everything in C2: diffs for Edit/Write, full tool output, copy buttons, ANSI stripping, syntax highlighting,
  subagent/thinking/TodoWrite rendering, cost/context display, virtualization/memoization, Up-arrow recall, Ctrl+F
  search, expand-all, phone attachment conversion.
- More than one live chat per repo.
- Rewind / fork.
- Push notifications while no UI tab is open (no service worker push).
- Any hook/stage change.

## Surface Area

- **Server (`packages/cli/src/ui/`):** chat log with pos/ver/epoch (new module), chat routes (paging, delta, queue, end-chat
  semantics), transcript conversion (events, paging, filtering, image refs), prompts/relay (new answer kinds,
  timeout), MCP timeout env in `claude.mjs`, a writer for `.claude/settings.local.json`.
- **UI (`packages/ui/src/`):** events/SSE handling, chat store, timeline reducer, chat page, composer, working
  indicator, permission card + decision dock + question card, message list, tool call, a notifications helper, app
  title badge.
- **Data:** in-memory per chat on the server; nothing new persisted except `.claude/settings.local.json` rules from
  "Always allow in this repo" and per-device notification prefs in `localStorage`.
- **API changes (all under the existing per-repo chat routes; exact paths follow current route naming in
  `chat-routes.mjs`):**
  - `GET .../chats/:id?limit=200` → `{ chat, epoch, version, entries: [{pos, ver, ...entry}], has_earlier }`
    (replaces the current history+live shape; the UI is updated in the same release, no compatibility shim).
  - `GET .../chats/:id/events?since=<version>&epoch=<epoch>` → `{ entries, version, busy, ended, prompts }` or
    `410 { error: 'gap' }` (epoch changed, `since > version`, or changes fell out of memory) → client refetches.
  - `GET .../chats/:id/events?before=<pos>&limit=200` → older entries for "Load earlier".
  - `GET .../chats/:id/images/:ref` → one image (`t:<uuid>:<i>` or `l:<pos>:<i>`).
  - `PUT .../chats/:id/queue` (body as the send-message route: text + images) / `DELETE` → set/clear; `409
    queue-sent` once sending started.
  - Prompt answer body gains `{ decision: 'allow'|'allow_chat'|'allow_repo'|'deny', message? }`.
  - SSE chat events carry `ver` (and `pos` for new entries); new event types `user` (echo), `queue` (queued message changed),
    `tools_cancelled`.

## Behaviour & Edge Cases

### C1.1 Server-ordered log

- Each running or opened chat has a log: history entries (converted from the transcript JSONL into the same shapes the
  live stream produces, as far as the UI reducer needs) followed by live stream-json events and server events
  (`user` echo, `queue`, `tools_cancelled`, `result`, busy/ended).
- **Entries, positions and versions (review must-fix 1+2):**
  - An entry is one message content block (text, thinking, tool_use, tool_result, image) or one server event. A
    streaming text block is a single entry whose content grows in place.
  - Each entry has a `pos`: its 1-based index in the chat's ordered list. Transcript entries get pos 1..N in file
    order when the log is built; live entries are appended after. `pos` never changes within an epoch.
  - Each chat log has an `epoch` (random id, new whenever the log is (re)built: server start, chat reopened after its
    log was evicted). Each chat log also has a `version` counter; every append **or in-place update** bumps it and
    stamps the entry's `ver`. Transcript entries get ver = pos at build time.
  - **Catch-up** uses `since=<version>&epoch=<epoch>`: the server returns every entry with `ver > since` (created or
    changed, with full current content), plus the current `version`, `busy`, `ended` and pending prompts. Epoch
    mismatch, or `since > version` → `410 { error: 'gap' }` → the client refetches the page.
  - **Paging** uses `pos` (`before=<pos>`).
  - Memory bound: the last 2000 entries per chat stay in memory (blocks, not deltas, so a long reply is one entry);
    older positions are rebuilt from the transcript on a `before=` request. A catch-up whose changed entries fell out
    of memory → 410.
- **Overlap between transcript and live:** live events carry the message `uuid` when claude provides it; history
  conversion keeps the transcript `uuid`. When a chat is resumed/opened while running, the server appends live
  events and skips history entries whose `uuid` is already in the log. Dedupe is by `uuid` only, never by text. If a
  live event has no uuid it is never deduped.
- **User echo:** when the server writes a user message to claude's stdin (from any tab, or from the queue), it appends
  a `user` event `{ text, images?: [refs], from: 'composer'|'queue' }` and broadcasts it. Tabs no longer add an
  optimistic user item; they show a "sending…" state on the composer until the echo arrives.
- The UI reducer (`timeline.ts`) keeps folding events; `mergeHistory` and its text keys are deleted.

### C1.2 Reconnect catch-up

- Every SSE (re)connect, including the browser's own automatic reconnect: for the open chat, request
  `events?since=<version>&epoch=<epoch>`; on `410 gap` refetch the page. Live SSE chat messages carry the entry
  (full current content for updates, or a delta plus the entry's new `ver` for streaming text — the client applies
  deltas and records `ver`; catch-up always sends full content). Other queries (`tasks`, `chats`, `status`, prompts…) are
  invalidated on every reconnect too (fixes `events.ts:123`).
- `busy`, `ended` and pending prompts always come from the server response; the client clears its local overrides on
  reconnect.
- SSE messages also set `id: <repo>:<chat>:<epoch>:<version>` (informational; catch-up uses the explicit request,
  not Last-Event-ID). The builder confirms whether `id:` belongs in `sse.mjs` (the hub) or the chat broadcaster.

### C1.3 History paging and filtering

- First load: last 200 entries (by pos). "Load earlier" button at the top of the list, and auto-load when scrolled to
  the top; keeps the scroll position.
- `has_earlier: false` → no button; a small "Start of chat" marker.
- Images are served by ref through the image route, fetched lazily by the UI. Ref scheme: transcript images
  `t:<message uuid>:<index>` (read from the transcript on request); images uploaded live with a message
  `l:<entry pos>:<index>` (pos is stable within an epoch; image entries are never updated in place), kept in the chat log's memory with that entry (lost on server restart → placeholder).
- Filtered from user bubbles: `isCompactSummary` entries (rendered as a collapsed "Conversation compacted" notice),
  `<local-command-stdout>`/`<command-name>` wrappers (rendered as the slash command notice the live path already uses),
  `isMeta` (already skipped).

### C1.4a Cancelled tools from the transcript (review must-fix 3)

- When the log is built from the transcript for a chat that is **not** running and busy, every tool_use with no
  matching tool_result is emitted as cancelled. For a running, busy chat, only tool_uses from the current turn stay
  "Running"; earlier unresolved ones are cancelled.

### C1.4 Cancelled tools

- When a turn ends (`result`), on interrupt, on End chat, or on process exit/crash, the server appends
  `tools_cancelled { ids: [tool_use ids with no result] }`; the UI marks them "Cancelled" (grey, no spinner).

### C1.5 Interrupt and End chat

- Working indicator (desktop and phone): an "Interrupt" button (calls the existing interrupt route); text "Esc or
  Interrupt to stop this turn". Disabled while an interrupt is in flight.
- Header button renamed "End chat"; confirm dialog "End this chat? Claude's process is stopped; you can resume it
  later." On phone the same.
- Interrupt failure (502) → toast with the error; no silent failure.

### C1.6 Notifications

- A per-device banner "Turn on notifications to hear when Claude needs you" appears the first time a prompt arrives
  while `Notification.permission === 'default'`; clicking calls `Notification.requestPermission()`. Dismissable;
  remembered in `localStorage`.
- Events (each toggleable per device in a small popover in the chat header; all on by default once permission is
  granted): permission prompt / question (always, even if the tab is visible but the chat isn't), stage gate question
  (title includes the stage), turn finished (only when the tab is hidden), chat crashed or ended unexpectedly.
- Click → focuses the tab and opens that chat/prompt.
- Tab title badge: `(n) Shipline` where n = pending prompts across repos; cleared when none.
- Works on 127.0.0.1 and on the Tailscale HTTPS origin (secure contexts). If the API is unavailable (e.g. iOS Safari
  outside a home-screen app), the banner explains "Add to Home Screen to get notifications" and only the title badge
  works.

### C1.7 Permission card

- Options, same order in card and dock: **Allow once** (1), **Allow for this chat** (2), **Always allow in this repo**
  (3), **Deny** (4, opens an optional "Tell Claude why / what to do instead" field; Enter sends). Enter = Allow once
  when the card has focus; Esc = focus the deny field.
- **Rule derivation (review must-fix 4)**, one function on the server, used for both options:

  | Tool | Rule |
  | --- | --- |
  | Bash, single simple command | `Bash(<prefix>:*)`; prefix = first two words when the first is one of `git npm pnpm yarn npx bunx docker kubectl gh cargo go uv pip pip3 poetry make`, or `python -m <mod>` / `python3 -m <mod>`; otherwise the first word |
  | Bash, compound (`&&`, `\|\|`, `;`, `\|`, subshell, redirect) | the exact command: `Bash(<command>)` |
  | WebFetch | `WebFetch(domain:<host of the url>)` |
  | Any other tool (Edit, Write, MCP tools…) | the tool name, e.g. `Edit`, `mcp__server__tool` |

  The card shows the exact rule text next to options 2 and 3 before you choose.
- Allow for this chat: the permission response includes `updatedPermissions` with that rule, destination
  `session`. **The builder verifies that the permission-prompt MCP response honours `updatedPermissions`** and sets a
  server constant `ALLOW_FOR_CHAT_SUPPORTED` accordingly; prompt events carry `allowForChat: boolean` from it, and the
  UI hides option 2 when false (never faked).
- Always allow in this repo: the UI server appends the same rule to `.claude/settings.local.json` `permissions.allow`
  (created if missing, existing content kept, 2-space JSON), then answers allow. Shown only for non-Shipline-managed
  tools; never offered for Shipline's own guard decisions (those come from hooks, not this card).
- Deny with a message: `{ behavior: 'deny', message: <text or DENY_MESSAGE> }`.
- AskUserQuestion cards keep their current answer UI; they get the same focus/keyboard treatment (C1.10).

### C1.8 Prompt timeout

- Builder test: with the real `claude` binary, does a permission-prompt MCP call waiting 30 min succeed given
  `MCP_TOOL_TIMEOUT` (set in `claude.mjs`)? Set `PROMPT_TIMEOUT_MS` to 30 min if yes, otherwise to the longest verified
  value, documented in `prompts.mjs`.
- The card and dock show a countdown ("Denied automatically in 12:34"); in the last minute it turns warning-coloured
  and a notification re-fires once.

### C1.9 Type-ahead queue

- While busy, the composer stays enabled; Send becomes "Queue". `PUT queue` stores one message (text + attachments)
  per chat on the server and broadcasts `queue`. Every tab shows it above the composer as "Queued: …" with Edit and
  Cancel. Editing replaces it (another PUT).
- `PUT queue` body has the same shape as the existing send-message route (text + images).
- When the turn's `result` arrives (and no prompt is pending), the server writes the queued message to stdin, emits
  the `user` echo and clears the queue. **This includes the result that follows an interrupt** (the queued message is
  usually the redirect).
- Race: sending takes the queue atomically; a `PUT`/`DELETE` that arrives after sending started returns
  `409 { error: 'queue-sent' }` and the UI shows "Sent" instead of the edit.
- If the chat ends or crashes with a queued message, the queue is kept and shown "Not sent: the chat ended" with
  Resume-and-send / Discard.
- Server restart: the queue is in memory and lost (documented in usage.md). Restarting the server ends running chats
  anyway, so the queued message would have had no turn to follow.

### C1.10 Focus & a11y

- The composer uses `readOnly` (not `disabled`) while a send is in flight and keeps focus afterwards.
- A new permission prompt or question moves focus to it if focus was in the composer or the body; otherwise it is
  announced via an `aria-live="assertive"` region.
- Message list: `role="log"`, `aria-live="polite"` announcing completed assistant messages (not each delta).

### C1.11 Shift+Tab

- In the composer, Shift+Tab cycles the permission mode through the values the existing mode control offers, calling
  the existing control endpoint; a toast shows the new mode. Normal Tab focus order is unaffected outside the
  composer.

### Errors and empty states

- Delta request fails (network) → retry with backoff, then full refetch.
- Image ref missing → placeholder "Image no longer available".
- settings.local.json unreadable/invalid JSON → "Always allow" fails with a toast naming the file; the prompt stays
  pending.

## Constraints

- Single Node server for all repos: per-event work O(1); no full transcript re-read per event (paging reads the
  transcript once per request, streaming by line).
- UI server Node 22+ (CLI engines); no new runtime dependencies on the server; UI may not add a notification
  library.
- Security: the new routes sit behind the existing cookie/Origin/Host checks; `settings.local.json` writes are limited
  to appending to `permissions.allow` in the chat's own repo.
- Phone: everything works at 390 px width; notifications degrade gracefully.

## Files to Touch

- `packages/cli/src/ui/chat-log.mjs` — **create**: per-chat ordered log (pos, ver, epoch, uuid dedupe, in-place
  block updates, 2000-entry bound, since/before queries, live image store, rule derivation helper if not separate).
- `packages/cli/src/ui/chat.mjs` — **modify**: feed events into the log; user echo on stdin write; queue; send queued
  message after `result`; `tools_cancelled`; drop the 409-busy path for queued sends.
- `packages/cli/src/ui/chat-routes.mjs` — **modify**: page/delta/before/image/queue routes; prompt answer kinds.
- `packages/cli/src/ui/transcript.mjs` — **modify**: convert to events, paging by pos, compact/command filtering, image
  refs; remove `HISTORY_LIMIT` cap behaviour.
- `packages/cli/src/ui/stream.mjs` — **modify** only if uuid extraction/normalisation belongs there.
- `packages/cli/src/ui/sse.mjs` — **modify**: `id:` lines for chat events.
- `packages/cli/src/ui/prompts.mjs` — **modify**: answer kinds, deny message, `updatedPermissions`, timeout constant,
  countdown data in prompt events.
- `packages/cli/src/ui/relay.mjs` — **modify** only if it filters response fields (must pass `updatedPermissions`).
- `packages/cli/src/ui/claude.mjs` — **modify**: MCP tool timeout to match C1.8.
- `packages/cli/src/ui/local-settings.mjs` — **create**: append an allow rule to `.claude/settings.local.json`.
- `packages/ui/src/lib/events.ts` — **modify**: resync on every open; version catch-up; clear overrides.
- `packages/ui/src/lib/api.ts` — **modify**: new routes.
- `packages/ui/src/lib/types.ts` — **modify**: entry/pos/ver/epoch/page/queue/prompt answer types.
- `packages/ui/src/lib/notifications.ts` — **create**: permission, per-device prefs, show, title badge.
- `packages/ui/src/pages/chat/chat-store.ts` — **modify**: pos-ordered entries, version/epoch, paging, queue state.
- `packages/ui/src/pages/chat/chat-controls.tsx` — **modify**: expose the permission-mode cycle used by Shift+Tab
  (reuse its handler; don't duplicate state).
- `packages/ui/src/pages/chat/notification-settings.tsx` — **create**: the per-device toggles popover.
- `packages/ui/src/lib/queries.ts` — **modify** if query keys/fetchers for the chat live there.
- `packages/ui/src/pages/chat/timeline.ts` — **modify**: fold entries by pos/ver; delete `mergeHistory`/`itemKey`; cancelled
  tools; compact/command notices.
- `packages/ui/src/pages/chat/chat-page.tsx` — **modify**: End chat confirm, Load earlier, notification banner/popover,
  focus handling, Shift+Tab.
- `packages/ui/src/pages/chat/composer.tsx` — **modify**: readOnly while sending, Queue mode, queued message UI,
  Shift+Tab.
- `packages/ui/src/pages/chat/working-indicator.tsx` — **modify**: Interrupt button and text.
- `packages/ui/src/pages/chat/permission-card.tsx` — **modify**: four options, deny message, keyboard, countdown.
- `packages/ui/src/pages/chat/decision-dock.tsx` — **modify**: same order/options, focus.
- `packages/ui/src/pages/chat/question-card.tsx` — **modify**: focus/keyboard.
- `packages/ui/src/pages/chat/message-list.tsx` — **modify**: `role="log"`, live region, Load earlier, start marker.
- `packages/ui/src/pages/chat/tool-call.tsx` — **modify**: Cancelled state.
- `packages/ui/src/pages/chat/notices.tsx` — **modify**: compacted / not-sent notices.
- `packages/ui/src/app.tsx` — **modify**: title badge.
- `packages/cli/test/fixtures/fake-claude.mjs` — **modify**: uuids on events, slow turns, permission prompts.
- `packages/cli/test/ui/chat.test.mjs` — **modify**: pos/ver log, dedupe by uuid, echo, delta/gap, paging, queue, cancelled
  tools, end chat.
- `packages/cli/test/ui/relay.test.mjs` — **modify**: answer kinds, `updatedPermissions`, timeout.
- `packages/cli/test/ui/local-settings.test.mjs` — **create**.
- `packages/cli/package.json`, `packages/cli/CHANGELOG.md` — **modify**: 2.3.0.
- `packages/cli/ui-dist/**` — **modify** (generated by the UI build).
- `docs/usage.md` — **modify**: interrupt, queue, notifications, permission options.

## Verification

Server tests with the fake claude (user choice):

- Log: history + live with overlapping uuids → no duplicates, correct order; repeated identical texts all present;
  message sent via tab A appears as `user` echo in tab B's SSE in order.
- Catch-up: `since=v` returns created and updated entries (a streaming block that grew after v comes back with full
  text); epoch change or `since > version` → 410 gap.
- Transcript of an ended chat with an unresolved tool_use → emitted cancelled.
- Rule derivation table: one case per row; compound Bash → exact command.
- Queue: interrupt then result → queued message sent; PUT after send started → 409 queue-sent.
- Paging: 1200-event transcript → first page 200, `before` pages, `has_earlier` false at the start; compact summary
  and command stdout not emitted as user messages; images by ref.
- Cancelled tools: turn ends with an unresolved tool_use → `tools_cancelled` with its id; same on End chat and crash.
- Queue: PUT while busy → stored and broadcast; sent after `result`; DELETE clears; chat ends → kept, not sent.
- Prompts: each decision kind produces the right relay response; `allow_repo` appends to settings.local.json without
  clobbering; invalid JSON file → error, prompt still pending; timeout uses the configured value.
- Interrupt route unchanged; End chat still kills the process group.

## Open Questions

- **`updatedPermissions` via the permission-prompt MCP tool:** must be verified against the real `claude` (fact,
  not a design choice). If unsupported, "Allow for this chat" is hidden; "Always allow in this repo" still works
  (it writes the settings file, which Claude Code reads on the next permission check — the builder also verifies it
  takes effect without restarting the chat; if not, the UI says "applies from the next chat").
- **30-min MCP wait (C1.8):** verify; fall back to the longest value that works.
- **uuid on live stream-json events:** verify which event types carry `uuid`; events without one are never deduped
  (may leave an overlap only when a chat is opened mid-turn — acceptable, note in tests).
- **Optional review notes accepted for the builder:** title badge reuses the existing `waiting()` data; countdown uses
  the prompt view's `expiresAt` with a one-shot client timer for the re-notification; reducer unit tests only if the UI
  package gains a test setup (not added by this plan).
