// SessionStart hook: injects a resume summary of unfinished tasks and exposes the session id to
// Bash (so stage.mjs knows which session it belongs to). A session with no task that starts on the branch of exactly one
// open task is bound to it (so /clear, a new session or a second terminal keep enforcement). Tasks idle longer than
// stale_task_days are listed as a count. Fails open with a visible warning.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  findRoot, loadConfig, listOpenTasks, currentBranch, readSession, readStdinJson, safeId, stateDir, out, failOpen,
  loadWorkflow, bindSession, activeOtherOwner, ownerWarning, writeOwner,
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
  } else {
    // Detached HEAD (mid-rebase, a checked-out tag) or no git: no auto-bind. Tasks without a branch never match.
    const onBranch = open.filter((t) => t.onBranch && branch !== 'HEAD');
    let bound = null;
    if (sid && onBranch.length === 1) {
      const t = onBranch[0];
      try {
        const wf = loadWorkflow(root, t.workflow);
        const other = activeOtherOwner(t.dir, sid);
        bindSession(root, sid, t.dir, wf.id);
        writeOwner(t.dir, sid);
        bound = t;
        lines.push(`Shipline: continuing task ${t.slug} (${wf.id} workflow), current stage "${t.next}". Run: node .shipline/bin/stage.mjs status`);
        if (other) lines.push(ownerWarning(other));
      } catch {
        // The task can't be bound (broken workflow, unwritable store): it is listed below instead.
      }
    }
    if (!bound && open.length) {
      const days = cfg.stale_task_days;
      const age = (t) => (t.newest ? Math.max(0, Math.floor((Date.now() - t.newest) / 86400000)) : null);
      const shown = open.filter((t) => t.onBranch || age(t) === null || age(t) <= days);
      const hidden = open.length - shown.length;
      if (shown.length) {
        lines.push('Unfinished Shipline tasks (offer to resume; if several, list them and ask which):');
        for (const t of shown) {
          const a = age(t);
          lines.push(
            `- ${t.slug} [${t.workflow}]: ${t.done.length ? `${t.done.join(', ')} done` : 'nothing done yet'}, next: ${t.next}${a === null ? '' : ` (${a}d ago)`}${t.onBranch ? ' (matches the current git branch, likely this one)' : ''}`,
          );
        }
        lines.push('To resume: node .shipline/bin/stage.mjs resume <task folder>');
      }
      if (hidden) lines.push(`+${hidden} older tasks (idle over ${days} days): node .shipline/bin/stage.mjs status --all`);
    }
  }
  const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } };
  const nudge = setupNudge(root, cfg);
  if (nudge) result.systemMessage = nudge;
  out(result);
  process.exit(0);
} catch (e) {
  failOpen(e);
}
