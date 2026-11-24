# Plan review: shipline-2-3-0-chat-reliability (C1)

Re-review. Verdict: **Ready to build** (0 must-fix, 5 optional).

## Earlier must-fixes

1. Seq for history and paging, with a gap on `since > version`: **closed.** The plan now defines `pos`, `ver` and `epoch`. Transcript entries get pos 1..N in file order. `since > version` or an epoch mismatch returns 410.
2. Coalescing breaks catch-up: **closed.** In-place updates bump `ver`. Catch-up returns every entry with `ver > since` at full current content.
3. Transcript has no `tools_cancelled`: **closed.** C1.4a covers it.
4. Rule shape undefined: **closed.** The plan has a derivation table and an `ALLOW_FOR_CHAT_SUPPORTED` flag carried on prompt events.
5. Queue contract: **closed.** The plan covers the PUT body, interrupt-then-result, the 409 `queue-sent` race, and the `l:<ver>:<i>` image refs.

## Paraphrase

**What the plan proposes.** Release 2.3.0 makes the browser chat reliable and gives it controls closer to the CLI. The server keeps an ordered log per chat. Each entry has a `pos` and a `ver`, and the log has an `epoch`. History and live events share one shape. The server echoes user messages. A reconnecting client asks for entries with `ver` above its last-seen version and refetches the page on a 410. Other changes in the plan:
- History pages in 200-entry chunks.
- Unresolved tools show "Cancelled".
- An Interrupt button, with "Stop" renamed "End chat".
- Browser notifications and a tab-title badge.
- A four-option permission card with a derived rule, written to `settings.local.json` for "always allow".
- A longer prompt timeout with a countdown.
- A one-slot server-side type-ahead queue.
- Focus and a11y fixes, and Shift+Tab to cycle the permission mode.

**How the system works today, per the plan.**
- The SSE reconnect never resyncs, so a lost `result` event leaves the chat stuck on "working".
- `mergeHistory` dedupes history against live items by text and always puts history first. Repeated messages vanish and messages from other tabs end up in the wrong place.
- History is silently capped at 500 items.
- Compact summaries and command output show up as user bubbles.
- Tools stay "Running" after a stop.
- "Stop" kills the process, and interrupt is only available through Esc.
- Prompts auto-deny after 5 minutes.
- The card offers only Allow and Deny.
- Send is disabled while Claude is busy.

## Must-fix

None.

## Optional (non-blocking)

- **Unverified Claude behaviours:** `updatedPermissions`, the 30-minute MCP wait, uuid on live events and `settings.local.json` taking effect mid-chat are all deferred to the builder as verification tasks. They are written as facts to check, with fallbacks, so the builder has no design choice to make. Even so, a short spike before the main build would avoid rework in the UI, which depends on `allowForChat`.
- **Live image refs:** `l:<ver>:<i>` depends on the entry `ver`, which changes if that entry is updated in place. Say that image entries are never updated, or key on a stable id.
- **SSE `id:` placement:** the plan says the builder confirms whether it belongs in `sse.mjs` or the chat broadcaster. Since the id is informational only, consider dropping it. This is YAGNI.
- **Extra gap case:** two small cases are unstated. A catch-up where `since` is below the oldest in-memory `ver` is covered by "fell out of memory". The queue UI when a second tab edits mid-send is covered by 409. Both are fine as written.
- **Verification list:** the "Queue" bullets appear twice and could be merged. No UI test coverage is planned for the reducer, which the plan accepts explicitly.

## Files-to-touch check

All "modify" paths exist, including `chat-controls.tsx`, `queries.ts`, `app.tsx`, `sse.mjs`, `relay.mjs`, `stream.mjs`, the test fixtures and the existing tests. The "create" paths are correctly new: `chat-log.mjs`, `local-settings.mjs`, `notifications.ts`, `notification-settings.tsx` and `local-settings.test.mjs`. The `ui-dist` and CHANGELOG entries are accounted for. I found nothing described but missing from the list.
