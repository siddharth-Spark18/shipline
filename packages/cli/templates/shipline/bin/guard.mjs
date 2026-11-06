// PreToolUse hook: enforces per-stage block patterns for the active task.
// First, for every session (with or without a task): denies edits to the store's progress and approval files
// and Bash commands that reach them, run record-answer.mjs, or pass --confirmed/--force to stage.mjs.
// Next, also for every session: the guardrails. Rails (force-push or push to the default branch, curl | sh, printing
// or reading credentials, deploys, migrations, edits to agent config) and protected_paths, from config.yml. A rail
// set to `deny` stops the call; `ask` (and protected paths) shows Claude Code's own permission prompt.
// Then, with an active task: stage block patterns (regexes, tool/path blocks and named actions). No active task =>
// nothing more, except one warning per session when the current git branch belongs to an unfinished task this
// session isn't tracking. The strictest decision wins: deny over ask over a stage warning.
// Malformed config => fails open with a visible warning.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRoot, loadConfig, loadWorkflow, readSession, readManifest, readStdinJson, stateDir, storeDir, shiplineHome,
  isInside, stageEnforcement, findStage, isDone, globToRegExp, listOpenTasks, currentBranch, safeId, out, failOpen,
  parseCommand, makeMatchCtx, matchAction, matchRail, bashWriteTargets, isCredentialPath, resolveTarget, repoRelative,
  globMatches, railReason, RAIL_IDS, ACTIONS,
} from './lib.mjs';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const STORE_DENY =
  'Shipline: progress and approvals can only change through `stage.mjs` and your answers to its questions.';

const deny = (reason) =>
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// The real path of p, resolving symlinks in the part that exists (the file itself may not exist yet).
function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail.reverse());
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = up;
    }
  }
}

// True when a file tool's path is one of the store's progress files: state/, approvals/ or tasks/<slug>/manifest.json.
function isProtectedStorePath(store, file) {
  const bases = [path.resolve(store), realish(store)];
  const files = [path.resolve(file), realish(file)];
  for (const base of bases) {
    for (const f of files) {
      if (!isInside(base, f)) continue;
      const seg = path.relative(base, f).split(/[\\/]/).map((x) => x.toLowerCase());
      if (seg[0] === 'state' || seg[0] === 'approvals') return true;
      if (seg[0] === 'tasks' && seg.length === 3 && seg[2] === 'manifest.json') return true;
    }
  }
  return false;
}

// Does this Bash command text reach the store's progress files, run the recorder, or pass the removed flags?
function bashReachesProgress(command, store) {
  if (/record-answer\.mjs/.test(command)) return true;
  if (/stage\.mjs[^;&|\n]*--(?:confirmed|force)\b/.test(command)) return true;
  const flat = command.replace(/\\/g, '/');
  const storeFwd = store.replace(/\\/g, '/');
  const mentionsStore = [command, flat].some(
    (c) =>
      c.includes(store) ||
      c.includes(storeFwd) ||
      c.includes(shiplineHome().replace(/\\/g, '/')) ||
      c.includes('~/.shipline') ||
      c.includes('$SHIPLINE_HOME') ||
      c.includes('${SHIPLINE_HOME}') ||
      c.includes('%SHIPLINE_HOME%'),
  );
  return mentionsStore && (/approvals/.test(command) || /manifest\.json/.test(command) || /\/state\//.test(flat));
}

const ask = (reason) =>
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });

// Paths the agent's own configuration lives in: .claude/**, .shipline/**, CLAUDE.md, .mcp.json (repo-relative).
const isAgentConfigPath = (rel) => /^(\.claude|\.shipline)(\/|$)/.test(rel) || rel === 'CLAUDE.md' || rel === '.mcp.json';

