// PostToolUse hook (matcher AskUserQuestion): records the developer's own answer to a confirmation question
// that stage.mjs issued (advance, skip, or accepting failed checks), so `advance` / `skip` can tell a real answer from Claude's say-so.
// Only the exact pending question counts, and only its fixed options are stored. Every other question is
// ignored. Fails open with a visible message. Node 18+, no dependencies.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIRM_OPTIONS, approvalsPath, findRoot, out, readSession, readStdinJson } from './lib.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

try {
  const input = await readStdinJson();
  if (input.tool_name && input.tool_name !== 'AskUserQuestion') process.exit(0);
  const root = findRoot(input.cwd);
  if (!root || !input.session_id) process.exit(0);

  const state = readSession(root, input.session_id);
  const pending = state && isObj(state.pending_confirm) ? state.pending_confirm : null;
  if (!pending || typeof pending.question !== 'string' || !CONFIRM_OPTIONS[pending.kind]) process.exit(0);

  const ti = isObj(input.tool_input) ? input.tool_input : {};
  const tr = isObj(input.tool_response) ? input.tool_response : {};

  // Was our question one of those asked? (Other questions are not ours.)
  const asked = [ti.questions, tr.questions]
    .filter(Array.isArray)
    .flat()
    .map((q) => (isObj(q) ? q.question : null));
  if (asked.length && !asked.includes(pending.question)) process.exit(0);
  if (!asked.length && !(isObj(tr.answers) && pending.question in tr.answers) && !(isObj(ti.answers) && pending.question in ti.answers)) process.exit(0);

  // tool_response.answers first, tool_input.answers as the fallback: both map question text -> chosen label.
  const answers = isObj(tr.answers) ? tr.answers : isObj(ti.answers) ? ti.answers : null;
  if (!answers) {
    out({ systemMessage: "Shipline couldn't read your answer; the stage can't be confirmed in this session." });
    process.exit(0);
  }

  const answer = answers[pending.question];
  const o = CONFIRM_OPTIONS[pending.kind];
  if (answer !== o.yes && answer !== o.no) process.exit(0); // free text or no answer: nothing to record

  const record = {
    task_dir: pending.task_dir || state.task_dir || null,
    stage: pending.stage,
    kind: pending.kind,
    question: pending.question,
    answer,
    at: new Date().toISOString(),
    tool_use_id: typeof input.tool_use_id === 'string' ? input.tool_use_id : null,
  };
  try {
    const file = approvalsPath(root, input.session_id);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (e) {
    out({ systemMessage: `Shipline couldn't record your answer (${e.message}); the stage can't be confirmed in this session.` });
  }
  process.exit(0);
} catch (e) {
  out({ systemMessage: `Shipline couldn't record your answer (${e && e.message ? e.message : e}); the stage can't be confirmed in this session.` });
  process.exit(0);
}
