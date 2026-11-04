// SessionStart hook: injects a resume summary of unfinished tasks and exposes the session id to
// Bash (so stage.mjs knows which session it belongs to). Fails open with a visible warning.
import { appendFileSync } from 'node:fs';
import {
  findRoot, loadConfig, listOpenTasks, currentBranch, readSession, readStdinJson, safeId, out, failOpen,
} from './lib.mjs';

try {
  const input = await readStdinJson();
  const root = findRoot(input.cwd);
  if (!root) process.exit(0);
  const sid = input.session_id;

  if (sid && process.env.CLAUDE_ENV_FILE) {
    try {
      appendFileSync(process.env.CLAUDE_ENV_FILE, `export SHIPLINE_SESSION=${safeId(sid)}\n`);
    } catch {
      // Not fatal: stage.mjs also accepts --session.
    }
  }

  const cfg = loadConfig(root);
  const branch = currentBranch(root);
  const open = listOpenTasks(root, cfg).map((t) => ({ ...t, onBranch: !!branch && t.branch === branch }));

  const lines = [];
  lines.push(`Shipline is installed. Session id: ${safeId(sid)} (stage commands read $SHIPLINE_SESSION, or pass --session ${safeId(sid)}).`);
  const active = readSession(root, sid);
  if (active && active.task_dir) {
    lines.push(`This session is already working on task ${active.task_dir} (${active.workflow} workflow). Run: node .shipline/bin/stage.mjs status`);
  } else if (open.length) {
    lines.push('Unfinished Shipline tasks (offer to resume; if several, list them and ask which):');
    for (const t of open) {
      lines.push(
        `- ${t.slug} [${t.workflow}]: ${t.done.length ? `${t.done.join(', ')} done` : 'nothing done yet'}, next: ${t.next}${t.onBranch ? ' (matches the current git branch, likely this one)' : ''}`,
      );
    }
    lines.push('To resume: node .shipline/bin/stage.mjs resume <task folder>');
  }
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
  process.exit(0);
} catch (e) {
  failOpen(e);
}
