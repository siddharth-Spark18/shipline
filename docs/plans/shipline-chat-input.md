# Chat input: slash commands, images and `!` commands

**Status:** Draft
**Roadmap:** this item was added by the author after Phase 5. It's the third remaining plan. *Trust* is reviewed (its must-fixes are pending), and *Chat reliability* comes after this.
**Branch:** a new branch from `main`, for example `feat/chat-input`. It doesn't depend on Trust.

## Problem & Goal

The browser chat's composer only sends plain text. Developers coming from Claude Code expect three things from the input:
- **slash commands:** the repo's own commands and skills;
- **images:** screenshots and designs;
- **`!` commands:** shell commands whose output they can hand to Claude.

**How the chat works today:** it runs `claude -p --input-format stream-json --output-format stream-json`.
- **Slash commands:** a message starting with `/` is passed to Claude Code as-is. Custom commands and skills should work in `-p` mode; interactive-only built-ins don't. Which built-ins work is unverified.
- **Images:** they can be sent as image blocks in the stream-json user message. Also unverified in `-p`.
- **`!` commands:** `claude -p` has no bash mode, so the **Shipline UI server runs them itself**.

**Done when** (the author's checks):
- **The slash menu:** typing `/` lists the repo's commands and skills, and running one works in a real chat.
- **Images:** pasting, dropping and attaching an image all work, and Claude describes the image correctly.
- **`!` commands:**
  - `!git status` streams its output;
  - Stop ends a long-running command;
  - "Send to Claude" makes Claude use the output.
- **Tests:** existing and new tests stay green on all three operating systems, because CI is the merge gate.

## Scope

### In

**A. Slash commands**
- **Opening the menu:** typing `/` as the first character in the composer opens an autocomplete menu above the input.
- **What the menu lists:**
  - the custom commands in `<repo>/.claude/commands/**/*.md` and `~/.claude/commands/**/*.md`. The name is the path without `.md`; subfolders become `folder:name`, as in Claude Code. The description comes from the frontmatter `description`, or else the first line of the body;
  - the skills in `<repo>/.claude/skills/*/SKILL.md` and `~/.claude/skills/*/SKILL.md`, with name and description from the frontmatter;
  - built-ins from a constant list that is **empty for now**. Entries are added only once the chat test confirms they work in `-p`.
- **How the menu behaves:**
  - typing more filters it (prefix match first, then substring);
  - ↑ and ↓ move through it;
  - Tab or Enter completes the name and leaves the cursor after it, for arguments;
  - Esc closes it.
  - Each entry shows its name, its description and its source (repo, user or built-in).
- **Sending:** the message is sent unchanged (`/name args`), as a normal user message.
- **Unknown or interactive-only commands:** typing one not in the list is still sent as typed. If it's a known interactive-only built-in (`/config`, `/login`, `/logout`, `/model`, `/permissions`, `/doctor`, `/terminal-setup`), the composer shows inline: "/model isn't available in the browser chat; use Claude Code in a terminal." Nothing is sent.

**B. Images**
- **How to add one:** paste from the clipboard into the composer, drop files onto it, or use a paperclip **Attach** button that opens a file picker.
- **Limits:**
  - PNG, JPEG, GIF and WebP only;
  - up to 5 MB each, and up to 5 per message;
  - anything else is refused before sending, with a message such as "Only PNG, JPEG, GIF or WebP up to 5 MB, 5 per message".
- **In the composer:** attached images show as thumbnails above the input, each with a remove (×) button. A message can be images only, or text with images.
- **Sending:** the browser sends base64 data to the server. The server writes one stream-json user message with image blocks first, then the text block:

  ```
  [{ "type": "image", "source": { "type": "base64", "media_type", "data" } }, …, { "type": "text", "text" }]
  ```

- **In the chat:** your own message shows its images as thumbnails, and clicking one opens it full size in a dialog.
- **History:** reopened chats show images from Claude's own session file. `transcript.mjs` emits image items, and Shipline stores no images of its own.

**C. `!` commands**
- **What counts as one:** a composer message starting with `!` is a shell command. It runs **as the developer, in the repo folder, like their own terminal**.
  - Shipline's guard doesn't apply, since this isn't Claude's action.
  - Nothing is sent to Claude.
- **The shell:** on POSIX, `$SHELL -c "<command>"` (falling back to `/bin/sh`). On Windows, `cmd.exe /d /s /c "<command>"`. The working directory is the repo root.
- **Its own process group:** on POSIX it's spawned `detached`, so Stop can kill the whole tree. On Windows, `taskkill /T` is used.
- **Output:**
  - stdout and stderr stream live into a terminal-style block in the chat, showing the command, the live output and a Stop button;
  - when it finishes, the block shows the exit code and how long it took;
  - output is kept up to 1 MB per command. Past that, the block says "output truncated after 1 MB" and the rest is dropped (the process keeps running).
- **Stopping:**
  - **Stop** sends SIGTERM to the process group, then SIGKILL after 5 s (on Windows, `taskkill /T`, then `/T /F`);
  - commands also end when their chat stops, or when the UI server shuts down.
- **Running while Claude works:** `!` commands run independently of Claude's turn, and several can run at once.
- **Send to Claude:** after the command finishes, the block shows **Send to Claude**. Clicking it sends a user message right away, with the output trimmed to its last 200 lines (and a note when lines were left out):

  ````
  Output of `<command>` (exit <code>):
  ```
  <output>
  ```
  ````

  While Claude is in the middle of a turn, the button is disabled with "Claude is working". It's also disabled while the command is still running.
- **Without an active chat:** `!` is disabled on the new-chat screen and in read-only (ended) chats, with the hint "Start or continue a chat to run commands".

### Out

- Built-in slash commands, until the chat test confirms them. The constant list stays empty.
- Plugin-provided commands and skills.
- Image editing or annotation, and non-image files such as PDFs.
- Interactive shell sessions (stdin to a `!` command) and a full terminal emulator. `!` commands get no input.
- `!` output being sent to Claude automatically. It's sent only when the developer clicks.
- Applying Shipline's guard to `!` commands.

## Surface Area

- **UI server:** `chat-routes.mjs` (new routes), `chat.mjs` (sending images; running `!` commands), `stream.mjs` (the image message builder), `transcript.mjs` (image history items), a new `commands.mjs` (command discovery) and a new `shell.mjs` (the `!` runner). `http.mjs` gets a larger body limit for the message route only.
- **Browser UI:** `composer.tsx` (slash menu, attachments, `!` handling), a new `slash-menu.tsx`, a new `attachments.tsx`, a new `shell-block.tsx`, `message-list.tsx` and `timeline.ts` (image and shell items), `chat-page.tsx`, `lib/api.ts`, `lib/types.ts` and `lib/events.ts`.
- **Data:** nothing new is stored. `!` command state lives in server memory and is lost when the server restarts.

### API

- **`GET /api/chat/commands`** returns `{ commands: [{ name, description, source: 'repo'|'user'|'builtin', kind: 'command'|'skill' }] }`. It's re-read on each request, so it stays current.
- **`POST /api/chats/<id>/message`:**
  - the body gains an optional `images: [{ media_type, data }]`, where `data` is base64 with no `data:` prefix;
  - the server checks the type, the size (decoded at most 5 MB each) and the count (at most 5) again, and replies 400 `bad-image` with the reason;
  - this route's body limit becomes 40 MB. All other routes keep 1 MB;
  - `text` may be empty when there are images.
- **`POST /api/chats` (start a chat):** accepts the same `images`.
- **`POST /api/chats/<id>/shell`** takes `{ command }` and returns `{ runId }`.
  - It returns 400 `bad-request` for an empty command, 409 `chat-ended` when the chat isn't active, and 423 `repo-newer` per the existing rule.
- **`POST /api/chats/<id>/shell/<runId>/stop`** returns `{ stopped: true }`, or 404 when the command has already finished or doesn't exist.
- **New SSE `shell` events:**
  - `{ chatId, runId, kind: 'start', command, startedAt }`;
  - `{ …, kind: 'output', stream: 'stdout'|'stderr', data }`;
  - `{ …, kind: 'truncated' }`;
  - `{ …, kind: 'exit', code, signal, durationMs }`.
- **`GET /api/chats/<id>`:** the history gains `{ kind: 'image', media_type, data }` items, in order next to the user text they came with. `!` blocks aren't part of the history; they exist for the page session only.

## Files to Touch

### UI server (`packages/cli/src/ui/`)

- `commands.mjs` (**create**): `listCommands(root)`. It scans the four places in scope A, reads the YAML frontmatter with the vendored `parseYaml`, falls back to the first body line, and de-duplicates by name with the repo winning over the user. It returns the shape in API. The built-ins come from `BUILTIN_COMMANDS = []` (with a comment saying which are known not to work in `-p`), plus `INTERACTIVE_ONLY = ['config','login','logout','model','permissions','doctor','terminal-setup']`.
- `shell.mjs` (**create**): `startShell({ chatId, root, command, onEvent })` returns `{ runId, stop }`.
  - It spawns the command per scope C, tracks the 1 MB cap, emits the events, and keeps a map of runs per chat.
  - `stopAll(chatId)` and `stopEverything()` are called when a chat stops and when the server shuts down.
  - On Windows it reuses `chat.mjs`'s tree-kill.
- `stream.mjs` (**modify**): `userMessage(text, images = [])` builds the content array, with the images first.
- `chat.mjs` (**modify**):
  - the send path passes `images` through;
  - stopping a chat calls `shell.stopAll(chatId)`;
  - the tree-kill helper is exported for `shell.mjs`.
- `chat-routes.mjs` (**modify**):
  - validate `images` on start and message (400 `bad-image`);
  - add the shell start and stop routes and `GET /api/chat/commands`.
- `http.mjs` (**modify**): `readBody(req, { max })` takes an optional limit (default `MAX_BODY`). The message and start-chat routes pass 40 MB.
- `transcript.mjs` (**modify**): emit `{ kind: 'image', media_type, data }` for image blocks in user entries.
- `server.mjs` (**modify**): register the new routes (if they aren't already registered through `chat-routes`), and call `shell.stopEverything()` on shutdown.

### Browser UI (`packages/ui/src/`)

- `pages/chat/composer.tsx` (**modify**):
  - detect a leading `/` (show the menu) and a leading `!` (shell mode: a different hint, sent to the shell route);
  - paste and drop handlers, and the Attach button;
  - attachment thumbnails and validation messages;
  - the interactive-only inline message.
- `pages/chat/slash-menu.tsx` (**create**): the filterable menu, with keyboard handling and descriptions. Data comes from `GET /api/chat/commands`, fetched when the menu opens.
- `pages/chat/attachments.tsx` (**create**): file reading to base64, the type, size and count checks, and the thumbnail strip with remove buttons.
- `pages/chat/shell-block.tsx` (**create**): a terminal-style block showing the command, the streaming output (monospace, scrollable, kept at the bottom), Stop, the exit code and duration, the "output truncated" note, and **Send to Claude**. Send to Claude formats the message per scope C and is disabled while Claude is busy or the command is running.
- `pages/chat/message-list.tsx` and `pages/chat/timeline.ts` (**modify**):
  - user messages with images;
  - image history items;
  - shell blocks placed in order with the chat.
- `pages/chat/chat-page.tsx` (**modify**): pass the busy state and the chat id to the composer, and disable `!` and attachments when there's no active chat.
- `components/image-viewer.tsx` (**create**): a full-size image in a dialog.
- `lib/api.ts`, `lib/types.ts` and `lib/events.ts` (**modify**):
  - `listCommands`, `startShell` and `stopShell`;
  - `images` on send and start;
  - the `shell` SSE events, routed to the chat store.

### Tests (written separately, but listed here)

- `packages/cli/test/ui/commands.test.mjs` (**create**):
  - lists repo and user commands, including a namespaced subfolder;
  - lists skills;
  - descriptions come from the frontmatter, or else the first line;
  - the repo wins on a name clash;
  - an empty or missing folder works;
  - the built-ins list is empty.
- `packages/cli/test/ui/shell.test.mjs` (**create**):
  - `!echo` streams and exits 0;
  - stderr is captured;
  - a non-zero exit code is reported;
  - the 1 MB cap produces `truncated`;
  - Stop kills a long-running command and its child (POSIX group / Windows tree);
  - stopping the chat stops its commands;
  - the server shutting down stops everything;
  - 409 on an ended chat;
  - runs on all three operating systems.
- `packages/cli/test/ui/chat.test.mjs` (**modify**):
  - a message with images writes the expected stream-json content to the fake claude;
  - 400 `bad-image` for a wrong type, an image over 5 MB and more than 5 images;
  - the 40 MB limit on the message route, and 1 MB elsewhere.
- `packages/cli/test/ui/transcript.test.mjs` (**modify**): image history items.

## Behavior & Edge Cases

- **A `/` in the middle of the text** doesn't open the menu. Only a leading `/` does.
- **A message that is only `!` or `!   `:** not run, with the hint "type a command after !".
- **A pasted image larger than 5 MB:** refused with the size shown. The rest of the attachments stay.
- **Dropping several files** where some are invalid: the valid ones are attached, and the invalid ones are listed in one message.
- **A `!` command that prints binary output:** shown as UTF-8 with replacement characters. Nothing crashes.
- **The UI server restarting:** running `!` commands are killed on shutdown, and their blocks disappear when the page reloads.
- **Claude doesn't accept image blocks in `-p`** (unverified): the turn fails with the stream error shown, and the plan's Open Question records it. The chat test gets a new question.
- **Sending output while the chat ended in the meantime:** the button shows "chat ended" and does nothing.
- **Windows:** the command runs through `cmd.exe`, so `$SHELL` aliases and syntax don't apply. The hint in the composer says "runs in cmd.exe" on Windows.

## Constraints

- **No new dependencies,** on either the server or the UI. The UI bundle must stay under 400 KB gzipped.
- **The server never logs** image data or `!` output. The UI log records only the command text, the exit code and the duration.
- **`!` commands run with the developer's permissions,** like their own terminal. The UI server is already loopback-only and needs the session cookie, so a `!` command can only come from the developer's own browser tab.

## Verification

1. **The slash menu:** in a repo with `.claude/commands/review-pr.md` and a skill, typing `/` lists both with their descriptions. Picking `/review-pr` and sending it makes Claude run it. `/model` shows the "not available" message.
2. **Images:** paste a screenshot, drop a PNG and attach a JPEG, then ask "describe these". Claude describes all three. A 6 MB image and a PDF are refused. Reopening the chat shows the thumbnails.
3. **`!` commands:**
   - `!git status` streams its output and shows exit 0;
   - `!npm run dev` (or `!sleep 60`) keeps running until Stop, then the process is gone;
   - "Send to Claude" on the `git status` output, then asking "what changed?", gives an answer that uses it.
4. **Tests:** `npm test` and CI are green on Ubuntu, macOS and Windows.

## Open Questions

- **Resolved on 2026-11-04** (a real run, `claude` 2.1.317, `-p` with stream-json input):
  - **Image blocks work:** a base64 PNG image block plus text in one user message was described correctly.
  - **Custom commands run:** a user message `/hello` ran `.claude/commands/hello.md`.
- **Still open:** which built-in commands work in `-p`. The built-in list stays empty until that's checked.
- **Possible improvement (not in this plan):** `claude`'s `system/init` event includes a `slash_commands` array, the names of every command available in the session, plugins included. A later change could use it to list plugin commands, or to hide entries Claude doesn't actually load. It has no descriptions, which is why this plan scans files.
