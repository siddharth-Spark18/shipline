// UserPromptSubmit hook: asks Claude to classify a new request into a workflow (or to keep
// following the active one). Fails open with a visible warning.
import { findRoot, listWorkflows, readSession, readManifest, currentStage, readStdinJson, out, failOpen } from './lib.mjs';

try {
  const input = await readStdinJson();
  const root = findRoot(input.cwd);
  if (!root) process.exit(0);
  const prompt = String(input.prompt || '').trim();
  if (prompt.startsWith('/')) process.exit(0); // slash commands are not task requests

  const session = readSession(root, input.session_id);
  let ctx;
  if (session && session.task_dir) {
    const m = readManifest(root, session.task_dir);
    const cur = m && currentStage(m);
    ctx = m
      ? `Shipline: active task ${m.task.slug} (${session.workflow} workflow), ${cur ? `current stage "${cur.id}"` : 'all stages done'}. Keep following the shipline-workflow skill; if this message is a new, unrelated task, ask the developer before switching.`
      : null;
  } else {
    const wfs = listWorkflows(root).map((w) => `${w.id}${w.description ? ` (${w.description})` : ''}`);
    ctx =
      `Shipline: no workflow is active. If this request is a task (building, fixing or changing something), ` +
      `classify it (${wfs.join('; ') || 'no workflows found'}) and say which workflow you will follow, then use the shipline-workflow skill. ` +
      `For a Small change (a typo, a rename, a config or copy tweak, a one-file fix with an obvious cause) announce it and start right away, without waiting for an OK. ` +
      `For any other workflow, ask the developer once to confirm or switch. Quick questions and chatter do not start a workflow.`;
  }
  if (ctx) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } });
  process.exit(0);
} catch (e) {
  failOpen(e);
}
