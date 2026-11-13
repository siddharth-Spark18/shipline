# Chat: working indicator, Esc to interrupt, and prompts docked to the input

**Status:** Approved

Branch: `fix/stack-gaps`, released with the stack-gap fixes and the setup stepper as **1.3.0**.

## Problem & Goal

Two gaps in the chat page (`packages/ui/src/pages/chat`), compared with the Claude Code extension:

1. **No sign that Claude is working.**
   - The page has a `busy` state, but the only sign of it is a static grey line under the composer: "Claude is
     working. You can send the next message when this turn finishes." (`chat-page.tsx` ~648).
   - Nothing moves, and there's no current activity and no elapsed time.
   - The server never sends `busy` either. `ChatSummary.busy` is typed as an "assumed optional extra" and
     `withStatus` never sets it, so a reload mid-turn loses it.
2. **Questions and approvals sit in the scrolled history on desktop.**
   - `message-list.tsx` renders `QuestionCard` and `PermissionCard` inline. The docked version (`decision-dock.tsx`,
     built for the phone) is only rendered when `mobile` (`chat-page.tsx:614`).

The only way to stop Claude today is **Stop**, which ends the whole chat: it kills `claude` and the chat becomes
Ended. Claude Code's Esc interrupts only the current turn.

Goal: while Claude works, an indicator at the end of the messages says what it is doing, how long the turn has run,
and "Esc to stop" on desktop. Esc interrupts the turn without ending the chat. Every waiting question or approval
docks above the input on desktop and phone. Once answered, the history keeps a one-line record.

## Scope

**In**

1. **Working indicator**, on desktop and phone, as the last row of the message list while a turn runs and no prompt is
   waiting. It has an animated mark, the current activity, elapsed time, and "Esc to stop" (desktop only).
2. **Esc interrupts the current turn.**
   - Esc sends an interrupt to `claude` over the existing control channel. The chat stays active, and the composer
     works again when the turn ends.
   - Any prompts waiting for that chat are denied.
   - The header's **Stop** is unchanged and still ends the chat.
3. **The server reports busy:** `busy` and `busySince` on the chat detail and list, plus a live `busy` event, so the
   indicator and timer survive a reload and show on a second device.
4. **Dock on desktop:**
   - Questions and approvals dock above the composer on all sizes, using the phone's `DecisionDock` behaviour
     (oldest first, "1 of N", countdown).
   - On desktop it is sized to the composer, with normal-height buttons, and "Details / other answer / full diff"
     expands inline in the dock instead of opening a bottom sheet.
   - The cards are no longer rendered in the message list on any size.
5. **One-line record:**
   - An answered `AskUserQuestion` shows in the history as one line: "✓ <question> — You chose: <answer>", or
     "✕ <question> — Skipped" when denied.
   - Approvals already leave a record: the tool call row with its denied badge when denied. That stays as is.

**Out**

- Token counts or cost in the indicator.
- Changing what the header's Stop does.
- Keyboard shortcuts other than Esc.
- Queued messages (typing the next message while a turn runs). The composer stays disabled while busy, as today.
- New automated tests (the user chose click-through only).

## Surface Area

- **Frontend:** the chat page, message list, tool call rendering, decision dock, chat store, events, api and types.
- **Backend:** `controls.mjs` (an interrupt request), `chat.mjs` (`busySince`, interrupt, a busy event) and
  `chat-routes.mjs` (the interrupt route, busy fields on the chat detail and list).
