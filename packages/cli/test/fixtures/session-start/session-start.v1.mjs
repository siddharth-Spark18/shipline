// SessionStart hook: injects a resume summary of unfinished tasks and exposes the session id to
// Bash (so stage.mjs knows which session it belongs to). Fails open with a visible warning.
import { readdirSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  findRoot, loadConfig, readManifest, readSession, currentStage, readStdinJson, safeId, out, failOpen,
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
  let branch = '';
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // Not a git repo or no commits yet.
  }

  const open = [];
  const base = path.join(root, cfg.artifact_root);
  if (existsSync(base)) {
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      let m;
      try {
        m = readManifest(root, `${cfg.artifact_root}/${d.name}`);
      } catch {
        continue; // unreadable manifest: skip, stage.mjs status will report it
      }
      if (!m || !Array.isArray(m.stages) || m.stages.every((s) => s.status === 'done' || s.status === 'skipped')) continue;
      const cur = currentStage(m);
      const done = m.stages.filter((s) => s.status === 'done').map((s) => s.id);
      open.push({
        dir: `${cfg.artifact_root}/${d.name}`,
        slug: d.name,
        workflow: m.task.workflow,
        done,
        next: cur ? cur.id : null,
        onBranch: !!branch && m.task.branch === branch,
      });
    }
  }

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
