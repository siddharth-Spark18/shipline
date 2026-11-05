# Chat reliability and controls: verified `-p` behaviour, reminders, Jira, workspace trust, a missing-Node warning, and model / effort / mode / context controls

**Status:** Approved
**Roadmap:** `docs/plans/shipline-adoption-roadmap.md`, the last remaining item, "Chat reliability".
**Branch:** a new branch from `main` (`d1db9ab`), for example `feat/chat-reliability`. Ships as 0.9.0.

## Problem & Goal

The browser chat was built on assumptions about `claude -p` that were marked `UNVERIFIED`. On 2026-11-05 most of them were checked with real runs (`claude` 2.1.317, Haiku, stream-json, a throwaway repo with Shipline installed). Those runs confirmed most of the assumptions and turned up four real problems:

1. **Reminders don't show.** A hook's `systemMessage` doesn't appear where `stream.mjs` looks for it. It arrives as its own event: `{"type":"system","subtype":"informational","level":"notice","content":"PreToolUse:Edit says: Shipline reminder: …"}`. So the chat currently drops every Shipline reminder, fail-open warning and lost-task warning.
2. **Allow rules are ignored at first.** In a repo nobody has opened in interactive `claude`, `-p` ignores `.claude/settings.json` `permissions.allow` and prints on stderr: `Ignoring 2 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. … set projects["<path>"].hasTrustDialogAccepted: true in ~/.claude.json`. So the `~/.shipline/**` allow rules don't apply, and artifact writes ask for permission.
3. **Jira looks broken in the chat.** `system/init` lists MCP servers with a status. The Atlassian connector shows as `{"name":"claude.ai Atlassian","status":"needs-auth","source":"claudeai"}`, and the chat never tells the developer what to do about it.
4. **The usage-limit message appears twice.** It shows once as Claude's text and again as a "Claude" notice card, as in the author's screenshot.

Separately, a teammate without Node 18+ gets a hook error on **every** tool call, because the hooks run `node "$CLAUDE_PROJECT_DIR/.shipline/bin/*.mjs"`.

Finally, the browser chat has none of the session controls that the terminal and the Claude Code extension have: choosing the model, the effort level and the permission mode (Shift+Tab), and seeing how full the context is before auto-compact. The author asked for these on 2026-11-05 and chose to add them to this plan.