- **Data:** nothing persisted. `busy` and `busySince` live only in memory on the live chat.
- **API:**
  - **New** `POST /api/chats/:id/interrupt`:
    - Unknown chat: `404 not-found`.
    - Chat not live, or no turn running: `409 not-busy`.
    - Otherwise: deny that chat's waiting prompts (`app.prompts.denyAll(chat.id)`), then
      `sendControl(chat, requests.interrupt())`, and return `{ ok: true }`.
    - If the control request fails or times out: `502 interrupt-failed` with the error message.
    - The turn's end arrives as the usual `result` event, which already sets `chat.busy = false`.
    - **Verified 2026-11-13 (claude 2.1.323)**, with the same `-p --input-format stream-json --output-format stream-json
      --verbose --include-partial-messages` flags:
      - The interrupt gets an immediate `control_response`, `{subtype:'success', response:{still_queued:[]}}`.
      - `claude` then emits a `user` event whose text is `[Request interrupted by user]`.
      - Then a `result` with `subtype: 'error_during_execution'`, `is_error: true` and an empty `result`.
      - The process stays alive, and the next user message gets a normal answer. Record this as a comment beside
        `requests.interrupt` in `controls.mjs`.
    - **Fallback:** if no `result` arrives within 10 seconds of a successful interrupt response, the server sets
      `busy = false` and `busySince = null` itself and emits the busy event. This protects against a future
      `claude` that changes behaviour; the header's Stop stays the last resort.
  - `requests.interrupt()` in `controls.mjs` returns `{ subtype: 'interrupt' }`.
  - **`busySince`:** `writeUser` sets `chat.busy = true` and `chat.busySince = new Date().toISOString()`. A `result`
    event and `finish` set `busy = false` and `busySince = null`.
  - **Busy event:** each change emits `{ chatId, kind: 'busy', busy, busySince }` on the existing SSE stream.
  - **Detail and list:** `GET /api/chats/:id` and `GET /api/chats` add `busy: boolean` and
    `busySince: string | null` to each live chat (`withStatus`), taken from a new `app.chats.busyInfo(id)`. Ended
    or not-live chats get `busy: false, busySince: null`.
- **Client state (precedence):** live first, then the fetched chat.
  - `chat-page.tsx` resolves `busy = live.busy ?? chat?.busy ?? false` (as today) and
    `busySince = live.busySince ?? chat?.busySince ?? null`.
  - The fetched chat detail is never written into the chat store.
  - Live sources update the store only: a local send (`busy: true`, `busySince: now`), the `busy` SSE event (both
    values), a result (`busy: false`, `busySince: null`) and `ended`.

## Files to Touch

**Frontend**

- `packages/ui/src/pages/chat/working-indicator.tsx`: **create**. The indicator row.
  - **Activity**, worked out from the timeline items:
    - The last `tool` item with no `result`:
      - `Bash` → "Running Bash: <command, first 40 characters>"
      - `Edit`, `Write`, `MultiEdit`, `NotebookEdit` → "Editing <file path>"
      - `Read` → "Reading <file path>"
      - `Grep`, `Glob` → "Searching"
      - `Task` or `Agent` → "Running an agent"
      - Any other tool → "Using <tool>"
    - Otherwise, a `text` item still streaming → "Writing…".
    - Otherwise → "Thinking…".
  - **Elapsed time** from `busySince`, updated every second: `12s` under a minute, `1m 05s` after.
  - "· Esc to stop" on desktop only.
  - The mark is a small animated glyph using CSS only.
  - `role="status"` and `aria-live="polite"`, announcing the activity only, not every second.
- `packages/ui/src/pages/chat/message-list.tsx`: **modify**.
  - Stop rendering `PromptCard` or the pending cards on any size; remove the `PromptCard` helper.
  - Render `WorkingIndicator` as the last row when `busy`, there are no waiting prompts, and the chat hasn't ended.
- `packages/ui/src/pages/chat/tool-call.tsx`: **modify**.
  - An `AskUserQuestion` tool item renders as the one-line record. The question comes from the item's input (first
    question's `header`, else its `question`). The answer comes from the result text.
  - When the result can't be parsed, show the result text on one line, cut to fit. A denied outcome shows
    "✕ <question> — Skipped".
- `packages/ui/src/pages/chat/decision-dock.tsx`: **modify**.
  - Desktop variant, chosen with `useIsMobile()`: normal button height instead of the phone's 56px.
  - "Details, other answer or skip" (questions) and the full input or diff (approvals) expand inline inside the dock
    instead of opening the `Sheet`.
  - The phone keeps the sheet and big buttons unchanged.
- `packages/ui/src/pages/chat/chat-page.tsx`: **modify**.
  - Render `DecisionDock` on all sizes.
  - Remove the static "Claude is working…" hint line, which the indicator replaces.
  - **Esc handler:** one `keydown` listener on `window` in the bubble phase, added while the chat page is mounted.
    On Escape it calls `api.interruptChat(id)` (toast on error) only when all of these hold:
    - The chat is busy and not ended.
    - `e.defaultPrevented` is false, so the composer's slash menu didn't already handle the key.
    - `document.querySelector('[role="dialog"][data-state="open"]')` finds nothing, so Radix dialogs and sheets close
      on Esc as usual and the turn keeps running.
  - Pass `busySince` to the message list.
