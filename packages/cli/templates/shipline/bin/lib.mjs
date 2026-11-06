// Shared helpers for the Shipline hook and stage scripts. Node 18+, no dependencies.
// Vendored into .shipline/bin/ by `shipline init`; teams may edit it.
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// ---------- Node version check ----------
// The hooks need Node 18+. On an older Node a hook prints one warning (SessionStart) or exits quietly (the
// others), so Claude is never blocked. stage.mjs and ci-check.mjs are not hooks and are left alone.
const NODE_TOO_OLD_MESSAGE = "Shipline needs Node.js 18 or newer on this machine; its workflow hooks are off until it's installed.";
if (Number(process.versions.node.split('.')[0]) < 18) {
  const script = path.basename(String(process.argv[1] || ''));
  if (script === 'session-start.mjs') {
    process.stdout.write(JSON.stringify({ systemMessage: NODE_TOO_OLD_MESSAGE }));
    process.exit(0);
  }
  if (['guard.mjs', 'prompt-submit.mjs', 'record-answer.mjs'].includes(script)) process.exit(0);
}

// ---------- tiny YAML subset parser ----------
// Supported: nested maps (2-space or deeper indent), lists of scalars or maps ("- key: v"), inline
// lists [a, b], single/double quoted strings, # comments, true/false/null/numbers.
// Not supported: anchors, multi-line scalars, flow maps, lists at the same indent as their key.

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') i++;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s\[,:]/.test(line[i - 1]))) {
      q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitInline(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function scalar(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s[0] === '"' && s.endsWith('"') && s.length >= 2) return JSON.parse(s);
  if (s[0] === "'" && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '[' && s.endsWith(']')) return splitInline(s.slice(1, -1)).map(scalar);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

const KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((l, n) => {
    const body = stripComment(l).replace(/\s+$/, '');
    if (body.trim() === '') return;
    if (/\t/.test(body.match(/^\s*/)[0])) throw new Error(`line ${n + 1}: tabs are not allowed for indentation`);
    lines.push({ indent: body.match(/^ */)[0].length, text: body.trim(), n: n + 1 });
  });
  let i = 0;

  function block(indent) {
    if (i >= lines.length) return null;
    return lines[i].text.startsWith('- ') || lines[i].text === '-' ? list(indent) : map(indent);
  }

  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const ln = lines[i];
      const m = KEY_RE.exec(ln.text);
      if (!m) throw new Error(`line ${ln.n}: expected "key: value", got "${ln.text}"`);
      i++;
      if (m[2] !== undefined && m[2] !== '') {
        obj[m[1]] = scalar(m[2]);
      } else if (i < lines.length && lines[i].indent > indent) {
        obj[m[1]] = block(lines[i].indent);
      } else {
        obj[m[1]] = null;
      }
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new Error(`line ${lines[i].n}: unexpected indentation`);
    }
    return obj;
  }

  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const ln = lines[i];
      const rest = ln.text.slice(1).trimStart();
      if (rest !== '' && KEY_RE.test(rest)) {
        // "- key: value": re-read the remainder as a map entry at the item's inner indent.
        const inner = indent + (ln.text.length - rest.length);
        lines[i] = { indent: inner, text: rest, n: ln.n };
        arr.push(map(inner));
      } else {
        i++;
        arr.push(rest === '' ? null : scalar(rest));
      }
    }
    return arr;
  }

  if (lines.length === 0) return {};
  const result = block(lines[0].indent);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: unexpected content`);
  return result;
}

// ---------- repo and config ----------

export function findRoot(start) {
  let dir = path.resolve(process.env.CLAUDE_PROJECT_DIR || start || process.cwd());
  for (;;) {
    if (existsSync(path.join(dir, '.shipline', 'config.yml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const DEFAULT_CONFIG = {
  branch_pattern: '{type}/{key}-{slug}',
  tracker: 'jira',
  commands: {},
  skills: [],
};

// CI check settings (config.yml `ci:`); the section is optional and these apply when it is absent.
export const CI_MISSING_BLOCK = ['fail-unless-label', 'warn', 'fail'];
// stale_checks: what ci-check does when the checks in the summary ran on different code than the PR's.
export const CI_STALE_CHECKS = ['warn', 'fail'];
export const DEFAULT_CI = { missing_block: 'fail-unless-label', skip_label: 'shipline:skip', stale_checks: 'warn' };

// Guardrails (config.yml `rails`, `rails_commands`, `protected_paths`, `scope_check`). A rail is deny | ask | off.
export const RAIL_IDS = ['force_push_default', 'push_default', 'pipe_to_shell', 'print_credentials', 'read_credentials', 'deploy', 'migrate', 'agent_config'];
export const RAIL_LEVELS = ['deny', 'ask', 'off'];
export const RAIL_DEFAULTS = {
  force_push_default: 'deny',
  push_default: 'ask',
  pipe_to_shell: 'deny',
  print_credentials: 'deny',
  read_credentials: 'ask',
  deploy: 'ask',
  migrate: 'ask',
  agent_config: 'ask',
};
// The named actions a stage block can hold back (`blocks: [{ actions: [...] }]`).
export const ACTIONS = ['commit', 'push', 'pr', 'merge', 'release', 'deploy', 'migrate'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

export function readYamlFile(file) {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

export function loadConfig(root) {
  const cfg = { ...DEFAULT_CONFIG, ...(readYamlFile(path.join(root, '.shipline', 'config.yml')) || {}) };
  // skills: names of the repo's own .claude/skills/<name>; anything that is not a list of names is ignored.
  // tracker: 'jira' (the default) or 'github'; any other value is kept as written (the ticket stage is then skipped).
  if (cfg.tracker === null || cfg.tracker === undefined || cfg.tracker === '') cfg.tracker = 'jira';
  // setup: 'done' once /shipline-setup has run; absent otherwise.
  if (cfg.setup === null) cfg.setup = undefined;
  cfg.skills = Array.isArray(cfg.skills) ? cfg.skills.filter((n) => typeof n === 'string' && n) : [];
  // ci: unknown or malformed values fall back to the defaults.
  const ci = cfg.ci && typeof cfg.ci === 'object' && !Array.isArray(cfg.ci) ? cfg.ci : {};
  cfg.ci = {
    missing_block: CI_MISSING_BLOCK.includes(ci.missing_block) ? ci.missing_block : DEFAULT_CI.missing_block,
    skip_label: typeof ci.skip_label === 'string' && ci.skip_label.trim() ? ci.skip_label.trim() : DEFAULT_CI.skip_label,
    stale_checks: CI_STALE_CHECKS.includes(ci.stale_checks) ? ci.stale_checks : DEFAULT_CI.stale_checks,
  };
  // Guardrails: a missing or unknown rail or value uses its default (`setup-schema` warns about those).
  const rails = isObj(cfg.rails) ? cfg.rails : {};
  cfg.rails = Object.fromEntries(RAIL_IDS.map((id) => [id, RAIL_LEVELS.includes(rails[id]) ? rails[id] : RAIL_DEFAULTS[id]]));
  const rc = isObj(cfg.rails_commands) ? cfg.rails_commands : {};
  cfg.rails_commands = { deploy: strList(rc.deploy), migrate: strList(rc.migrate) };
  cfg.protected_paths = strList(cfg.protected_paths);
  const sc = isObj(cfg.scope_check) ? cfg.scope_check : {};
  cfg.scope_check = { enabled: sc.enabled !== false, sensitive_extra: strList(sc.sensitive_extra) };
  return cfg;
}

export function loadWorkflow(root, id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error(`bad workflow id "${id}"`);
  const wf = readYamlFile(path.join(root, '.shipline', 'workflows', `${id}.yml`));
  if (!wf || !Array.isArray(wf.stages) || wf.stages.length === 0) {
    throw new Error(`workflow "${id}" has no stages`);
  }
  for (const s of wf.stages) if (!s || !s.id) throw new Error(`workflow "${id}": every stage needs an id`);
  return { id, ...wf };
}

export function listWorkflows(root) {
  const dir = path.join(root, '.shipline', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => {
      try {
        return loadWorkflow(root, f.slice(0, -4));
      } catch {
        return null; // broken workflow files are skipped here; stage.mjs reports them
      }
    })
    .filter(Boolean);
}

// True when two stage ids name the same stage: equal, or the old `jira` id and the new `ticket` id (0.10.0 renamed
// the stage; open tasks and hand-edited workflows keep the old id, so every manifest/workflow comparison uses this).
export function sameStage(a, b) {
  return a === b || (a === 'jira' && b === 'ticket') || (a === 'ticket' && b === 'jira');
}

// The entry of `stages` for stage id `id`: an exact match first, then the jira/ticket alias (so a file that has
// both ids never mixes them up).
export function findStage(stages, id) {
  return stages.find((s) => s && s.id === id) || stages.find((s) => s && sameStage(s.id, id)) || null;
}

export function stageEnforcement(stage) {
  return ['guide', 'warn', 'block'].includes(stage.enforcement) ? stage.enforcement : 'guide';
}

// Whether a stage needs the developer's answer to advance. The one source of this rule for stage.mjs and
// ci-check.mjs (packages/ui/src/lib/confirmations.ts is a copy; keep them in step). `confirmations: light` asks
// only at stages marked `checkpoint: true`; anything other than 'light' is standard. The skip, accept and scope
// questions are not decided here: they ask in both modes.
export function needsAnswer(stageCfg, config) {
  if (!stageCfg || stageCfg.confirm_to_advance !== true) return false;
  const light = !!config && config.confirmations === 'light';
  return !light || stageCfg.checkpoint === true;
}

// ---------- task store (outside the repo) ----------
// $SHIPLINE_HOME (default ~/.shipline)/projects/<encoded repo path>/{repo.json, tasks/, state/, ui/}.

// Same encoding Claude Code uses for ~/.claude/projects: every non-alphanumeric character becomes "-".
export function encodePath(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

export function shiplineHome() {
  return process.env.SHIPLINE_HOME || path.join(os.homedir(), '.shipline');
}

// True when two repo roots are the same folder. On Windows paths are case-insensitive (and drive letters
// differ in case), so compare lowercased; elsewhere an exact match. `platform` is injectable for tests.
export function sameRoot(a, b, platform = process.platform) {
  if (platform === 'win32') return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
  return a === b;
}

// True when `child` is `parent` or inside it. Windows paths are compared case-insensitively. `platform` is
// injectable so the Windows rules can be tested on any OS.
export function isInside(parent, child, platform = process.platform) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const norm = (x) => (win ? String(x).toLowerCase() : String(x));
  const rel = p.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

// The line ending of a text: '\r\n' when its first line break is CRLF, otherwise '\n' (also when it has none).
export function detectEol(text) {
  const m = /\r?\n/.exec(String(text));
  return m && m[0] === '\r\n' ? '\r\n' : '\n';
}

// Rewrites every line break in `text` (CRLF or LF) as `eol`.
export function toEol(text, eol) {
  const lf = String(text).replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

function realRoot(root) {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

// Creates the store directory when needed and checks repo.json: a store whose repo.json names another root
// means two different paths encode the same way, so it throws instead of sharing the store.
export function storeDir(root) {
  const real = realRoot(root);
  const dir = path.join(shiplineHome(), 'projects', encodePath(real));
  const meta = path.join(dir, 'repo.json');
  try {
    mkdirSync(dir, { recursive: true });
    let existing = null;
    try {
      existing = JSON.parse(readFileSync(meta, 'utf8'));
    } catch {
      // Missing or unreadable repo.json: it is (re)written below.
    }
    if (existing && typeof existing.root === 'string') {
      if (!sameRoot(existing.root, real)) {
        throw Object.assign(
          new Error(`Shipline store collision at ${dir}: it belongs to ${existing.root}, but this repo is ${real}. Nothing was shared.`),
          { code: 'STORE_COLLISION' },
        );
      }
    } else {
      writeFileSync(meta, JSON.stringify({ root: real, created: new Date().toISOString() }, null, 2) + '\n');
    }
  } catch (e) {
    if (e.code === 'STORE_COLLISION') throw e;
    throw new Error(`Shipline can't write its task store at ${dir} (${e.message})`);
  }
  return dir;
}