**Done when** (author's criteria):
- **Reminders show in the chat:** an edit during a `warn` stage, in the browser chat, shows a "Shipline reminder" notice.
- **The Jira notice works:** a task at the `jira` stage with no Atlassian connector, or one that needs authenticating, shows the right notice, and Claude skips the stage.
- **The trust button works:** a fresh repo shows the trust banner. "Trust this repo" works, and from the next chat on, artifact writes stop asking for permission.
- **The no-Node warning works:** with `node` missing from `PATH`, a session shows one warning and tool calls don't fail.
- **The chat controls work:** in the composer footer, switching the model, effort and mode in a running chat takes effect on the next reply. The context ring shows how close the chat is to auto-compact. A new chat starts with the last choices.
- **Tests:** the suite and CI stay green, because CI is the merge gate.

## Results of the 2026-11-05 checks (`claude` 2.1.317)

| Question | Result |
| --- | --- |
| Q1: session id across `--session-id` / `--resume` | The same id, and `system/init` reports it. |
| Q2: `SHIPLINE_SESSION` in Bash under `-p` | Bash sees it, with the UI's value. |
| Q3: AskUserQuestion through `--permission-prompt-tool` | It works. The relay's `updatedInput.answers` reached Claude (checked 2026-11-04). |
| Q5: a permission-prompt call that waits 10 minutes | **Not checked.** The prompt timeout is lowered to 5 minutes instead. |
| Q6: the guard's denial | A `tool_result` with `is_error: true` and the text `PreToolUse:Edit hook error: Shipline (…): …`. The current `/Shipline \(/` matcher on the first 300 characters matches it. |
| Q8: a hook's `systemMessage` | A `system`/`informational` event whose `content` is `"<Event>:<Tool> says: <message>"`. There's no `hook_response` event for PreToolUse. |
| Hook events | `system`/`hook_started` and `hook_response` appear for SessionStart, carrying `stdout`, `exit_code` and `outcome`. |
| Built-in slash commands | These work in `-p`: `/context`, `/usage`, `/cost`, `/compact`, `/clear`, `/model`, `/init`. `/help` and `/status` reply "isn't available in this environment". `system/init` has `slash_commands` (all of them) and `terminal_slash_commands` (`doctor`, `color`, `focus`, `reload-plugins`). |
| Workspace trust | Untrusted repos: `permissions.allow` is ignored, but hooks still run. |
| MCP status | `system/init.mcp_servers[]` is `{ name, status: 'connected'|'needs-auth'|'failed', source }`. |
| Start-up flags (2.1.318) | `--model <alias or full name>`, `--effort low\|medium\|high\|xhigh\|max`, `--permission-mode manual\|acceptEdits\|plan\|auto\|bypassPermissions\|dontAsk`. None of these are in `FORBIDDEN_FLAGS`. With `--permission-mode manual`, `system/init.permissionMode` reports `"default"`. |
| Stdin control messages | Sent as `{"type":"control_request","request_id":"<id>","request":{…}}`. Claude answers with `{"type":"control_response","response":{"subtype":"success"\|"error","request_id":"<id>","response":{…},"error":"…"}}`. A control message works without an `initialize` first. |
| `initialize` | The response includes `models[]`, each `{ value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels[], supportsAutoMode, … }` (for example `default`, `opus`, `sonnet`, `fable`, `haiku`), plus `current_permission_mode`. It also returns `account` (email, organisation), which must **not** be forwarded or logged. |
| `set_model` `{model}` | Works between turns. The response is `{model: "<resolved id>"}`, and the next assistant message used that model. Claude also replays a `user` event `<local-command-stdout>Set model to …</local-command-stdout>` (`isReplay: true`) and sends a fresh `system/init`. |
| `set_permission_mode` `{mode}` | Works. The response is `{mode}`, followed by `system/status` `{permissionMode}`. |
| Effort | `set_effort` returns the error "Unsupported control request subtype". `apply_flag_settings` `{settings:{effortLevel}}` works: `get_settings.applied.effort` becomes the new level, and `~/.claude/settings.json` is untouched, because it's only the in-memory flag layer. `get_settings` also returns the user's whole merged settings, so the server reads only `applied.effort` and `applied.model`. |
| `get_context_usage` | Returns `{ totalTokens, maxTokens, autoCompactThreshold, isAutoCompactEnabled, percentage, model, categories[{name,tokens,…}], … }`. Example: 19 614 used, threshold 967 000, window 1 000 000. `result.modelUsage[<model>].contextWindow` also gives the window. |
| Not checked | Sending a control message **while a turn is running**. The plan avoids this case (scope H). |

## Scope

### In

**A. Close the `UNVERIFIED` markers**
- Replace each `UNVERIFIED (chat test Qn)` comment with a `Verified 2026-11-05 (claude 2.1.317): …` note that gives the observed result. That covers Q1, Q2, Q3, Q6 and Q8, plus `MIN_CLAUDE_VERSION`, raised to `'2.1.318'` because the chat controls (scope H) were checked on that version; everything else was checked on 2.1.317.
- **Q5:** `PROMPT_TIMEOUT_MS` becomes 300 000 (5 minutes). The message reads "No answer within 5 minutes". `MCP_TOOL_TIMEOUT_ENV` stays `null`, with a note that it was never checked.

**B. Show hook messages from the real stream shape**
- On the server, `stream.mjs`'s `hookSystemMessage(event)` also returns the message from `type: 'system'`, `subtype: 'informational'` events, taken from `content` with the leading `"<Event>:<Tool> says: "` stripped. The existing paths stay.
- In the UI, `timeline.ts`'s `hookMessage(ev)` gets the same rule. A message starting with `Shipline reminder:` becomes a reminder notice, and any other becomes a Shipline notice, as today.
- The fail-open and lost-task banners from `chat.mjs` now fire, because they use the same function.

**C. Built-in slash commands**
- **The verified list:** `commands.mjs` `BUILTIN_COMMANDS` holds the 7 verified ones, each with a short description:
  - `/context`: show context usage;
  - `/usage`: show plan usage;
  - `/cost`: show usage and cost;
  - `/compact`: compact the conversation;
  - `/clear`: clear the conversation;
  - `/model`: show or change the model;
  - `/init`: draft a CLAUDE.md.
- **Extras from the running chat:** for a running chat, `GET /api/chat/commands?chat=<id>` adds any names from that chat's `system/init.slash_commands` that aren't already listed. They're marked `source: 'builtin'` with no description. Names in that chat's `terminal_slash_commands` are left out, and so are names containing `:` that are plugin or MCP commands, since plugins stay out of scope as in the chat input plan.
- **Unavailable commands:** `INTERACTIVE_ONLY` (server, and the copy in the composer) becomes `['help', 'status', 'login', 'logout', 'config', 'permissions', 'doctor', 'terminal-setup', 'color', 'focus', 'reload-plugins']`. **`model` is removed**, because it works in `-p`.

**D. Workspace trust**
- **Detecting it:** `chat.mjs` watches `claude`'s stderr for `this workspace has not been trusted`. It pulls out the path from `projects["<path>"]` and sends an SSE `banner` `{ id: 'trust', kind: 'trust', path, text }`. It's sent once per chat.
- **The banner says:** "Claude Code ignores this repo's Shipline permission rules until the repo is trusted, so writing task files asks for permission." It has a **Trust this repo** button.
- **`POST /api/trust`** takes `{ path }`:
  - `path` must equal the `realpath` of the repo root, compared with `sameRoot`; otherwise 400 `bad-path`;
  - the server **re-reads `~/.claude.json` just before writing**, parses it, sets `projects[path].hasTrustDialogAccepted = true` (creating `projects` and the entry if missing, keeping every other key unchanged), and writes atomically: a temp file in the same folder created with the original file's mode (and `chmod`ed to it), then rename;
  - it returns `{ trusted: true, takesEffect: 'next chat' }`;
  - an unparsable file gives 500 `claude-config-unreadable`, and nothing is written;
  - a missing file gives 409 `claude-config-missing` with the message "open Claude Code once".
- **The confirmation dialog** shows the exact change (`~/.claude.json: projects["<path>"].hasTrustDialogAccepted → true`) before calling the route. After success, the banner says "Trusted. Takes effect when a chat starts."
- **Logging:** only the path and the outcome.

**E. Jira at the `jira` stage**
- **The server records the status:** `chat.mjs` stores each chat's `system/init.mcp_servers`. `GET /api/chats/<id>` gains `jira: 'connected' | 'needs-auth' | 'failed' | 'missing'`, from the first server whose name matches `/atlassian|jira/i`, or `missing` when there is none.
- **The UI shows a notice** in the chat when the chat's task is at the `jira` stage and `jira !== 'connected'`:
  - `missing`: "Jira isn't connected. Add the Atlassian connector in claude.ai → Settings → Connectors. Claude will skip the Jira stage for now."
  - `needs-auth`: "Jira needs authenticating. Run `claude` in a terminal, then `/mcp` → claude.ai Atlassian → Authenticate. Claude will skip the Jira stage for now."
  - `failed`: "The Jira connector failed to start. Check `/mcp` in a terminal `claude`. Claude will skip the Jira stage for now."
- **Claude skips the stage:** the `shipline-workflow` skill and `rules/jira.md` tell Claude to skip the `jira` stage with the reason `Jira not connected` when the Atlassian tools aren't available. The stage is optional, so no question is needed.

**F. The usage-limit message once**
- In the UI, `timeline.ts` stops adding the inline `usage-limit` notice. That covers both the assistant-text match and the `result` notice.
- The `result` error notice is added only when its text differs from the last assistant text, which also fixes other doubled messages.
- The server's top `usage-limit` banner is kept, since it stays visible after scrolling and gives the reset time.

**G. The missing-Node warning (the hooks)**
- **SessionStart's command** in `templates/settings-hooks.json` becomes a shell wrapper. If `node` is missing, or the script exits with an error, it prints one `{"systemMessage":"Shipline needs Node.js 18 or newer on this machine; its workflow hooks are off until it's installed."}` and exits 0:

  ```
  command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR/.shipline/bin/session-start.mjs" || echo '{"systemMessage":"…"}'
  ```

- **The other hooks** (PreToolUse, UserPromptSubmit, PostToolUse) become `command -v node >/dev/null 2>&1 && node "…" || true`. So a missing Node is silent there, and SessionStart's single warning covers it.
- **Too-old Node:** `lib.mjs` checks the Node version at load. Below 18, a script prints the same `systemMessage` (SessionStart) or exits 0 silently (the others).
- **Upgrade:** `upgrade` updates these entries in repos that haven't edited them (the `settings.json#shipline` record). `init` writes the new form.
- **Windows:** hooks run through Git Bash, so the same POSIX syntax applies. This is unverified on Windows.

**H. Chat controls: model, effort, permission mode, context**

The controls sit in the **composer footer**, as in the Claude Code extension:

```
│ Ask Claude…                                          │
│ [Opus 5.5 ▾] [Effort: high ▾] [Manual ▾]     ◔ 12%   │
```

They use the existing `dropdown-menu.tsx`, so no new dependency is needed.

- **Model picker:**
  - Lists `models[]` from `initialize`, showing `displayName` and `description`. The value sent is `value` (an alias such as `opus`).
  - Before any chat in this repo has run, nothing has come from `initialize` yet. The picker then shows the cached list from `controls.json` (below). With no cache, it shows a fallback list: `default`, `opus`, `sonnet`, `haiku`, labelled with those names.
- **Effort picker:**
  - Shows the chosen model's `supportedEffortLevels`, or `low`, `medium`, `high`, `xhigh`, `max` when unknown.
  - It's hidden when the model has `supportsEffort: false`.
  - If a model change drops the current level from the list, the effort falls back to `high`, or the highest level the model supports.
- **Mode picker:** offers `Manual`, `Accept edits`, `Plan` and `Auto`.
  - `Auto` is shown only when the model has `supportsAutoMode` (or when the model is unknown).
  - `bypassPermissions` and `dontAsk` are never offered.
  - Mapping: the flag value `manual` corresponds to `default` in control messages and `system/status`. The UI shows both as "Manual".
- **Context ring:**
  - Shows `round(totalTokens / autoCompactThreshold × 100)`% with the tooltip "<n>% of the way to auto-compact". When `isAutoCompactEnabled` is false, it shows `percentage` of `maxTokens`, with the tooltip "auto-compact off".
  - Clicking it opens a dropdown with: tokens used, the auto-compact threshold, the window, the 5 largest `categories` (name and tokens), and a **Compact now** button. The button sends `/compact` as a normal message, so it's disabled while a turn is running.
  - The ring is hidden until the first reading arrives.

**When a change takes effect.** Whenever the user picks a value:

| The chat is… | What happens |
| --- | --- |
| running and idle | The server sends the control message now: `set_model`, `apply_flag_settings {settings:{effortLevel}}` or `set_permission_mode`. |
| running a turn | The server keeps the change and sends it right after that turn's `result`. The control is marked "applies after this reply" meanwhile. Nothing is sent mid-turn. |
| ended, or not started yet (a new chat) | The value is saved, and passed as `--model`, `--effort` and `--permission-mode` when the chat starts or continues. The UI says "Applies when this chat continues". This is the "next chat only" answer. |

- **Pending changes and "idle":**
  - A turn is running when the chat's existing `chat.busy` flag is `true`. It's set when a message is sent and cleared on `result`. Idle means the process is running and `chat.busy` is `false`.
  - A change picked during a turn is kept on the chat as `chat.pending = { model?, effort?, permissionMode? }`, merged per key. It's also mirrored to the chat's `sessions.json` entry as `controls.pending`.
  - After the turn's `result`, each pending key is sent. On success it moves into `controls` and is removed from `pending`; on failure it's dropped and the toast shows.
  - If the chat ends first, `controls.pending` is merged into `controls` when the chat continues, and passed as flags.
  - `GET /api/chat/controls` returns this `pending` object, or `null` when it's empty.
- **Control messages:**
  - Every message the server sends carries a `request_id` (`shipline-<n>`).
  - `chat.mjs` handles `control_response` lines *before* the `KNOWN_TYPES` check. They aren't forwarded as chat events, and they no longer log `unknown-event-type`.
  - On `subtype: 'error'`, or no response within 10 s, the chat's control goes back to its previous value. The UI shows a toast: "Couldn't change <model/effort/mode>: <error>".
- **Keeping in sync:**
  - The server follows `system/status.permissionMode` (for example, when Claude leaves plan mode itself) and `system/init.model` / `permissionMode`, and sends an SSE `chat` event `{ kind: 'controls', controls }` when they change.
  - The replayed `<local-command-stdout>Set model to …` user event (`isReplay: true`) is **not** shown as a user message in `timeline.ts`.
- **Reading context:**
  - After each turn's `result`, after a successful `set_model`, and once after `system/init`, the server sends `get_context_usage`.
  - It keeps only `{ totalTokens, maxTokens, autoCompactThreshold, isAutoCompactEnabled, percentage, categories: top 5 [{name, tokens}] }`.
  - It sends an SSE `chat` event `{ kind: 'context', context }`.
- **The model list:** at each chat start, the server sends `initialize` once. It keeps only `models[]` (the fields listed above) and `current_permission_mode`. The rest of the response, including `account`, is never stored, logged or forwarded.
- **The effort reading:** after `initialize`, the server sends `get_settings` and reads only `applied.effort`, so the picker shows the effort in force, including one from the user's own settings.
- **Remembering choices:**
  - `<store>/ui/controls.json` holds `{ model, effort, permissionMode, models }`:
    - `model`, `effort` and `permissionMode` are the repo's last picks;
    - `models` is the last list from `initialize`.
  - Every pick updates it, written atomically like `sessions.json`.
  - A new chat starts with these values passed as flags. Values never picked are left out, so Claude's own settings apply.
  - Each chat's own current values are stored on its `sessions.json` entry as `controls: { model, effort, permissionMode }`. Continuing an ended chat uses that entry, not the repo defaults.
- **Validation** (otherwise 400 `bad-control`):
  - `model` must be one of the cached `models[].value`, one of the fallback aliases, or match `/^claude-[a-z0-9.-]+$/`;
  - `effort` must be one of the 5 levels;
  - `permissionMode` must be one of `manual`, `acceptEdits`, `plan`, `auto`.
  - Values are always passed to `claude` as separate argv entries, never through a shell string.
- **API:**
  - `GET /api/chat/controls?chat=<id>` returns `{ models, model, effort, permissionMode, context | null, pending: {…} | null }`. Without `chat`, it returns the repo defaults.
  - `POST /api/chat/controls` takes `{ chat?: id, model?, effort?, permissionMode? }`. It updates the repo defaults, and the chat if given, and returns `{ controls, applied: 'now' | 'after-turn' | 'next-start' }`.

### Out

- Checking whether a prompt can wait 10 minutes (the timeout is lowered instead).
- Changing controls in the middle of a running turn. The change waits for the turn to end.
- Fast mode, output styles, `bypassPermissions` / `dontAsk`, the advisor, and thinking-off.
- Changing the auto-compact threshold (`--autocompact`). The ring only shows it.
- Writing any of these choices to Claude's own settings files.
- Authenticating MCP connectors from the UI. The developer does it in a terminal `claude`.
- Plugin and MCP-provided slash commands.
- Any other edit to `~/.claude.json`, and "untrust".
- Installing Node for the developer.

## Surface Area

- **UI server:** `stream.mjs`, `chat.mjs`, `chat-routes.mjs`, `commands.mjs`, `prompts.mjs`, `claude.mjs`, and a new `trust.mjs`.
- **Browser UI:** `timeline.ts`, `composer.tsx`, `chat-page.tsx`, `notices.tsx`, `banners.tsx`, `slash-menu.tsx`, `lib/api.ts` and `lib/types.ts`.
- **Vendored templates:** `settings-hooks.json` and `lib.mjs` (the Node version check), plus the wording in `skills/shipline-workflow/SKILL.md` and `rules/jira.md`.
- **CLI:** `known-hashes.json` (regenerated) and `package.json` 0.9.0. `INTERFACE` stays 4, because `bin/` behaviour doesn't change in a way the UI depends on.
- **API:**
  - `GET /api/chat/commands?chat=<id>` takes an optional parameter;
  - `GET /api/chats/<id>` gains `jira`;
  - new `POST /api/trust`;
  - SSE `banner` gains the kind `trust`, with `path`;
  - new `GET` and `POST /api/chat/controls`;
  - SSE `chat` gains the kinds `controls` and `context`.
- **Store:** new `<store>/ui/controls.json`, and `sessions.json` entries gain an optional `controls`. Older UIs ignore both, so `STORE_INTERFACE` stays 3.

## Files to Touch

- `packages/cli/src/ui/stream.mjs` (**modify**): `hookSystemMessage` reads `system/informational` `content` and strips the prefix. The Q6 and Q8 notes become verified notes.
- `packages/cli/src/ui/chat.mjs` (**modify**):
  - verified notes in place of the Q1 and Q2 markers;
  - store `slashCommands`, `terminalSlashCommands` and `mcpServers` from `system/init` on the chat;
  - the stderr trust detection, sending the `trust` banner once.
- `packages/cli/src/ui/chat-routes.mjs` (**modify**):
  - `GET /api/chat/commands` takes `?chat=` and merges that chat's init commands;
  - `GET /api/chats/<id>` gains `jira`;
  - register `POST /api/trust` (from `trust.mjs`).
- `packages/cli/src/ui/trust.mjs` (**create**): `trustRepo(root, path)`, the safe edit of `~/.claude.json` described in scope D. It has **its own** atomic write and doesn't reuse `writeAtomic` from `sessions.mjs` or `setup.mjs`, since neither keeps the file's mode:
  - read the mode with `statSync(file).mode & 0o777`;
  - write the temp file in the same folder with `{ mode }`, then `chmodSync(tmp, mode)` so the umask doesn't change it;
  - `renameSync` it into place;
  - remove the temp file on any error. It uses `os.homedir()`, or `CLAUDE_CONFIG_DIR`'s parent the way Claude does, falling back to `~/.claude.json`.
- `packages/cli/src/ui/commands.mjs` (**modify**): `BUILTIN_COMMANDS` gets the 7 entries with descriptions; the new `INTERACTIVE_ONLY` list; `listCommands(root, opts)` accepts `opts.initCommands` and `opts.terminalCommands` for the merge.
- `packages/cli/src/ui/prompts.mjs` (**modify**): `PROMPT_TIMEOUT_MS = 300_000` and the message text. The Q3 and Q5 notes are updated.
- `packages/cli/src/ui/claude.mjs` (**modify**): `MIN_CLAUDE_VERSION` gets a verified note, and the Q1, Q3 and Q5 notes are updated.
- `packages/ui/src/pages/chat/timeline.ts` (**modify**):
  - `hookMessage` reads `system/informational` `content`;
  - the inline `usage-limit` notices are removed;
  - a `result` error notice is skipped when it repeats the last assistant text.
- `packages/ui/src/pages/chat/composer.tsx` (**modify**): the same `INTERACTIVE_ONLY` list as the server (`model` removed).
- `packages/ui/src/pages/chat/slash-menu.tsx` (**modify**): pass the active chat id to `listCommands`.
- `packages/ui/src/pages/chat/chat-page.tsx` and `packages/ui/src/pages/chat/notices.tsx` (**modify**): the Jira notice when the chat's task is at the `jira` stage and `jira !== 'connected'`.
- `packages/ui/src/components/banners.tsx` (**modify**): the `trust` banner, its confirmation dialog, its "Trust this repo" action and the after-success text.
- `packages/ui/src/lib/api.ts` and `packages/ui/src/lib/types.ts` (**modify**): `listCommands(chatId?)`, `trustRepo(path)`, `ChatDetail.jira`, and the `BannerKind` `trust`.
- `packages/cli/src/ui/controls.mjs` (**create**): scope H on the server.
  - `readDefaults(root)` / `writeDefaults(root, patch)` for `controls.json`;
  - `validateControls(input, models)`;
  - `controlArgs(controls)`, which returns `['--model', m, '--effort', e, '--permission-mode', p]` for the values that are set;
  - the `control_request` builders;
  - `pickContext(response)`, `pickModels(response)` and `pickEffort(response)`, which keep only the listed fields.
- `packages/cli/src/ui/claude.mjs` (**modify**, in addition to the above): `buildArgs` accepts `controls` and appends `controlArgs(controls)`.
- `packages/cli/src/ui/chat.mjs` (**modify**, in addition to the above):
  - a `sendControl(chat, request)` that returns a promise for the matching `control_response`, rejecting on error or after 10 s;
  - `control_response` lines are handled before the `KNOWN_TYPES` check;
  - at start: `initialize`, then `get_settings`, then `get_context_usage`;
  - after each `result`: send any pending changes, then `get_context_usage`;
  - follow `system/status` and `system/init` changes, and emit `chat` `controls` and `context` events;
  - start and continue pass the chat's controls (or the repo defaults for a new chat) to `buildArgs`;
  - store `controls` on the `sessions.json` entry.
- `packages/cli/src/ui/chat-routes.mjs` (**modify**, in addition to the above): `GET` and `POST /api/chat/controls`.
- `packages/cli/src/ui/sessions.mjs` (**modify**): export its `writeAtomic` for `controls.mjs`. `updateChat` already merges patches, so it covers `controls`.
- `packages/ui/src/pages/chat/chat-controls.tsx` (**create**): the footer row with the model, effort and mode dropdowns, the context ring and its dropdown (including Compact now), the "applies after this reply" and "applies when this chat continues" hints, and the error toast (via `sonner`).
- `packages/ui/src/pages/chat/composer.tsx` (**modify**, in addition to the above): render `chat-controls.tsx` in the footer. Compact now calls the composer's existing send with `/compact`.
- `packages/ui/src/pages/chat/chat-store.ts` (**modify**): fold the `controls` and `context` chat events into `ChatLive` (`controls?`, `context?`).
- `packages/ui/src/pages/chat/timeline.ts` (**modify**, in addition to the above): skip `user` events with `isReplay: true` whose text is `<local-command-stdout>…`.
- `packages/ui/src/lib/api.ts` and `packages/ui/src/lib/types.ts` (**modify**, in addition to the above): `getControls(chatId?)`, `setControls(body)`, and the types `ChatControls`, `ModelOption`, `ContextUsage`, and `ChatEvent.kind` adding `'controls' | 'context'`.
- `packages/cli/templates/settings-hooks.json` (**modify**): the hook command wrappers from scope G.
- `packages/cli/templates/shipline/bin/lib.mjs` (**modify**): a Node major-version check at load, using the SessionStart message rule above.
- `packages/cli/templates/claude/skills/shipline-workflow/SKILL.md` and `packages/cli/templates/shipline/rules/jira.md` (**modify**): skip the Jira stage with the reason `Jira not connected` when the Atlassian tools aren't available.
- `packages/cli/src/known-hashes.json` (**modify**): regenerated with `packages/cli/scripts/hash-templates.mjs` for 0.9.0.
- `packages/cli/package.json` (**modify**): version 0.9.0.
- `docs/plans/shipline-adoption-roadmap.md` (**modify**): mark Chat reliability as covered by this plan.

### Tests (written separately, but listed here)

- `packages/cli/test/ui/stream.test.mjs` (**create**, or extend the existing stream tests): `hookSystemMessage` on a real `system/informational` event, with the prefix stripped; the existing shapes still work; the captured Q6 `tool_result` text is classified as a Shipline block.
- `packages/cli/test/fixtures/streams/*.jsonl` (**modify**/**create**): a fixture with a real-shape `system/informational` reminder; an `init` with `mcp_servers` (Atlassian `needs-auth`) plus `slash_commands`/`terminal_slash_commands`; stderr carrying the trust message. Each is marked as reproducing a 2026-11-05 capture.
- `packages/cli/test/ui/chat.test.mjs` (**modify**):
  - the reminder appears as a notice event;
  - the `trust` banner is sent once, with the path;
  - `GET /api/chats/<id>` reports `jira` in each of the four states;
  - commands are merged with `?chat=`, minus the terminal and namespaced ones.
- `packages/cli/test/ui/trust.test.mjs` (**create**), using a temp home and never the real `~/.claude.json`:
  - sets only that key, and every other key survives byte-for-byte as parsed JSON;
  - creates `projects` when missing;
  - a path that doesn't match gives 400;
  - an unparsable file gives 500 and nothing is written;
  - a missing file gives 409;
  - the write is atomic and keeps the file's mode.
- `packages/cli/test/ui/commands.test.mjs` (**modify**): the 7 built-ins with descriptions; `model` is no longer interactive-only; the merge rules.
- `packages/cli/test/ui/relay.test.mjs` (**modify**): the 5-minute timeout constant and its message.
- `packages/cli/test/node-preflight.test.mjs` (**create**, POSIX; skipped on win32 with a reason):
  - runs each `settings-hooks.json` command through `sh -c` with a `PATH` that has no `node`;
  - SessionStart prints the warning JSON and exits 0;
  - the others print nothing and exit 0;
  - with a fake `node` that exits 1, the same results;
  - with real `node`, the normal output is unchanged.
- `packages/cli/test/init-version.test.mjs` and `packages/cli/test/upgrade.test.mjs` (**modify**): the new hook command form is written by `init` and replaced by `upgrade` when unedited.
- `packages/cli/test/ui/controls.test.mjs` (**create**):
  - validation (good and bad values, including shell metacharacters);
  - `controlArgs`;
  - the `pick*` functions drop `account` and other settings;
  - `controls.json` read and write.
- **Chat controls** in `packages/cli/test/ui/chat.test.mjs` (**modify**). The fake `claude` answers `control_request` lines with captured-shape `control_response`s. Cases:
  - idle → sent now;
  - busy → sent after `result`;
  - ended → flags on continue;
  - a new chat uses the repo defaults;
  - an error or timeout reverts the value;
  - `system/status` emits `controls`;
  - `context` is emitted after `result`;
  - `control_response` is not forwarded and doesn't log `unknown-event-type`.

## Behavior & Edge Cases

- **A hook message without the `"<Event>:<Tool> says: "` prefix** is used as it is.
- **Several trust messages in one chat:** one banner. If the server restarts, the banner returns at the next chat start, while the repo is still untrusted.
- **A running `claude` writing `~/.claude.json` at the same time:** re-reading just before writing narrows the window, but can't remove it. The atomic rename means the file is never half-written. This is accepted and noted.
- **Trusting from a symlinked path:** the path from Claude's message is used exactly as given, since that's the key Claude reads, after checking it resolves to the same repo.
- **Jira:** a chat with no `system/init` yet (not started) reports `jira: null`, and no notice is shown. Several Atlassian-like servers: the first `connected` one wins, otherwise the first match.
- **Node 18 present but `node` is a different binary on `PATH` (nvm):** nothing changes. The wrapper only checks that a `node` exists and that the script succeeded.
- **Several picks during one turn:** only the last value of each control is sent after the turn.
- **The chat ends or fails before a pending change is sent:** it's saved on the chat's entry and applies at continue.
- **Plan mode:** when Claude asks to leave plan mode, the request arrives as a normal permission card (`ExitPlanMode`), handled by the existing permission card. The mode picker updates from `system/status`.
- **A cached model no longer exists** (the account changed): `claude` rejects it at start, and the existing fatal-start path shows stderr. The picker refreshes from `initialize` on the next successful start.
- **Compact now:** auto-compact and `/compact` produce new context numbers after the turn, and the ring updates from the next `get_context_usage`.
- **The SessionStart script fails for another reason** (a broken config): `failOpen` already prints a `systemMessage` and exits 0, so the wrapper's `||` doesn't fire twice.

## Constraints

- **No new dependencies.** The hooks stay Node 18 and dependency-free, and the wrappers use only POSIX `sh` features.
- **`trust.mjs`** never logs or returns the contents of `~/.claude.json`. It only changes the one key.
- **Not a breaking change:** `INTERFACE` stays 4, and old UIs keep working with 0.9.0 repos.

## Verification

1. **Reminders:** in the browser chat on a repo whose Plan stage is set to `warn`, ask Claude to edit a source file. A "Shipline reminder" notice appears, and the edit goes through.
2. **The Jira notice:** start a Feature task in the browser chat, with the Atlassian connector either not added or not authenticated. When the task is at the `jira` stage, the matching notice shows, and Claude skips the stage with "Jira not connected".
3. **Workspace trust:** on a fresh repo that has never been opened in interactive `claude`, start a chat. The trust banner shows. Click "Trust this repo" and confirm. Start a new chat; artifact writes no longer show permission cards. `~/.claude.json` differs only in that key.
4. **No Node:** start `claude` from a shell whose `PATH` has no `node`, in a repo with Shipline. There's one "Shipline needs Node.js 18" warning, and tool calls work.
5. **Chat controls:**
   - In a running chat, switch Haiku → Sonnet and ask "which model are you?". The reply comes from Sonnet; the turn's `assistant.message.model` shows it.
   - Switch to Plan, then ask for an edit. Claude plans instead of editing.
   - Set effort to low. The picker shows low after a reload.
   - The ring shows a percentage, and Compact now reduces it.
   - Start a new chat. It starts with the same model, effort and mode.
   - `~/.claude/settings.json` is unchanged.
6. **Tests:** `npm test`, `test:hooks` and CI are green on all three operating systems.

## Open Questions

- **Q5:** can a `--permission-prompt-tool` call wait longer than 5 minutes? This wasn't checked. 5 minutes is assumed to be safely under any limit.
- **Hook wrappers on Windows:** that Claude Code runs them through Git Bash, so `command -v` works, is unverified.
- **Control messages during a turn:** these weren't tested, so the plan waits for the turn to end. If a later test shows they're safe, mode changes could apply immediately, as Shift+Tab does in the terminal.
- **The control-message protocol is undocumented for the CLI:** it's what the Agent SDK uses, and it was checked on 2.1.318. A future `claude` could change it. Failures revert the value and show a toast, so the chat itself keeps working.
- **Interactive commands:** the `INTERACTIVE_ONLY` additions `login`, `logout`, `config`, `permissions` and `terminal-setup` weren't run in `-p`. They're treated as unavailable because they're interactive. If one turns out to work, it only stops being refused.
