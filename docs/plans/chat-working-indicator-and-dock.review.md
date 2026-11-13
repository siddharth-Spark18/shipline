# Review: chat-working-indicator-and-dock

## 1. Verdict

**Ready after must-fixes** (3 must-fix, all small).

## 2. Paraphrase

**What the plan proposes.** Add a "working" row at the bottom of the chat message list while Claude runs a turn. It shows an animated mark, the current activity (derived from the last unfinished tool call or streaming text), an elapsed timer and, on desktop, "Esc to stop". Pressing Esc calls a new `POST /api/chats/:id/interrupt`. That denies waiting prompts and sends an `interrupt` control request to the `claude` child. The chat stays Active and the turn ends via the normal `result` event. The server starts tracking `busy` and `busySince` in memory. It exposes them on the chat detail and list and through a new `busy` SSE event, so a reload or second device shows the indicator and timer. Questions and approvals move out of the message list into the existing phone `DecisionDock` on all screen sizes. On desktop the dock uses normal buttons and expands inline instead of opening a sheet. An answered `AskUserQuestion` leaves a one-line "✓ question — You chose: answer" record in the history.

**How the existing system works, according to the plan.** The chat page has a client-side `busy` flag. It is set locally on send and cleared on `result`, and the server never reports it. The only busy cue is a static grey line under the composer. "Stop" kills `claude` and ends the chat. Control requests (model, effort, mode) go over `claude`'s stdin through `sendControl` and are answered by a `control_response`. Prompt cards render inline in the message list. The docked version exists only for mobile (`chat-page.tsx:614`).

The paraphrase matches the code I read: `writeUser`, the `result` handling in `onLine`, `sendControl`, `requests` and `DecisionDock` are all as described.

## 3. Must-fix

1. **The interrupt behaviour is assumed, not verified (API section, "The turn's end arrives as the usual `result` event").**
   - `controls.mjs` records that every other control subtype was checked against a real `claude` (2.1.318). The plan gives no such check for `{ subtype: 'interrupt' }`.
   - Three things are unconfirmed: that `claude -p --input-format stream-json` accepts it, that it replies with a `control_response`, and that it still emits a `result` event for the aborted turn.
   - If any of these is wrong, `busy` never clears. The composer stays disabled and the only exit is Stop, which ends the chat. That is the exact outcome the feature exists to avoid.
   - Fix: before building, test it on the installed `claude` and record the version and date in the plan, as the other controls do. Also state the fallback if `result` does not come. For example, after the control request succeeds, clear `busy` and `busySince` and emit the `busy` event if no `result` arrives within N seconds.

2. **Client precedence for `busy` and `busySince` contradicts the code (Client state; Files to Touch, `chat-store.ts`).**
   - `chat-store.ts` is built only from SSE events. The chat detail comes from a react-query fetch in `chat-page.tsx`. It currently resolves busy as `live.busy ?? chat?.busy`, so the live value wins.
   - The plan says "the chat detail sets both values, and the server value wins when present". It does not say whether the detail is written into the store, or `chat-page.tsx` merges `live.busySince ?? chat.busySince`. The two rules also conflict.
   - Fix: pick one. The simplest is no store write from the detail, with `busySince = live.busySince ?? chat?.busySince` in `chat-page.tsx`, mirroring `busy`. Say how a stale local `busySince` is replaced by the server's. The local send sets "now" and the `busy` event then overwrites it.

3. **The Esc guard "when a dialog or sheet is open" has no mechanism (Files to Touch, `chat-page.tsx`).**
   - The page has Radix `Sheet`s: the task panel, and the phone dock's sheet. Radix closes them on Escape. A `document` keydown listener will also see that Escape. The plan only gives a check for the composer slash menu (`e.defaultPrevented`).
   - A builder would have to invent how to detect an open dialog. Getting it wrong would interrupt the turn when the user only meant to close a sheet.
   - Fix: name the check, for example `document.querySelector('[role="dialog"][data-state="open"]')`. Also state whether the listener is on `document` or on the page element, and in which phase.

## 4. Optional (non-blocking)

- **Multi-question `AskUserQuestion` record.** The plan uses only the first question's header or question, but the answer text may cover several questions. One line may misattribute. A sentence on how multi-question results are shown would help. The raw-text fallback already covers the worst case.
- **Existing tests.** Adding `busy` and `busySince` to every chat in `GET /api/chats` and the detail may break `deepEqual`-style assertions in `packages/cli/test`. The plan says "no new tests" but does not mention updating tests that break. Check for this.
- **Busy event emission points.** The plan says "each change emits". The code has several sites where `busy` flips: `writeUser`, `isResult` in `onLine`, and `finish`. Name them, and make sure `finish` emits the event before `ended` or `fatal`, or skips it. Otherwise the client briefly sees a stale state.
- **Desktop dock layout.** "Sized to the composer" is loose. Say whether it sits inside the composer's width container, and how the inline expansion bounds its height. For example, `max-h` plus scroll for a long diff.
- **Denied detection for the one-line record.** The plan says "a denied outcome" without naming it. `Item.outcome === 'denied'` already exists in `timeline.ts`, so name it.
- **`interrupt()` during `applying > 0`.** It is not stated whether interrupt requires `chat.busy` only. The plan says 409 `not-busy` when no turn is running, which implies `busy` only. This is fine, but say so.

## 5. Files-to-touch check

- All modify paths exist. I checked `packages/ui/src/pages/chat/*` (message-list, tool-call, decision-dock, chat-page, chat-store), `packages/ui/src/lib/events.ts`, `packages/cli/src/ui/chat-routes.mjs`, `chat.mjs`, `controls.mjs` and `docs/usage.md`. `packages/ui/src/lib/api.ts` and `types.ts` are modified in the working tree, so they exist.
- `working-indicator.tsx` is the only create, and it does not exist yet, as expected.
- Missing from the list: any CLI test that asserts the chat list or detail shape (see optional). `packages/cli/package.json` is not listed. The changelog says 1.3.0, but the branch already carries the version bump, so this is likely fine.
- `question-card.tsx` and `permission-card.tsx` are reused by the dock, with no change implied. That is consistent.