export function tasksDir(root) {
  return path.join(storeDir(root), 'tasks');
}

export function stateDir(root) {
  return path.join(storeDir(root), 'state');
}

// ---------- state ----------

export function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

export function statePath(root, sessionId) {
  return path.join(stateDir(root), `${safeId(sessionId)}.json`);
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${file}: ${e.message}`);
  }
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file); // last write wins if two sessions touch one task
}

export function approvalsPath(root, sessionId) {
  return path.join(storeDir(root), 'approvals', `${safeId(sessionId)}.jsonl`);
}

export function readSession(root, sessionId) {
  return sessionId ? readJson(statePath(root, sessionId)) : null;
}

// ---------- confirmations (answers the developer gave to stage.mjs's questions) ----------

// The only answers the recorder stores, and the ones that count.
export const CONFIRM_OPTIONS = {
  advance: { yes: 'Advance', no: 'Not yet' },
  skip: { yes: 'Skip', no: "Don't skip" },
  accept: { yes: 'Finish anyway', no: 'Not yet' },
  scope: { yes: 'Finish anyway', no: 'Not yet' },
};

// The single source of the exact AskUserQuestion text. kind is 'advance', 'skip', 'accept' or 'scope'.
// For 'accept', extra is { names: [failed command names], fingerprint, ran_at } of the check run in question.
// For 'scope', extra is { sensitive: n, outside: m, fingerprint, ran_at } (counts of test/lint/CI files and files outside the plan).
export function confirmQuestion(stage, kind, slug, extra = {}) {
  const o = CONFIRM_OPTIONS[kind];
  if (!o) throw new Error(`unknown confirmation kind "${kind}"`);
  let question;
  if (kind === 'advance') question = `Advance past "${stage}" in task ${slug}?`;
  else if (kind === 'skip') question = `Skip "${stage}" in task ${slug}?`;
  else if (kind === 'scope') {
    const run = extra.fingerprint ? String(extra.fingerprint).slice(0, 8) : extra.ran_at || '';
    question = `Finish "${stage}" in task ${slug}? This change edits ${extra.sensitive || 0} test/lint/CI files and ${extra.outside || 0} files outside the plan (run ${run}).`;
  } else {
    const names = Array.isArray(extra.names) ? extra.names.join(', ') : '';
    const run = extra.fingerprint ? String(extra.fingerprint).slice(0, 8) : extra.ran_at || '';
    question = `Finish "${stage}" in task ${slug} with failed checks: ${names} (run ${run})?`;
  }
  return { header: 'Shipline', question, options: [o.yes, o.no] };
}

// Every recorded answer of a session, oldest first. Unreadable lines are skipped.
export function readApprovals(root, sessionId) {
  let text;
  try {
    text = readFileSync(approvalsPath(root, sessionId), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line);
      if (a && typeof a === 'object') out.push(a);
    } catch {
      // A damaged line never counts as an approval.
    }
  }
  return out;
}

// Marks the first unused approval for which match(approval) is true as used (the file is rewritten
// atomically) and returns it, or returns null when there is none.
export function consumeApproval(root, sessionId, match) {
  const file = approvalsPath(root, sessionId);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const lines = text.split(/\r?\n/);
  let used = null;
  for (let i = 0; i < lines.length && !used; i++) {
    if (!lines[i].trim()) continue;
    let a;
    try {
      a = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!a || typeof a !== 'object' || a.used_at || !match(a)) continue;
    a.used_at = new Date().toISOString();
    lines[i] = JSON.stringify(a);
    used = a;
  }
  if (!used) return null;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, file);
  return used;
}

// taskDir is an absolute store path (a repo-relative path still resolves, for state files not yet migrated).
export function manifestPath(root, taskDir) {
  return path.resolve(root, taskDir, 'manifest.json');
}

export function readManifest(root, taskDir) {
  return readJson(manifestPath(root, taskDir));
}

export function isDone(status) {
  return status === 'done' || status === 'skipped';
}

export function currentStage(manifest) {
  return manifest.stages.find((s) => !isDone(s.status)) || null;
}

// ---------- tasks and git ----------

// Every task folder in the store whose manifest still has a stage that isn't done or skipped.
export function listOpenTasks(root) {
  const open = [];
  const base = tasksDir(root);
  if (!existsSync(base)) return open;
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let m;
    try {
      m = readManifest(root, path.join(base, d.name));
    } catch {
      continue; // unreadable manifest: skip, stage.mjs status will report it
    }
    if (!m || !Array.isArray(m.stages) || m.stages.every((s) => isDone(s.status))) continue;
    const cur = currentStage(m);
    open.push({
      dir: path.join(base, d.name),
      slug: d.name,
      workflow: m.task.workflow,
      branch: m.task.branch,
      done: m.stages.filter((s) => s.status === 'done').map((s) => s.id),
      next: cur ? cur.id : null,
    });
  }
  return open;
}

// The current git branch, or '' when this isn't a git repo, has no commits yet, or git fails.
export function currentBranch(root) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// ---------- code fingerprint ----------

// The git tree id of the working tree (uncommitted and untracked files included, ignored files left out), computed
// with a temporary index so the real index is never touched. After a commit of exactly this code,
// `git rev-parse HEAD^{tree}` gives the same id. Returns null when this isn't a git repo or git fails.
export function fingerprint(root) {
  let dir = null;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'shipline-idx-'));
    const tmpIndex = path.join(dir, 'index');
    const opts = { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 };
    // Start from a copy of the real index: its stat cache lets `git add -A` rehash only the files that
    // changed, instead of every file in the repo. The real index itself is never written.
    try {
      const real = path.resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'index'], opts).toString().trim());
      if (existsSync(real)) copyFileSync(real, tmpIndex);
    } catch {
      // No real index (fresh repo): start empty; the result is the same tree.
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const run = (args) => execFileSync('git', args, { ...opts, env }).toString().trim();
    run(['add', '-A', '--', ':/']);
    const id = run(['write-tree']);
    return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp folder is harmless.
      }
    }
  }
}

// ---------- required sections ----------

const normHeading = (t) => String(t).trim().replace(/\s*:+\s*$/, '').trim().toLowerCase();

// Markdown headings outside fenced code blocks: [{ line, level, title }].
function headingsOf(lines) {
  const out = [];
  let fence = null;
  lines.forEach((l, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (m) out.push({ line: i, level: m[1].length, title: m[2] });
  });
  return out;
}

// The first heading that matches (case-insensitive, trailing ":" ignored) and the text under it, up to the next
// heading of the same or a higher level. -> { found, text }
export function findSection(markdown, heading) {
  const lines = String(markdown).split(/\r?\n/);
  const heads = headingsOf(lines);
  const want = normHeading(heading);
  const idx = heads.findIndex((h) => normHeading(h.title) === want);
  if (idx < 0) return { found: false, text: '' };
  const end = heads.slice(idx + 1).find((h) => h.level <= heads[idx].level);
  return { found: true, text: lines.slice(heads[idx].line + 1, end ? end.line : lines.length).join('\n').trim() };
}

export const MIN_SECTION_CHARS = 20;

// Problems with the required sections of an artifact: '<heading> (no heading)' or '<heading> (empty)', in order.
export function sectionProblems(markdown, sections) {
  const problems = [];
  for (const h of Array.isArray(sections) ? sections : []) {
    const sec = findSection(markdown, h);
    if (!sec.found) problems.push(`${h} (no heading)`);
    else if (sec.text.replace(/\s/g, '').length < MIN_SECTION_CHARS) problems.push(`${h} (empty)`);
  }
  return problems;
}

// ---------- guardrails: command parsing ----------
// parseCommand(text) turns a Bash command into simple commands the guard can match on, so `git -c x commit`,
// `cd sub && git commit` and `FOO=1 sudo git commit` are all seen as a commit. Best effort, never throws:
// variables are not expanded, and aliases, shell functions and `eval` are not followed.

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const baseName = (w) => path.posix.basename(String(w).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '');

// Splits text into { t: 'w', v } words, { t: 'sep', pipe } separators and { t: 'redir', v } redirections.
// Throws on an unterminated quote (parseCommand catches it).
function tokenize(text) {
  const toks = [];
  const heredocs = [];
  const n = text.length;
  let cur = '';
  let has = false;
  let i = 0;
  const flush = () => {
    if (has) toks.push({ t: 'w', v: cur });
    cur = '';
    has = false;
  };
  const dropFd = () => {
    if (has && /^\d+$/.test(cur)) {
      cur = '';
      has = false;
    } else flush();
  };
  const sep = (pipe = false) => {
    flush();
    toks.push({ t: 'sep', pipe });
  };
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) throw new Error('unterminated quote');
      cur += text.slice(i + 1, j);
      has = true;
      i = j + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= n) throw new Error('unterminated quote');
        const d = text[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(text[i + 1])) {
          if (text[i + 1] !== '\n') cur += text[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      has = true;
    } else if (c === '\\') {
      if (i + 1 < n && text[i + 1] !== '\n') {
        cur += text[i + 1];
        has = true;
      }
      i += 2;
    } else if (c === '#' && !has) {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
    } else if (c === '\n') {
      sep();
      i++;
      for (const delim of heredocs.splice(0)) {
        for (;;) {
          if (i >= n) break;
          const eol = text.indexOf('\n', i);
          const line = text.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if (line.trim() === delim) break;
        }
      }
    } else if (c === ';' || c === '(' || c === ')' || c === '`') {
      sep();
      i++;
    } else if (c === '&') {
      if (text[i + 1] === '>') {
        flush();
        i += text[i + 2] === '>' ? 3 : 2;
        toks.push({ t: 'redir', v: '>' });
      } else {
        sep();
        i += text[i + 1] === '&' ? 2 : 1;
      }
    } else if (c === '|') {
      const dbl = text[i + 1] === '|';
      sep(!dbl);
      i += dbl || text[i + 1] === '&' ? 2 : 1;
    } else if (c === '>') {
      dropFd();
      let op = '>';
      i++;
      if (text[i] === '>') {
        op = '>>';
        i++;
      } else if (text[i] === '|') i++;
      if (text[i] === '&') {
        i++; // `2>&1`: a descriptor copy, not a file
        while (i < n && /[0-9-]/.test(text[i])) i++;
        continue;
      }
      toks.push({ t: 'redir', v: op });
    } else if (c === '<') {
      dropFd();
      if (text[i + 1] === '<' && text[i + 2] === '<') {
        i += 3;
        toks.push({ t: 'redir', v: '<<<' });
      } else if (text[i + 1] === '<') {
        i += 2;
        if (text[i] === '-') i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        let delim = '';
        if (text[i] === "'" || text[i] === '"') {
          const q = text[i];
          const j = text.indexOf(q, i + 1);
          if (j < 0) throw new Error('unterminated quote');
          delim = text.slice(i + 1, j);
          i = j + 1;
        } else {
          while (i < n && !/[\s;&|<>()`]/.test(text[i])) delim += text[i++];
        }
        if (delim) heredocs.push(delim);
      } else if (text[i + 1] === '(') {
        i++; // process substitution: the `(` becomes a separator
      } else {
        i++;
        toks.push({ t: 'redir', v: '<' });
      }
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  flush();
  return toks;
}

// Looks through wrappers: reserved words, VAR=value, env, sudo, command, nohup, time, exec, nice, and sh -c '<text>'.
// -> { argv, inner } where inner is the text after `sh -c` (or null).
function unwrap(argv) {
  const a = argv.slice();
  let sawEnv = false;
  for (let guard = 0; guard < 30 && a.length; guard++) {
    const w = a[0];
    const b = baseName(w);
    if (RESERVED.has(w) || ASSIGN_RE.test(w)) {
      a.shift();
    } else if (b === 'env') {
      a.shift();
      sawEnv = true;
      while (a.length) {
        if (['-u', '-C', '-S', '--unset', '--chdir'].includes(a[0])) a.splice(0, 2);
        else if (a[0] === '--') {
          a.shift();
          break;
        } else if (a[0].startsWith('-') || ASSIGN_RE.test(a[0])) a.shift();
        else break;
      }
    } else if (b === 'sudo' || b === 'doas') {
      a.shift();
      while (a.length) {
        if (['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'].includes(a[0])) a.splice(0, 2);
        else if (a[0] === '--') {
          a.shift();
          break;
        } else if (a[0].startsWith('-')) a.shift();
        else break;
      }
    } else if (b === 'command' || b === 'builtin') {
      a.shift();
      if (a[0] === '-v' || a[0] === '-V') return { argv: [], inner: null }; // a lookup, not a run
      while (a.length && a[0].startsWith('-')) a.shift();
    } else if (b === 'nohup' || b === 'exec' || b === 'time' || b === 'setsid') {
      a.shift();
      while (a.length && a[0].startsWith('-')) a.shift();
    } else if (b === 'nice') {
      a.shift();
      if (a[0] === '-n') a.splice(0, 2);
      else if (a.length && a[0].startsWith('-')) a.shift();
    } else if (SHELLS.has(b)) {
      for (let k = 1; k < a.length; k++) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a[k])) return typeof a[k + 1] === 'string' ? { argv: a, inner: a[k + 1] } : { argv: a, inner: null };
        if (a[k] === '-o' || a[k] === '+o') k++;
        else if (!/^[-+]/.test(a[k])) break;
      }
      return { argv: a, inner: null };
    } else break;
  }
  if (!a.length && sawEnv) return { argv: ['env'], inner: null };
  return { argv: a, inner: null };
}

function normGit(part) {
  const a = part.argv;
  let i = 1;
  while (i < a.length) {
    const w = a[i];
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'].includes(w)) i += 2;
    else if (w.startsWith('-')) i += 1;
    else break;
  }
  part.sub = a[i] || '';
  part.args = a.slice(i + 1);
}

function composeCd(prev, x) {
  if (!prev || x.startsWith('/') || x === '~' || x.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(x)) return x;
  return path.posix.join(prev, x);
}

function makeParts(argv, redirects, pipedFrom, depth, cd) {
  const u = unwrap(argv);
  if (u.inner !== null && depth < 1) {
    const inner = parseInner(u.inner, depth + 1, cd);
    if (inner.length) {
      if (!inner[0].pipedFrom) inner[0].pipedFrom = pipedFrom;
      inner[inner.length - 1].redirects.push(...redirects);
      return inner;
    }
  }
  const a = u.argv;
  if (!a.length) return redirects.length ? [{ argv: [], tool: '', args: [], redirects, pipedFrom, cd }] : [];
  const part = { argv: a, tool: baseName(a[0]), args: a.slice(1), redirects, pipedFrom, cd };
  if (part.tool === 'git') normGit(part);
  return [part];
}

function parseInner(text, depth, cd0) {
  const toks = tokenize(text);
  const parts = [];
  let argv = [];
  let redirects = [];
  let pending = null;
  let piped = null;
  let cd = cd0;
  const finish = (pipe) => {
    const made = argv.length || redirects.length ? makeParts(argv, redirects, piped, depth, cd) : [];
    for (const p of made) {
      if (p.tool === 'cd' && p.args[0] && !p.args[0].startsWith('-')) cd = composeCd(cd, p.args[0]);
      parts.push(p);
    }
    piped = pipe && made.length ? made[made.length - 1] : null;
    argv = [];
    redirects = [];
    pending = null;
  };
  for (const tk of toks) {
    if (tk.t === 'sep') finish(tk.pipe);
    else if (tk.t === 'redir') pending = tk.v;
    else if (pending) {
      if (pending !== '<<<') redirects.push({ op: pending, target: tk.v });
      pending = null;
    } else argv.push(tk.v);
  }
  finish(false);
  return parts;
}

// -> an array of { argv, tool, args, sub? (git), redirects: [{ op: '>' | '>>' | '<', target }], pipedFrom, cd }.
// On text it can't read (an unterminated quote) it parses again with the quote characters removed and sets
// `fallback: true` on the array. It never throws.
export function parseCommand(text) {
  const s = String(text === undefined || text === null ? '' : text);
  try {
    return parseInner(s, 0, null);
  } catch {
    try {
      const parts = parseInner(s.replace(/['"]/g, ''), 0, null);
      parts.fallback = true;
      return parts;
    } catch {
      const parts = [];
      parts.fallback = true;
      return parts;
    }
  }
}

// ---------- guardrails: matching ----------

// Words that aren't options (and aren't the values of the options named in valueOpts).
function positionals(args, valueOpts = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valueOpts.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const homeOf = () => os.homedir();

function expandHome(t) {
  let x = String(t).replace(/^\$\{?HOME\}?(?=[\\/]|$)/, homeOf());
  if (x === '~' || x.startsWith('~/')) x = path.join(homeOf(), x.slice(1));
  return x;
}

// The absolute path of `target` as written in a command or tool call: against the `cd` in effect for the part,
// else the hook's cwd, else the repo root.
export function resolveTarget(ctx, part, target) {
  const cwd = ctx.cwd || ctx.root;
  const base = part && part.cd ? path.resolve(cwd, expandHome(part.cd)) : cwd;
  return path.resolve(base, expandHome(target));
}

// The path relative to the repo root with forward slashes, or null when it is outside the repo.
export function repoRelative(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Credential files: .env (not the .example/.sample/.template ones), keys, ssh/aws/gcloud/kube config, .npmrc, .pypirc.
export function isCredentialPath(file, ctx, part) {
  if (typeof file !== 'string' || !file) return false;
  const abs = resolveTarget(ctx, part || null, file).replace(/\\/g, '/');
  const name = path.posix.basename(abs);
  if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) return true;
  if (/\.(pem|key)$/.test(name) || /^id_(rsa|ed25519)/.test(name)) return !/\.pub$/.test(name);
  if (name === '.npmrc' || name === '.pypirc') return true;
  const home = homeOf().replace(/\\/g, '/').replace(/\/$/, '');
  const inHome = (sub) => abs === `${home}/${sub}` || abs.startsWith(`${home}/${sub}/`);
  return inHome('.ssh') || abs === `${home}/.aws/credentials` || inHome('.config/gcloud') || abs === `${home}/.kube/config`;
}

const globCache = new Map();
export function globMatches(glob, rel) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(String(glob));
    globCache.set(glob, re);
  }
  return re.test(rel);
}

// ---- default branch ----

const DEFAULT_BRANCH_TTL_MS = 10 * 60 * 1000;

function gitOut(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// The repo's default branch names: [name] when found (origin/HEAD, else main, else master), else ['main', 'master'].
// A found name is cached in <store>/state/default-branch.json for 10 minutes; a cache that can't be read or
// written is ignored and git is asked directly.
export function defaultBranches(root) {
  let file = null;
  try {
    file = path.join(stateDir(root), 'default-branch.json');
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c && typeof c.branch === 'string' && c.branch && Date.now() - Date.parse(c.checked_at) < DEFAULT_BRANCH_TTL_MS) return [c.branch];
  } catch {
    // No usable cache.
  }
  let branch = gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (!branch) {
    for (const b of ['main', 'master']) {
      if (gitOut(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) {
        branch = b;
        break;
      }
    }
  }
  if (!branch) return ['main', 'master'];
  if (file) {
    try {
      writeJson(file, { branch, checked_at: new Date().toISOString() });
    } catch {
      // Not cached; git is asked again next time.
    }
  }
  return [branch];
}

// The context the matchers share. Git is only asked (and package.json only read) when a command needs it.
export function makeMatchCtx(root, cwd, cfg) {
  let branches = null;
  let branch = null;
  const pkgs = new Map();
  const ctx = {
    root,
    cwd: cwd || root,
    cfg: cfg || {},
    defaultBranches() {
      if (!branches) branches = defaultBranches(root);
      return branches;
    },
    branch() {
      if (branch === null) branch = currentBranch(root);
      return branch;
    },
    // The body of package.json script `name`, from the nearest package.json at or above the part's folder.
    scriptBody(part, name) {
      let dir = resolveTarget(ctx, part, '.');
      if (repoRelative(root, dir) === null) dir = root;
      for (;;) {
        const file = path.join(dir, 'package.json');
        if (!pkgs.has(file)) {
          let scripts = null;
          if (existsSync(file)) {
            try {
              const j = JSON.parse(readFileSync(file, 'utf8'));
              scripts = isObj(j) && isObj(j.scripts) ? j.scripts : {};
            } catch {
              scripts = {};
            }
          }
          pkgs.set(file, scripts);
        }
        const scripts = pkgs.get(file);
        if (scripts) return typeof scripts[name] === 'string' ? scripts[name] : null;
        const up = path.dirname(dir);
        if (up === dir || dir === root) return null;
        dir = up;
      }
    },
  };
  return ctx;
}

// ---- tools behind other tools: npx prisma ..., pnpm exec, bundle exec rails ..., python -m alembic ... ----

function effective(p) {
  let tool = p.tool;
  let args = p.args;
  for (let k = 0; k < 3; k++) {
    if (tool === 'npx' || tool === 'bunx') {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-p' || args[i] === '--package' ? 2 : 1;
      if (i >= args.length) break;
      tool = baseName(args[i]);
      args = args.slice(i + 1);
    } else if ((tool === 'pnpm' || tool === 'yarn') && (args[0] === 'dlx' || (tool === 'pnpm' && args[0] === 'exec'))) {
      if (!args[1]) break;
      tool = baseName(args[1]);
      args = args.slice(2);
    } else if (tool === 'bundle' && args[0] === 'exec' && args[1]) {
      tool = baseName(args[1]);
      args = args.slice(2);
    } else if (/^python[\d.]*$/.test(tool) && args[0] === '-m' && args[1]) {
      tool = baseName(args[1]);
      args = args.slice(2);
    } else break;
  }
  return { tool, args };
}

const VALUE_OPTS = ['-n', '--namespace', '--context', '--kube-context', '--kubeconfig', '-s', '--server', '--cluster', '--user', '-C', '--region', '--profile', '--project', '-a', '--app', '-r', '--remote', '-path', '-database', '-source'];

function deployPattern(e) {
  const { tool, args } = e;
  const pos = positionals(args, VALUE_OPTS);
  switch (tool) {
    case 'kubectl':
      return ['apply', 'create', 'delete', 'rollout'].includes(pos[0]);
    case 'helm':
      return ['install', 'upgrade', 'uninstall'].includes(pos[0]);
    case 'terraform':
      return ['apply', 'destroy'].includes(pos[0]);
    case 'pulumi':
      return ['up', 'destroy'].includes(pos[0]);
    case 'vercel':
      return (args.includes('--prod') || args.includes('--production')) && (pos.length === 0 || pos[0] === 'deploy' || /[\\/.]/.test(pos[0]));
    case 'netlify':
      return pos[0] === 'deploy' && args.some((a) => a === '--prod' || a === '--prod-if-unlocked' || a === '-p');
    case 'fly':
    case 'flyctl':
    case 'serverless':
    case 'sls':
    case 'cdk':
      return pos[0] === 'deploy';
    case 'heroku':
      return /^releases:/.test(pos[0] || '') || pos[0] === 'container:release';
    case 'gcloud':
      return pos.includes('deploy');
    case 'aws':
      return pos.slice(0, 3).includes('deploy');
    default:
      return false;
  }
}

function migratePattern(e) {
  const { tool, args } = e;
  const pos = positionals(args, VALUE_OPTS);
  if (/^python[\d.]*$/.test(tool)) return args[0] !== undefined && baseName(args[0]) === 'manage.py' && args[1] === 'migrate';
  switch (tool) {
    case 'prisma':
      return (pos[0] === 'migrate' && ['deploy', 'reset'].includes(pos[1])) || (pos[0] === 'db' && pos[1] === 'push');
    case 'rails':
      return /^db:(migrate|rollback|drop)/.test(pos[0] || '');
    case 'rake':
      return /^db:/.test(pos[0] || '');
    case 'alembic':
      return ['upgrade', 'downgrade'].includes(pos[0]);
    case 'manage.py':
    case 'django-admin':
      return pos[0] === 'migrate';
    case 'knex':
      return /^migrate:/.test(pos[0] || '');
    case 'sequelize':
    case 'sequelize-cli':
      return /^db:migrate/.test(pos[0] || '');
    case 'typeorm':
      return ['migration:run', 'migration:revert'].includes(pos[0]);
    case 'drizzle-kit':
      return ['push', 'migrate'].includes(pos[0]);
    case 'flyway':
      return ['migrate', 'clean'].includes(pos[0]);
    case 'goose':
      return pos.slice(0, 3).some((x) => x === 'up' || x === 'down');
    case 'migrate':
      return pos.some((x) => x === 'up' || x === 'down');
    default:
      return false;
  }
}

function extraCommand(part, list) {
  return (list || []).some((prefix) => {
    const want = String(prefix).trim().split(/\s+/);
    return want.length > 0 && want.every((w, i) => part.argv[i] === w);
  });
}

// The package script a part runs (`npm run x`, `pnpm x`, `yarn x`, `bun run x`), or null.
function scriptNameOf(p) {
  const pos = positionals(p.args, ['--prefix', '-C', '--dir', '--filter', '-F', '--workspace', '--cwd']);
  const run = pos[0] === 'run' || pos[0] === 'run-script';
  if (p.tool === 'npm') return run ? pos[1] || null : null;
  if (p.tool === 'bun') return pos[0] === 'run' ? pos[1] || null : null;
  if (p.tool === 'pnpm' || p.tool === 'yarn') return (run ? pos[1] : pos[0]) || null;
  return null;
}

const SCRIPT_NAME = { deploy: /^(deploy|release)/i, release: /^(release|publish)/i, migrate: /^(migrate|db:)/i };

function directAction(p, action, ctx) {
  const git = p.tool === 'git';
  const pos = positionals(p.args, ['-R', '--repo']);
  switch (action) {
    case 'commit':
      if (!git) return false;
      if (p.sub === 'commit') return true;
      if (p.sub === 'merge') return p.args.includes('--commit');
      if (p.sub === 'cherry-pick' || p.sub === 'revert') {
        return !p.args.some((a) => a === '--no-commit' || a === '-n' || a === '--abort' || a === '--continue' || a === '--quit' || a === '--skip');
      }
      return false;
    case 'push':
      return git && p.sub === 'push';
    case 'pr':
      return (
        (p.tool === 'gh' && pos[0] === 'pr' && (pos[1] === 'create' || pos[1] === 'merge')) ||
        (p.tool === 'hub' && pos[0] === 'pull-request') ||
        (p.tool === 'glab' && pos[0] === 'mr' && pos[1] === 'create')
      );
    case 'merge':
      if (p.tool === 'gh') return pos[0] === 'pr' && pos[1] === 'merge';
      if (p.tool === 'glab') return pos[0] === 'mr' && pos[1] === 'merge';
      if (git && p.sub === 'merge') {
        if (p.args.some((a) => a === '--abort' || a === '--continue' || a === '--quit')) return false;
        return ctx.defaultBranches().includes(ctx.branch());
      }
      return false;
    case 'release': {
      if (p.tool === 'gh') return pos[0] === 'release' && pos[1] === 'create';
      if (p.tool === 'npm' || p.tool === 'pnpm') return pos[0] === 'publish';
      if (p.tool === 'yarn') return pos[0] === 'npm' && pos[1] === 'publish';
      if (p.tool === 'cargo') return pos[0] === 'publish';
      if (p.tool === 'twine') return pos[0] === 'upload';
      if (git && p.sub === 'tag') {
        if (p.args.some((a) => a === '-d' || a === '--delete' || a === '-l' || a === '--list')) return false;
        if (p.args.some((a) => /^-[a-zA-Z]*[asu][a-zA-Z]*$/.test(a))) return true;
        return positionals(p.args, ['-m', '-F', '-u', '--message', '--file', '--local-user']).some((n) => /^v?\d+(\.\d+)+/.test(n));
      }
      return false;
    }
    case 'deploy': {
      const e = effective(p);
      return deployPattern(e) || extraCommand(p, ctx.cfg.rails_commands && ctx.cfg.rails_commands.deploy);
    }
    case 'migrate': {
      const e = effective(p);
      return migratePattern(e) || extraCommand(p, ctx.cfg.rails_commands && ctx.cfg.rails_commands.migrate);
    }
    default:
      return false;
  }
}

// Does this simple command (from parseCommand) perform the named action? A package script counts when its name
// or its body (parsed once more, one level deep) does.
export function matchAction(part, action, ctx, depth = 0) {
  if (!part || !part.tool) return false;
  if (directAction(part, action, ctx)) return true;
  if (depth >= 1) return false;
  const name = scriptNameOf(part);
  if (!name) return false;
  if (SCRIPT_NAME[action] && SCRIPT_NAME[action].test(name)) return true;
  const body = ctx.scriptBody(part, name);
  return Boolean(body) && parseCommand(body).some((p) => matchAction(p, action, ctx, depth + 1));
}

// ---- rails ----

const brief = (p) => p.argv.slice(0, 5).join(' ').slice(0, 80);

// What a `git push` would do: { forced, deleting, targets: [branch names], all }, or null for any other command.
function pushInfo(p, ctx) {
  if (p.tool !== 'git' || p.sub !== 'push') return null;
  const pos = positionals(p.args, ['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
  let forced = p.args.some((a) => a === '--force' || a === '-f' || a === '--force-if-includes' || /^--force-with-lease(=|$)/.test(a) || (/^-[a-zA-Z]+$/.test(a) && a.includes('f')));
  let deleting = p.args.includes('--delete') || p.args.includes('-d');
  const refspecs = pos.slice(1);
  const targets = [];
  for (const spec of refspecs) {
    let s = spec;
    if (s.startsWith('+')) {
      forced = true;
      s = s.slice(1);
    }
    if (s.startsWith(':')) deleting = true;
    let dst = s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
    if (dst === 'HEAD') dst = ctx.branch();
    targets.push(dst.replace(/^refs\/heads\//, ''));
  }
  if (!refspecs.length && !p.args.includes('--tags')) {
    const b = ctx.branch();
    if (b) targets.push(b);
  }
  return { forced, deleting, targets, all: p.args.includes('--all') || p.args.includes('--mirror') };
}

const hitsDefault = (info, ctx) => info.all || info.targets.some((t) => ctx.defaultBranches().includes(t));

const READERS = {
  cat: [], less: [], more: [], bat: [], head: ['-n', '-c'], tail: ['-n', '-c'], xxd: ['-l', '-s', '-c', '-g', '-o'],
  base64: ['-w'], strings: ['-n'], grep: ['-A', '-B', '-C', '-m', '-e', '-f'], awk: ['-F', '-v', '-f'], sed: ['-e', '-f'],
};
const SECRET_VAR = /\$\{?(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|[A-Za-z0-9_]*_(?:TOKEN|SECRET|KEY|PASSWORD))\b/;
const INTERPRETER = /^(sh|bash|zsh|dash|python[\d.]*|node|perl|ruby)$/;

// Does this simple command trip rail `rail`? -> a short description of what it does, or null. Covers the rails
// that read a command's words; read_credentials and agent_config look at paths (isCredentialPath, bashWriteTargets).
export function matchRail(part, rail, ctx) {
  if (!part || !part.tool) return null;
  switch (rail) {
    case 'force_push_default':
    case 'push_default': {
      const info = pushInfo(part, ctx);
      if (info) {
        if (!hitsDefault(info, ctx)) return null;
        if (rail === 'force_push_default') {
          if (info.deleting) return `deleting the default branch with ${brief(part)}`;
          return info.forced ? `force-pushing to the default branch with ${brief(part)}` : null;
        }
        return `pushing to the default branch with ${brief(part)}`;
      }
      if (rail === 'force_push_default' && part.tool === 'git' && part.sub === 'branch') {
        const del = part.args.includes('-D') || ((part.args.includes('-d') || part.args.includes('--delete')) && (part.args.includes('-f') || part.args.includes('--force')));
        if (del && positionals(part.args).some((b) => ctx.defaultBranches().includes(b))) return `deleting the default branch with ${brief(part)}`;
      }
      return null;
    }
    case 'pipe_to_shell': {
      if (!INTERPRETER.test(part.tool)) return null;
      let from = part.pipedFrom;
      let net = false;
      while (from && !net) {
        net = from.tool === 'curl' || from.tool === 'wget';
        from = from.pipedFrom;
      }
      if (!net) return null;
      const pos = positionals(part.args);
      if (pos.length && !pos.every((x) => x === '-') && !part.args.includes('-s')) return null;
      return `piping a download into ${part.tool}`;
    }
    case 'print_credentials': {
      const t = part.tool;
      if (t === 'printenv' || (t === 'env' && part.argv.length === 1)) return 'printing the environment (it may hold secrets)';
      if ((t === 'echo' || t === 'printf') && part.args.some((a) => SECRET_VAR.test(a))) return `printing a secret variable with ${brief(part)}`;
      if (Object.prototype.hasOwnProperty.call(READERS, t)) {
        if (t === 'sed' && part.args.some((a) => a === '--in-place' || /^-[a-zA-Z]*i/.test(a))) return null;
        let files = positionals(part.args, READERS[t]);
        const scriptGiven = part.args.some((a) => a === '-e' || a === '-f' || a === '--regexp' || a === '--file');
        if ((t === 'grep' || t === 'awk' || t === 'sed') && !scriptGiven) files = files.slice(1);
        const reads = part.redirects.filter((r) => r.op === '<').map((r) => r.target);
        const hit = [...files, ...reads].find((f) => isCredentialPath(f, ctx, part));
        if (hit) return `reading ${hit} with ${t}`;
      }
      return null;
    }
    case 'deploy':
      return matchAction(part, 'deploy', ctx) ? `running a deploy command (${brief(part)})` : null;
    case 'migrate':
      return matchAction(part, 'migrate', ctx) ? `running a database migration (${brief(part)})` : null;
    default:
      return null;
  }
}

const RAIL_HOW = {
  force_push_default: 'Push a branch and open a PR instead, or ask the developer to run it themselves.',
  push_default: 'Push a branch and open a PR instead, unless the developer wants this push.',
  pipe_to_shell: 'Download the script, read it, then run it, or ask the developer to run it.',
  print_credentials: 'Never print credentials; ask the developer for what you need.',
  read_credentials: 'Only read credential files when the developer asked for it.',
  deploy: 'Deploys are the developer\'s call; check with them first.',
  migrate: 'Migrations change real data; check with the developer first.',
  agent_config: 'Changes to Claude Code and Shipline settings need the developer\'s approval.',
};

// The decision text for a rail: `Shipline rail <id>: <what>. <how>`.
export function railReason(id, what, level) {
  const change = `To change this rail: rails.${id} in .shipline/config.yml (or Setup, Guardrails).`;
  return level === 'deny'
    ? `Shipline rail ${id}: ${what}. ${RAIL_HOW[id]} Do not work around this. ${change}`
    : `Shipline rail ${id}: ${what}. ${RAIL_HOW[id]} ${change}`;
}

// The paths a parsed command writes: > and >> targets, tee arguments, sed -i files, and the arguments of mv, cp
// and rm. Each is repo-relative (forward slashes), or absolute when it is outside the repo.
export function bashWriteTargets(parts, ctx) {
  const out = [];
  const add = (part, t) => {
    if (typeof t !== 'string' || !t || t.startsWith('/dev/')) return;
    const abs = resolveTarget(ctx, part, t);
    const rel = repoRelative(ctx.root, abs);
    out.push(rel === null ? abs : rel);
  };
  for (const p of parts) {
    for (const r of p.redirects || []) if (r.op === '>' || r.op === '>>') add(p, r.target);
    const t = p.tool;
    if (t === 'tee') for (const f of positionals(p.args)) add(p, f);
    else if (t === 'sed' && p.args.some((a) => a === '--in-place' || /^-[a-zA-Z]*i/.test(a))) {
      const scriptGiven = p.args.some((a) => a === '-e' || a === '-f');
      const files = positionals(p.args, ['-e', '-f']);
      for (const f of scriptGiven ? files : files.slice(1)) add(p, f);
    } else if (t === 'mv' || t === 'rm') for (const f of positionals(p.args, ['-t', '--target-directory', '-S', '--suffix'])) add(p, f);
    else if (t === 'cp') {
      const ti = p.args.findIndex((a) => a === '-t' || a === '--target-directory');
      if (ti >= 0 && p.args[ti + 1]) add(p, p.args[ti + 1]);
      else {
        const files = positionals(p.args, ['-S', '--suffix']);
        if (files.length) add(p, files[files.length - 1]);
      }
    }
  }
  return out;
}

// ---------- scope check (Verify) ----------

const TEST_GLOBS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py'];
const LINT_GLOBS = [
  '**/.eslintrc*', '**/eslint.config.*', '**/.prettierrc*', '**/prettier.config.*', '**/.stylelintrc*', '**/ruff.toml', '**/.ruff.toml',
  '**/.flake8', '**/setup.cfg', '**/.golangci*', '**/.rubocop*', '**/biome.json*', '**/.editorconfig',
];
const CI_GLOBS = ['.github/workflows/**', '.gitlab-ci.yml', '.circleci/**', 'Jenkinsfile'];
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'bun.lockb', 'uv.lock']);

// 'test' | 'lint' | 'CI' | 'other' (a scope_check.sensitive_extra glob) | null when the file isn't sensitive.
export function sensitiveKind(file, cfg) {
  if (TEST_GLOBS.some((g) => globMatches(g, file))) return 'test';
  if (LINT_GLOBS.some((g) => globMatches(g, file))) return 'lint';
  if (CI_GLOBS.some((g) => globMatches(g, file))) return 'CI';
  const extra = cfg && cfg.scope_check ? cfg.scope_check.sensitive_extra : [];
  if (extra.some((g) => globMatches(g, file))) return 'other';
  return null;
}

// The paths a plan's "Files to touch" section lists: a backticked path, or a path at the start of a bullet
// (before " (", " —" or ":"). null when the plan has no such section or it lists nothing.
function plannedPaths(planText) {
  if (typeof planText !== 'string') return null;
  const sec = findSection(planText, 'Files to touch');
  if (!sec.found) return null;
  const found = new Set();
  const plausible = (x) => x && !/\s/.test(x) && /[/.*]/.test(x);
  for (const line of sec.text.split(/\r?\n/)) {
    for (const m of line.matchAll(/`([^`]+)`/g)) if (plausible(m[1].trim())) found.add(m[1].trim());
    const b = /^\s*(?:[-*+]|\d+\.)\s+(?!`)(.*)$/.exec(line);
    if (b) {
      const x = b[1].split(/ \(| —|:/)[0].trim().replace(/^\*\*|\*\*$/g, '');
      if (plausible(x)) found.add(x);
    }
  }
  return found.size ? [...found].map((x) => x.replace(/^\.\//, '')) : null;
}

const inPlan = (file, planned) =>
  planned.some((g) => (g.endsWith('/') ? file.startsWith(g) : /[*?]/.test(g) ? globMatches(g, file) : file === g || file.startsWith(`${g}/`)));

// What changed since the task started and what that touches: { changed, sensitive, outside_plan, note? }.
// changed is null when it can't be told (not git, no base commit, a task from before 0.13.0); outside_plan is null
// when it is unknown (no plan, or no "Files to touch" in it).
export function scopeOf(root, manifest, planText, cfg) {
  const base = manifest && manifest.task ? manifest.task.base_commit : undefined;
  if (base === undefined) return { changed: null, sensitive: [], outside_plan: null, note: 'unknown (task started before 0.13.0)' };
  if (!base) return { changed: null, sensitive: [], outside_plan: null, note: 'unknown (not a git repository, or it had no commits when the task started)' };
  const opts = { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 };
  let changed;
  try {
    const run = (args) => execFileSync('git', args, opts).toString().split('\0').filter(Boolean);
    changed = [...new Set([...run(['diff', '--name-only', '--no-renames', '--relative', '-z', base]), ...run(['ls-files', '--others', '--exclude-standard', '-z'])])].sort();
  } catch {
    return { changed: null, sensitive: [], outside_plan: null, note: 'unknown (git could not list the changes)' };
  }
  const sensitive = changed.filter((f) => sensitiveKind(f, cfg));
  const planned = plannedPaths(planText);
  const ignored = (f) => LOCKFILES.has(path.posix.basename(f)) || f.startsWith('.shipline/') || f.startsWith('.claude/');
  const outside_plan = planned ? changed.filter((f) => !ignored(f) && !inPlan(f, planned)) : null;
  return { changed, sensitive, outside_plan };
}

// "2 test files, 1 file outside the plan", or a note when there is nothing to report.
export function scopeText(scope, cfg) {
  if (!scope || scope.changed === null) return (scope && scope.note) || 'unknown';
  const kinds = {};
  for (const f of scope.sensitive) {
    const k = sensitiveKind(f, cfg) || 'other';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const label = { test: 'test', lint: 'lint config', CI: 'CI config', other: 'sensitive' };
  const bits = Object.entries(kinds).map(([k, n]) => `${n} ${label[k]} file${n === 1 ? '' : 's'}`);
  if (scope.outside_plan && scope.outside_plan.length) bits.push(`${scope.outside_plan.length} file${scope.outside_plan.length === 1 ? '' : 's'} outside the plan`);
  if (!bits.length) return scope.outside_plan === null ? 'no test, lint or CI files touched (the plan lists no files, so changes outside it are not checked)' : 'no test, lint or CI files touched, nothing outside the plan';
  return bits.join(', ');
}

// ---------- misc ----------

export function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'task'
  );
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// A broken Shipline config must never brick Claude: warn visibly and let everything through.
export function failOpen(err) {
  out({ systemMessage: `Shipline: ignoring a problem and continuing without enforcement. ${err && err.message ? err.message : err}` });
  process.exit(0);
}

export function describeStage(stage, manifest) {
  const st = manifest ? findStage(manifest.stages, stage.id) : null;
  return `${stage.id}${st ? ` (${st.status})` : ''}`;
}
