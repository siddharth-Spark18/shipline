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
};

// The single source of the exact AskUserQuestion text. kind is 'advance', 'skip' or 'accept'.
// For 'accept', extra is { names: [failed command names], fingerprint, ran_at } of the check run in question.
export function confirmQuestion(stage, kind, slug, extra = {}) {
  const o = CONFIRM_OPTIONS[kind];
  if (!o) throw new Error(`unknown confirmation kind "${kind}"`);
  let question;
  if (kind === 'advance') question = `Advance past "${stage}" in task ${slug}?`;
  else if (kind === 'skip') question = `Skip "${stage}" in task ${slug}?`;
  else {
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
