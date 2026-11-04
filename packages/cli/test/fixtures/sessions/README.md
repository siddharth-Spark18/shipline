NOT REAL CAPTURES. Hand-made stand-ins for Claude Code's own session files
(`<CLAUDE_CONFIG_DIR>/projects/<munged repo path>/<session id>.jsonl`), used by
`test/ui/transcript.test.mjs`. Session files can't carry comments (every line is
read as JSON), so this note marks them. Line shapes follow
`apps/local/src/server/transcript.ts`; replace with real captures from the chat
test (plan item 19, question 8) when they exist.

- `session.jsonl`: a short chat with a summary line, user text, assistant text,
  a Bash tool_use and result, a guard denial, a sidechain (sub-agent) line, a
  meta line, and one line that does not parse.
- `corrupted.jsonl`: no line parses.
