// PreToolUse hook: enforces per-stage block patterns for the active task.
// No active task => does nothing, except one warning per session when the current git branch belongs
// to an unfinished task this session isn't tracking. Malformed config => fails open with a visible warning.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  findRoot, loadConfig, loadWorkflow, readSession, readManifest, readStdinJson, stateDir,
  stageEnforcement, isDone, globToRegExp, listOpenTasks, currentBranch, safeId, out, failOpen,
} from './lib.mjs';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function anchored(src) {
  return new RegExp(`^(?:${src})$`);
}

// A session with no task: warn once if the branch belongs to an unfinished task. Never denies, and
// any error here ends the hook quietly (exit 0).
function warnIfLostTask(root, sessionId) {
  try {
    const marker = path.join(stateDir(root), `${safeId(sessionId)}.lost-warned`);
    if (existsSync(marker)) return;
    const branch = currentBranch(root);
    if (!branch) return;
    const task = listOpenTasks(root).find((t) => t.branch === branch);
    if (!task) return;
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    out({
      systemMessage:
        `Shipline: branch ${branch} belongs to unfinished task ${task.dir}, but this session isn't tracking it, ` +
        `so its stage rules are not enforced. Run: node .shipline/bin/stage.mjs resume ${task.dir}`,
    });
  } catch {
    // Swallow: the lost-task warning must never block a call.
  }
}

try {
  const input = await readStdinJson();
  const root = findRoot(input.cwd);
  const session = root && readSession(root, input.session_id);
  if (!session || !session.task_dir) {
    if (root && input.session_id) warnIfLostTask(root, input.session_id);
    process.exit(0);
  }

  const manifest = readManifest(root, session.task_dir);
  if (!manifest) process.exit(0);
  loadConfig(root); // a broken config surfaces as the visible fail-open warning
  const wf = loadWorkflow(root, session.workflow);

  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const isFileTool = FILE_TOOLS.has(tool);
  let rel = null;
  if (isFileTool) {
    const p = ti.file_path || ti.notebook_path;
    if (typeof p === 'string' && p) {
      rel = path.relative(root, path.resolve(input.cwd || root, p)).split(path.sep).join('/');
    }
    // Files outside the repo are not ours to gate; task artifacts live in the store, outside the repo.
    if (rel === null || rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);
  }
  const command = tool === 'Bash' && typeof ti.command === 'string' ? ti.command : null;
  if (!isFileTool && command === null) process.exit(0);

  const vars = (s) => String(s).replaceAll('{task_dir}', session.task_dir);
  const denies = [];
  const warns = [];

  for (const stage of wf.stages) {
    const mode = stageEnforcement(stage);
    if (mode === 'guide' || !Array.isArray(stage.blocks)) continue;
    const ms = manifest.stages.find((s) => s.id === stage.id);
    if (!ms || isDone(ms.status)) continue;

    for (const b of stage.blocks) {
      if (!b) continue;
      let hit = false;
      if (isFileTool && b.tools && anchored(b.tools).test(tool)) {
        // {artifact_root} no longer exists (tasks live outside the repo), so old workflows' entries never match.
        const allow = (Array.isArray(b.allow_paths) ? b.allow_paths : [])
          .filter((g) => !String(g).includes('{artifact_root}'))
          .map((g) => globToRegExp(vars(g)));
        hit = !allow.some((re) => re.test(rel));
      } else if (command !== null && b.bash) {
        hit = new RegExp(b.bash).test(command);
      }
      if (!hit) continue;
      const what = isFileTool ? `${tool} on ${rel}` : `"${command.slice(0, 80)}"`;
      const msg =
        `Shipline (${wf.name || wf.id} workflow, task ${manifest.task.slug}): ${what} needs the "${stage.name || stage.id}" stage to be done first. ` +
        `Finish it, then record it with: node .shipline/bin/stage.mjs advance`;
      (mode === 'block' ? denies : warns).push(msg);
      break;
    }
  }

  if (denies.length) {
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denies[0] + ' Do not work around this; tell the developer what is missing.',
      },
    });
  } else if (warns.length) {
    out({
      systemMessage: `Shipline reminder: ${warns[0]}`,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Reminder: ${warns[0]}` },
    });
  }
  process.exit(0);
} catch (e) {
  failOpen(e);
}
