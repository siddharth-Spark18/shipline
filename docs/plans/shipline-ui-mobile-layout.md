# Shipline UI: mobile layout (docked decisions + bottom tabs)

**Status:** Approved
**Branch:** `feat/ui-phone-access` (same branch as phone access; ships together as 1.2.0).
**Depends on:** `docs/plans/shipline-ui-phone-access.md` (built, uncommitted). This plan changes its pairing API (short code).
**Design:** `.claude/wireframes/mobile-ui/variant-1.html` (current state: `baseline.html`, same folder).

## Problem & Goal

Phone access works, but the UI was laid out for a laptop. On a phone (390×844):
- the chat is cramped: header, terminal note, title row and a tall composer leave about half the screen for messages;
- gates and tool approvals sit at the end of the scrolling message list with 28–32px buttons, and nothing shows they are
  waiting if you've scrolled up — yet answering them away from the desk is the main reason to use the phone;
- navigation goes through a small hamburger drawer, and Setup's tabs overflow;
- the on-screen keyboard squeezes the messages to a sliver.

**Goal:** below 768px the UI becomes a phone layout (Variant 1). The desktop layout does not change.

**Success:** on the iPhone, over Tailscale: a waiting gate or approval is always visible above the composer and is
answered with one tap on a large button; switching chats and reaching Setup / Phone access take one tap from the tab
bar; typing keeps the latest messages visible; the UI can be added to the home screen and paired there with a short code.

## Scope

### In

All of this applies only when `useIsMobile()` is true (viewport width < 768px, the existing rule; a narrow desktop
window gets it too, which is accepted).

1. **Decision dock.** Pending prompts (gate questions and tool approvals) of the open chat are no longer rendered in
   the message list; they appear in a dock between the messages and the composer.
   - Shows **one prompt at a time, oldest first**, with "1 of N" when more are waiting in this chat.
   - **Single question, 2 options:** two side-by-side full-width buttons, 56px tall; one tap answers.
   - **Single question, 3–4 options:** stacked full-width buttons, 56px tall; one tap answers.
   - **Multi-select, or more than one question:** the dock shows the first question's text and an **Answer** button that
     opens the existing full question card (tabs, checkboxes, Submit) in a bottom sheet with large touch targets.
   - **Tool approval:** one row with the tool name and the command / file path (truncated) plus **Deny** / **Allow**
     (56px). Tapping the row opens a bottom sheet with the full command or the diff, with the same two buttons.
   - The existing auto-deny countdown ("Denied in m:ss") stays, shown in the dock.
   - Other questions the existing cards offer (e.g. Skip, free-text "Other") stay available: in the sheet for complex
     questions; for simple ones the composer below acts as the text reply, as in the wireframe ("Or reply with text").