- `packages/ui/src/pages/chat/chat-store.ts`: **modify**. Add `busySince`: set on local send and from the busy event;
  cleared on `ended` and on result. Never set from the fetched chat detail.
- `packages/ui/src/pages/chat/timeline.ts`: **modify**.
  - A `user` event whose text is exactly `[Request interrupted by user]` becomes an info notice, "Interrupted",
    instead of a user message.
  - A `result` with `subtype: 'error_during_execution'` and empty text that follows that notice adds no "Turn ended:
    …" notice.
  - History reloads read the same events, so they show the same thing.
- `packages/ui/src/lib/events.ts`: **modify**. Route `kind: 'busy'` events to the chat store.
- `packages/ui/src/lib/api.ts`: **modify**. Add `interruptChat(id)`.
- `packages/ui/src/lib/types.ts`: **modify**.
  - `ChatSummary.busy` becomes a real field; add `busySince?: string | null`.
  - Add the busy event type.

**Backend**

- `packages/cli/src/ui/controls.mjs`: **modify**. Add `interrupt: () => ({ subtype: 'interrupt' })`.
- `packages/cli/src/ui/chat.mjs`: **modify**.
  - Add `busySince`.
  - Emit the `busy` event on each change.
  - Add an `interrupt(id)` method as specified, and `busyInfo(id)`.
- `packages/cli/src/ui/chat-routes.mjs`: **modify**.
  - Add the `POST /api/chats/:id/interrupt` route.
  - `withStatus` adds `busy` and `busySince` to live chats.

**Docs**

- `packages/cli/CHANGELOG.md`: **modify**. 1.3.0 "Added": the working indicator, Esc to interrupt, and questions and
  approvals docked to the input on desktop.
- `docs/usage.md`: **modify**. One or two sentences in the browser UI section on the indicator, Esc to interrupt
  versus Stop, and where waiting prompts appear.

## Behavior & Edge Cases

- **Several waiting prompts:** the dock shows the oldest one with "1 of N". The indicator is hidden while any prompt
  waits, because the dock takes its place at the bottom.
- **Esc while a prompt waits:** interrupt, and the server denies every waiting prompt for that chat.
- **Esc when not busy:** nothing is sent.
- **Esc that fails:** a toast with the message. A `409 not-busy` (the turn just ended) is ignored silently.
- **After an interrupt:** the indicator stays until the `result` event sets busy false (immediately, as tested), or
  the 10-second server fallback does. The composer then works again, the chat stays Active, and the history shows one
  "Interrupted" notice, with no user bubble and no "Turn ended" error.
- **Reload or second device mid-turn:** the chat detail gives `busy` and `busySince`, so the indicator and the
  correct timer show at once. Busy events keep other devices in step.
- **No `busySince`** (for example a server older than the UI): the indicator shows without the timer.
- **Ended chat:** no indicator and no dock.
- **Scrolling:** the indicator is part of the list, so it follows the existing stick-to-bottom behaviour.

## Constraints

- No new dependencies. CSS animation only.
- The UI bundle must stay within the 400 KB gzip budget.
- Hook scripts and templates are unchanged, so no template hashes change.
- The phone dock and its sheet behave exactly as today; only the desktop gets the inline variant.

## Verification

Chosen by the user: **click through on desktop and phone.**

1. Send a message. The indicator shows "Thinking…" with a running timer, then "Running Bash: …" or "Editing …"
   while tools run, then "Writing…". It disappears when the turn ends.
2. Reload mid-turn. The indicator comes back with the timer continuing, not restarting.
3. On desktop, press Esc mid-turn. The turn stops, the chat stays Active, and you can type the next message.
   Press Esc while a question is docked: the question is denied and the turn stops.
4. A gate (AskUserQuestion) and a permission prompt each dock above the input on desktop and phone, and not in the
   message list. On desktop, Details expands inline.
5. After answering a gate, the history shows "✓ <question> — You chose: <answer>".
6. On the phone, the indicator shows without the Esc hint and the dock is unchanged.

The existing CLI test suite, UI typecheck, Prettier and the bundle budget must still pass, as CI checks them.

## Open Questions

- **No automated test for the interrupt endpoint** (not chosen). Accepted. The control request is the same mechanism
  the model and permission-mode controls already use, and the behaviour was checked by hand against claude 2.1.323.
- **The `AskUserQuestion` result text format** comes from Claude Code and isn't documented. The record falls back
  to the raw result text on one line if parsing fails.
