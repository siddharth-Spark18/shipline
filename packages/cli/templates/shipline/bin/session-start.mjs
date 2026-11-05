// SessionStart hook: injects a resume summary of unfinished tasks and exposes the session id to
// Bash (so stage.mjs knows which session it belongs to). Fails open with a visible warning.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  findRoot, loadConfig, listOpenTasks, currentBranch, readSession, readStdinJson, safeId, stateDir, out, failOpen,
} from './lib.mjs';

// Until /shipline-setup has written `setup: done`, tell each developer once (a marker in the store) that the
// default rules are in use. Any error here means no message.
function setupNudge(root, cfg) {
  try {
    if (cfg.setup === 'done') return null;
    const marker = path.join(stateDir(root), 'setup-nudged');
    if (existsSync(marker)) return null;
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString() + '\n');
    return 'Shipline is using its default rules here. Run /shipline-setup to tailor them to this repo.';
  } catch {
    return null;
  }
}

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

  const cfg = loadConfig(root); // a broken config surfaces as the visible fail-open warning
  const branch = currentBranch(root);
  const open = listOpenTasks(root).map((t) => ({ ...t, onBranch: !!branch && t.branch === branch }));

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
  const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } };
  const nudge = setupNudge(root, cfg);
  if (nudge) result.systemMessage = nudge;
  out(result);
  process.exit(0);
} catch (e) {
  failOpen(e);
}