2. **Bottom tab bar** (replaces the sidebar drawer on mobile): **Chats**, **New**, **Setup**.
   - Chats shows a pip with the number of chats that have a pending prompt. No other cross-chat signal.
   - **New** starts a new chat (same action as the sidebar's New chat).
   - Hidden while the on-screen keyboard is open.
3. **Chats tab:** full-screen chat list, 64px rows, chats with a pending prompt pinned first with the existing
   "Needs answer" badge, the rest in today's order. Row content reuses the sidebar's chat row (title, branch, stage dots).
4. **Compact chat header:** back arrow (to the Chats tab), chat title, "Stage n of m · <stage>" with stage dots, the
   status badge, and the task-panel button. The terminal note and the chat's own title row are hidden on mobile.
5. **Compact composer:** one-line textarea that grows with the text (up to ~6 lines, then scrolls), icon-only send
   button, and a **+** button that opens a bottom sheet holding **everything in today's ChatControls row**, unchanged in
   behaviour. The hint line is hidden. `/` commands and `!` shell mode keep working in the input.
6. **Keyboard handling:** the composer (and the dock above it) follow `window.visualViewport`, so they sit right above
   the keyboard; the message list keeps its scroll anchored to the bottom while typing. Safe-area insets
   (`env(safe-area-inset-bottom)`) are respected; the viewport meta gets `viewport-fit=cover`.
7. **Readability:** code blocks and diffs go full-width inside the message column; long lines **scroll sideways by
   default**, with a small **Wrap** toggle per block. Tool calls render as two-line rows (tool name + target on one line,
   short detail on the second); expanding works as today.
8. **Setup on mobile:**
   - The section nav becomes a horizontally scrolling chip strip: config.yml, Agents & skills, CI check, Guardrails,
     Phone access, then every workflow, then **New workflow** and **Add shipped workflow** as the last chips.
   - **Theme** and **Status** (today in the sidebar footer) appear as two compact rows above the strip.
   - "Discard and reload" / "Review and save" become a sticky bar above the tab bar, shown only when there are unsaved
     edits.
9. **Add to home screen (basic PWA):** web app manifest (`display: standalone`, name "Shipline", theme/background colours
   from the tokens, start URL `/`), icons, and iOS meta tags. No service worker, no offline support.
10. **App icon:** a simple "S" monogram on the accent colour, as SVG plus PNG 180 / 192 / 512, generated once and
    added to the repo (no build step, no new dependency). Method: render `icon.svg` to a 512px PNG with macOS
    `qlmanage -t -s 512 -o <dir> packages/ui/public/icon.svg`, rename it to `icon-512.png`, then make the smaller sizes
    with `sips -z 192 192` and `sips -z 180 180`. No script is kept in the repo.
11. **Short pairing code** (because a home-screen app on iOS may not share Safari's cookies, and a QR always opens Safari):
    - "Pair a phone" creates one pairing that has both the QR link (as today) and an **8-character code shown as
      `XXXX-XXXX`** (alphabet without look-alikes: no 0, O, 1, I, L; ~40 bits). Same 5-minute expiry; **using either
      the link or the code consumes both**.
    - Typing is case-insensitive and ignores the dash and spaces.
    - **5 wrong short codes in a row** (across all devices, per UI server) cancel all open pairings; the laptop panel
      shows "Pairing cancelled after too many wrong codes. Make a new one." A correct code resets the counter.
    - **Cancelled state:** it is cleared (and the counter reset) when a new pairing is created with "Pair a phone".
      While it is set, **every** claim, with a right or wrong code, short or long, returns `pairing-cancelled`.
    - **No open pairing:** a claim when no unexpired pairing exists returns `bad-code` and does not count toward the 5.
    - The phone's not-paired screen gets a **"Enter pairing code"** form (code + device name) next to the existing
      instructions.
12. **Docs:** README §5 "Use it from your phone" gains "Add to home screen" and the short code; CHANGELOG 1.2.0 entry
    extended.

### Out

- Landscape and tablet layouts (≥ 768px gets the desktop layout).
- Notifications of any kind.
- Swipe gestures (swipe-back, swipe-to-answer); taps only.
- Service worker / offline.
- Any change to the desktop layout.
- Automated UI tests (packages/ui has no UI test setup). Server-side short-code tests are listed in Files to Touch for
  the test agent.

## Surface Area

- **Frontend (`packages/ui`)**: most of the work. Mobile-only branches inside existing components, a few new
  components, static PWA files.
- **Backend (`packages/cli/src/ui`)**: pairing gains the short code (devices store + routes) and the server serves
  `.webmanifest`.
- **Data:** none persisted. Pairings stay in memory; the short code and wrong-attempt counter live with them.
- **API changes** (all on top of the uncommitted phone-access API, so nothing released changes):
  - `POST /api/remote/pair` → `{ url, shortCode, expiresAt }` (`shortCode` formatted `XXXX-XXXX`).
  - `POST /api/remote/claim` accepts **either** `{ code, name }` (QR link, as today) **or** `{ shortCode, name }`.
    Errors: `bad-code` (unknown/used/expired, wrong short code), `bad-name`, and new `pairing-cancelled` (409) when
    the 5-wrong-tries limit was hit.
  - `GET /api/remote` gains `pairing: { cancelled: boolean }` so the laptop panel can show the cancelled message.

## Files to Touch

| Path | Action | Change |
|---|---|---|
| `packages/ui/src/hooks/use-visual-viewport.ts` | create | `{ keyboardOpen, bottomInset }` from `window.visualViewport` (resize/scroll), for the composer/dock offset and hiding the tab bar. |
| `packages/ui/src/components/mobile-tab-bar.tsx` | create | Chats / New / Setup bar, pending-count pip, hidden when `keyboardOpen`, safe-area padding. |
| `packages/ui/src/components/chat-row.tsx` | create | The chat row (title, branch, stage dots, Needs answer badge) extracted from `app-sidebar.tsx` so the sidebar and the Chats tab share it. |
| `packages/ui/src/components/mobile-chat-list.tsx` | create | Full-screen Chats tab: 64px rows via `chat-row.tsx`, pending chats pinned first. |
| `packages/ui/src/components/app-sidebar.tsx` | modify | Uses `chat-row.tsx`; not rendered on mobile. Desktop output unchanged. |
| `packages/ui/src/app.tsx` | modify | On mobile: no sidebar/drawer; a `chats` view; renders `MobileTabBar`; back from a chat goes to `chats`; New starts a chat. Desktop unchanged. |
| `packages/ui/src/pages/chat/decision-dock.tsx` | create | Picks the oldest pending prompt of the open chat, "1 of N", inline buttons for simple questions, Answer → sheet for complex ones, approval row → sheet with full command/diff, countdown. |
| `packages/ui/src/pages/chat/question-card.tsx` | modify | Split the question body from the card shell so the sheet reuses it; larger touch targets when mobile. Desktop rendering unchanged. |
| `packages/ui/src/pages/chat/permission-card.tsx` | modify | Export the summary (tool + command) and detail (full command / diff) pieces for the dock and sheet. Desktop unchanged. |
| `packages/ui/src/pages/chat/message-list.tsx` | modify | On mobile, pending prompt cards are not rendered in the list (the dock shows them). |
| `packages/ui/src/pages/chat/chat-page.tsx` | modify | Mobile header (back, title, stage, badge, task panel); hides terminal note and title row on mobile; renders `DecisionDock` above the composer; bottom offset from `useVisualViewport`; keeps scroll anchored to the bottom while typing. |
| `packages/ui/src/pages/chat/composer.tsx` | modify | Mobile: one-line autogrow (max ~6 lines), icon send, **+** button opening a bottom sheet with `ChatControls`, hint line hidden. |
| `packages/ui/src/pages/chat/chat-controls.tsx` | modify | A stacked layout for use inside the sheet; same controls and behaviour. |
| `packages/ui/src/pages/chat/tool-call.tsx` | modify | Two-line row on mobile. |
| `packages/ui/src/components/markdown.tsx` | modify | Code blocks: full width, sideways scroll by default, per-block Wrap toggle on mobile. |
| `packages/ui/src/components/diff-view.tsx` | modify | Same Wrap toggle and full width on mobile. |
| `packages/ui/src/pages/setup/setup-page.tsx` | modify | Mobile: chip strip nav (order above), Theme + Status rows above it, sticky bottom save bar when dirty. |
| `packages/ui/src/pages/setup/phone-access.tsx` | modify | Shows the short code (large, monospace) under the QR; shows the "pairing cancelled" message. |
| `packages/ui/src/pages/pair/not-paired.tsx` | modify | "Enter pairing code" form: code + device name → claim with `shortCode`; shows `bad-code` / `bad-name` / `pairing-cancelled`. |
| `packages/ui/src/lib/types.ts` | modify | `shortCode` on the pair response, `pairing.cancelled` on remote info, claim body union. |
| `packages/ui/src/lib/api.ts` | modify | Claim with `shortCode`. |
| `packages/ui/src/lib/queries.ts` | modify | Claim mutation accepts either form. |
| `packages/ui/index.html` | modify | `viewport-fit=cover`, manifest link, `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `theme-color` (light and dark). |
| `packages/ui/public/manifest.webmanifest` | create | Name/short name "Shipline", `display: standalone`, `start_url: /`, colours, icons. |
| `packages/ui/public/icon.svg` | create | "S" monogram on the accent colour. |
| `packages/ui/public/icon-180.png`, `icon-192.png`, `icon-512.png` | create | PNG renders of `icon.svg`, generated once on the dev machine and committed. |
| `packages/cli/src/ui/devices.mjs` | modify | A pairing holds both the long code and the short code; consuming either consumes both; short-code normalisation; wrong-attempt counter (5 → cancel all open pairings, reset on success); cancelled flag cleared by a new pairing; attempts with no open pairing don't count. |
| `packages/cli/test/ui/remote-pairing.test.mjs` | create | Tests (test agent, later, with the phone-access tests): consume-both, normalisation, 5-wrong-tries, cancelled lifecycle, no-open-pairing rule. |
| `packages/cli/src/ui/remote-routes.mjs` | modify | Pair response adds `shortCode`; claim accepts `{ shortCode, name }`; `pairing-cancelled`; `GET /api/remote` adds `pairing.cancelled`. |
| `packages/cli/src/ui/server.mjs` | modify | MIME type for `.webmanifest` (`application/manifest+json`). |
| `packages/cli/ui-dist/**` | modify | Rebuilt bundle (generated, gitignored). |
| `README.md` | modify | Add to home screen + short code under "Use it from your phone". |
| `packages/cli/CHANGELOG.md` | modify | Extend the 1.2.0 entry. |
| `docs/plans/shipline-ui-phone-access.md` | modify | Note under Open Questions that pairing gained a short code in this plan. |

## Behavior & Edge Cases

- **Prompt answered elsewhere** (laptop, another tab): it disappears from the dock and the next one (if any) shows.
- **Prompt expires** (countdown hits zero): removed from the dock as today's cards are.
- **Sheet open when its prompt is answered elsewhere or expires:** the sheet closes and the dock moves on.
- **Pending prompt in another chat:** only the Chats pip counts it; nothing else in the open chat.
- **No chats yet:** the Chats tab shows the existing empty state with a "New chat" button.
- **Keyboard open:** tab bar hidden, dock stays above the composer, latest messages stay in view.
- **Rotating to landscape** on a phone (width may pass 768px): the desktop layout takes over; not designed further.
- **Window resized across 768px on desktop:** switches layout; open sheets close.
- **Short code typed wrong:** `bad-code` with "Wrong or expired code"; after the 5th wrong try in a row the open pairings
  are cancelled and both the phone and the laptop panel say so.
- **QR link used:** the short code of that pairing stops working too, and vice versa.
- **Home-screen app opens unpaired:** the not-paired screen with the code form; after pairing it loads `/`.
- **Remote off / revoked / wrong Tailscale user:** unchanged from the phone-access plan.

## Constraints

- Desktop (≥ 768px) must render exactly as today.
- No new runtime dependencies in either package; the bottom sheets use the existing shadcn `Sheet` component
  (`packages/ui/src/components/ui/sheet.tsx`, `side="bottom"`).
- Existing tokens and light/dark themes only; touch targets ≥ 44px, primary decision buttons 56px.
- Security of the short code: ~40 bits, 5-minute expiry, single use shared with the QR link, 5-wrong-tries cancellation,
  and every request still needs the same Tailscale user.

## Verification

Manual, on the iPhone over Tailscale (`shipline ui --remote` on the laptop):
1. Chat: messages use most of the screen; header shows title and stage; code block scrolls sideways and wraps with the
   toggle; tool calls are two-line rows.
2. Gate with two options: the dock shows it; one tap on Advance continues the chat on the laptop.
3. Gate with several questions: Answer opens the sheet; Submit works.
4. Tool approval: the dock row opens the full command/diff; Allow and Deny both work; countdown visible.
5. Two prompts waiting: "1 of 2", oldest first; answering the first shows the second.
6. Prompt waiting in another chat: Chats pip shows 1; the chat is pinned first in the list with Needs answer.
7. Typing: keyboard open, tab bar hidden, dock and latest messages visible, send works; + sheet has all controls.
8. Setup: chip strip scrolls to every section and workflow; editing shows the sticky save bar; Theme and Status rows work;
   Phone access shows the QR and the short code.
9. Add to home screen: the icon and name appear; the app opens full screen; if it opens unpaired, pairing with the short
   code works; 5 wrong codes cancel the pairing and the laptop shows it.
10. Desktop: a quick look at the laptop UI at full width to confirm nothing changed (not separately requested, but the
    plan's main constraint).

## Open Questions

- **iOS cookie sharing for home-screen apps** wasn't verified for your iOS version; the short code covers both cases.
- *(Resolved at approval)* Theme and Status as two rows above the Setup strip, and a ~6-line composer max height, were
  filled in while drafting and accepted as written.
- **No automated UI tests.** Server-side short-code tests are planned (`remote-pairing.test.mjs`) but, like the
  phone-access tests, not yet written.
- **Plan review** (fresh-eyes, 2026-11-12): both must-fixes applied. Optional notes for the builder: `packages/ui/public/`
  is new (Vite serves it by default); read `lib/use-chat-selection.ts` and the chat store for the `chats` view and the
  dock's pending-prompt source; manifest and icons are static, so they load without a device cookie (intended).