// The guardrails for one tool call: { deny, ask } (the first reason of each, or null). A rail set to `off` is skipped.
function railDecisions(input, root, cfg) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const ctx = makeMatchCtx(root, input.cwd || root, cfg);
  const denies = [];
  const asks = [];
  const raise = (id, what) => (cfg.rails[id] === 'deny' ? denies : asks).push(railReason(id, what, cfg.rails[id]));
  const on = (id) => cfg.rails[id] !== 'off';
  const protectedPath = (rel) => {
    if (isAgentConfigPath(rel)) {
      if (on('agent_config')) raise('agent_config', `${rel} is Claude Code or Shipline configuration`);
    } else if (cfg.protected_paths.some((g) => globMatches(g, rel) || globMatches(g, `${rel}/`))) {
      asks.push(`Shipline: ${rel} is protected in this repo (protected_paths in .shipline/config.yml)`);
    }
  };

  if (FILE_TOOLS.has(tool)) {
    const p = ti.file_path || ti.notebook_path;
    if (typeof p === 'string' && p) {
      const rel = repoRelative(root, resolveTarget(ctx, null, p));
      if (rel !== null) protectedPath(rel);
    }
  } else if (tool === 'Read') {
    const p = ti.file_path;
    if (on('read_credentials') && typeof p === 'string' && p && isCredentialPath(p, ctx, null)) raise('read_credentials', `${p} holds credentials`);
  } else if (tool === 'Bash' && typeof ti.command === 'string') {
    const parts = parseCommand(ti.command);
    for (const id of RAIL_IDS) {
      if (!on(id)) continue;
      for (const part of parts) {
        const what = matchRail(part, id, ctx);
        if (what) {
          raise(id, what);
          break;
        }
      }
    }
    for (const t of bashWriteTargets(parts, ctx)) if (!path.isAbsolute(t)) protectedPath(t);
  }
  return { deny: denies[0] || null, ask: asks[0] || null };
}

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

  // Protecting the store comes first: it applies whether or not this session has a task.
  if (root) {
    const tool0 = String(input.tool_name || '');
    const ti0 = input.tool_input || {};
    if (FILE_TOOLS.has(tool0)) {
      let p = ti0.file_path || ti0.notebook_path;
      if (typeof p === 'string' && p) {
        if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
        if (isProtectedStorePath(storeDir(root), path.resolve(input.cwd || root, p))) {
          deny(STORE_DENY);
          process.exit(0);
        }
      }
    } else if (tool0 === 'Bash' && typeof ti0.command === 'string' && bashReachesProgress(ti0.command, storeDir(root))) {
      deny(STORE_DENY);
      process.exit(0);
    }
  }

  // The guardrails come next, for every session and every stage: a deny ends the call here; an ask is kept and
  // shown once the stage blocks (which can still deny) have had their say. A broken config.yml is reported by the
  // task flow below, so it only turns the guardrails off here.
  let pendingAsk = null;
  if (root) {
    let cfg0 = null;
    try {
      cfg0 = loadConfig(root);
    } catch {
      cfg0 = null;
    }
    if (cfg0) {
      const d = railDecisions(input, root, cfg0);
      if (d.deny) {
        deny(d.deny);
        process.exit(0);
      }
      pendingAsk = d.ask;
    }
  }
  const finishAsk = () => {
    if (pendingAsk) ask(pendingAsk);
    process.exit(0);
  };

  const session = root && readSession(root, input.session_id);
  if (!session || !session.task_dir) {
    if (pendingAsk) finishAsk();
    if (root && input.session_id) warnIfLostTask(root, input.session_id);
    process.exit(0);
  }

  const manifest = readManifest(root, session.task_dir);
  if (!manifest) finishAsk();
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
    if (rel === null || rel.startsWith('..') || path.isAbsolute(rel)) finishAsk();
  }
  const command = tool === 'Bash' && typeof ti.command === 'string' ? ti.command : null;
  if (!isFileTool && command === null) finishAsk();

  const vars = (s) => String(s).replaceAll('{task_dir}', session.task_dir);
  const denies = [];
  const warns = [];
  const parts = command !== null ? parseCommand(command) : [];
  const actx = makeMatchCtx(root, input.cwd || root, loadConfig(root));

  for (const stage of wf.stages) {
    const mode = stageEnforcement(stage);
    if (mode === 'guide' || !Array.isArray(stage.blocks)) continue;
    const ms = findStage(manifest.stages, stage.id);
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
      } else if (command !== null && Array.isArray(b.actions)) {
        const named = b.actions.filter((a) => ACTIONS.includes(a));
        hit = parts.some((part) => named.some((a) => matchAction(part, a, actx)));
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
  } else if (pendingAsk) {
    ask(pendingAsk);
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
