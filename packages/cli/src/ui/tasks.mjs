// The Tasks panel's data: open tasks, working-tree changes and file access. Node 20+, no dependencies.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
// git's own name for "no file" in --no-index mode; it works on every platform (see git.mjs).
const GIT_NULL = '/dev/null';
import path from 'node:path';
import { findStage, fingerprint } from '../../templates/shipline/bin/lib.mjs';
import { tasksDir } from '../store.mjs';
import { HttpError } from './http.mjs';
import { fileDiff, gitOk, gitRun, looksBinary } from './git.mjs';
import { log } from './log.mjs';

const FILE_LIMIT = 1024 * 1024;

const FINGERPRINT_TTL_MS = 5000;
// The current code fingerprint per repo root, recomputed at most once per FINGERPRINT_TTL_MS (it runs git).
const fingerprints = new Map();

function currentFingerprint(root) {
  const hit = fingerprints.get(root);
  const t = Date.now();
  if (hit && t - hit.at < FINGERPRINT_TTL_MS) return hit.value;
  const value = fingerprint(root);
  fingerprints.set(root, { at: t, value });
  return value;
}

// manifest.checks -> { ran_at, stale, results } for the browser, or null before the first run. `stale` is true when
// the code changed since the run; `accepted` marks failed commands the developer chose to live with.
function checksView(root, manifest) {
  const ch = manifest.checks;
  if (!ch || typeof ch !== 'object' || !Array.isArray(ch.results)) return null;
  const acc = manifest.stages
    .map((s) => s.accepted)
    .find(
      (a) =>
        a && a.fingerprint === ch.fingerprint && a.ran_at === ch.ran_at && Array.isArray(a.names),
    );
  const names = acc ? acc.names : [];
  const stale =
    typeof ch.fingerprint === 'string' &&
    ch.fingerprint !== '' &&
    (() => {
      const now = currentFingerprint(root);
      return now !== null && now !== ch.fingerprint;
    })();
  return {
    ran_at: ch.ran_at ?? null,
    stale,
    results: ch.results.map((r) => ({
      name: r.name,
      command: r.command ?? '',
      exit: typeof r.exit === 'number' ? r.exit : null,
      duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : 0,
      tail: typeof r.tail === 'string' ? r.tail : '',
      accepted: r.exit !== 0 && names.includes(r.name),
    })),
  };
}

const isDone = (status) => status === 'done' || status === 'skipped';

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The folder task folders are read from: the store's tasks/ folder (every 1.x repo keeps its tasks there).
export function tasksBase(root) {
  return tasksDir(root);
}

// Every task folder under the tasks base whose manifest still has a stage that isn't done or skipped,
// with its manifest. `dir` is the absolute folder path (an opaque id for the browser). The UI's own copy of
// the scan, used for every repo whatever its interface.
export function readOpenTasks(root) {
  const open = [];
  const base = tasksBase(root);
  if (!existsSync(base)) return open;
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return open;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    const m = readManifest(dir);
    if (!m || !m.task || !Array.isArray(m.stages) || m.stages.every((s) => isDone(s.status)))
      continue;
    const cur = m.stages.find((s) => !isDone(s.status));
    open.push({
      dir,
      slug: d.name,
      workflow: m.task.workflow,
      branch: m.task.branch,
      done: m.stages.filter((s) => s.status === 'done').map((s) => s.id),
      next: cur ? cur.id : null,
      manifest: m,
    });
  }
  return open;
}

// Same shape as listOpenTasks in the vendored lib.mjs: { dir, slug, workflow, branch, done, next }.
export function listOpenTasks(root) {
  return readOpenTasks(root).map(({ manifest, ...task }) => task);
}

// One task folder in the store, finished or not: { dir, slug, workflow, branch, done, next, manifest }, or null when
// the folder is outside this repo's store, missing, or has no readable manifest (each with a log line only). `dir` is
// an absolute store path, as the chat state stores it.
export function readTask(root, dir) {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) return null;
  const inStore = resolveInsideStore(root, path.resolve(dir));
  if (!inStore) {
    log('task-outside-store', { dir });
    return null;
  }
  if (inStore.missing) {
    log('task-missing', { dir });
    return null;
  }
  const m = readManifest(inStore.real);
  if (!m || !m.task || !Array.isArray(m.stages)) {
    log('task-unreadable', { dir });
    return null;
  }
  const cur = m.stages.find((s) => !isDone(s.status));
  return {
    dir,
    slug: path.basename(inStore.real),
    workflow: m.task.workflow,
    branch: m.task.branch,
    done: m.stages.filter((s) => s.status === 'done').map((s) => s.id),
    next: cur ? cur.id : null,
    manifest: m,
  };
}

// `git status --porcelain=v1 -z --untracked-files=all` -> [{ path, oldPath?, index, worktree }].
export function parseStatusZ(out) {
  const tokens = out.split('\0');
  const changes = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const index = t[0];
    const worktree = t[1];
    const change = { path: t.slice(3), index, worktree };
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C')
      change.oldPath = tokens[++i];
    changes.push(change);
  }
  return changes;
}

export async function gitChanges(root) {
  try {
    const { stdout } = await gitRun(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    return parseStatusZ(stdout);
  } catch {
    return []; // not a git repo, or git failed
  }
}

// 'added' | 'modified' | 'deleted' | 'renamed' for one raw status entry. Untracked files count as added.
export function changeStatus({ index, worktree }) {
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') return 'renamed';
  if (index === 'A' || index === '?' || worktree === 'A') return 'added';
  return 'modified';
}

const countOf = (v) => (v === '-' ? null : Number(v));

// `git diff --numstat -M -z` output -> Map<path, { additions, deletions }> (null counts for binary files).
// A rename record is `adds\tdels\t\0old\0new\0`, a plain one `adds\tdels\tpath\0`. Keyed by the new path.
export function parseNumstatZ(out) {
  const tokens = out.split('\0');
  const map = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    const counts = { additions: countOf(m[1]), deletions: countOf(m[2]) };
    if (m[3] === '') {
      const to = tokens[i + 2];
      i += 2;
      if (to !== undefined) map.set(to, counts);
    } else map.set(m[3], counts);
  }
  return map;
}

// Line counts of one file against nothing: `git diff --numstat --no-index /dev/null <path>` (exit 1 = differs).
async function untrackedCounts(root, file) {
  try {
    const { stdout } = await gitRun(
      root,
      ['diff', '--numstat', '--no-index', '--', GIT_NULL, file],
      [0, 1],
    );
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(stdout);
    return m
      ? { additions: countOf(m[1]), deletions: countOf(m[2]) }
      : { additions: null, deletions: null };
  } catch {
    return { additions: null, deletions: null };
  }
}

// The GET /api/tasks `changes` list:
// [{ path, oldPath?, status, additions: number|null, deletions: number|null }].
export async function collectChanges(root) {
  const raw = await gitChanges(root);
  if (raw.length === 0) return [];
  const hasCommits = await gitOk(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  let tracked = new Map();
  if (hasCommits) {
    try {
      tracked = parseNumstatZ(
        (await gitRun(root, ['diff', '--numstat', '-M', '-z', 'HEAD'])).stdout,
      );
    } catch {
      // Counts stay null.
    }
  }
  const out = new Array(raw.length);
  const pending = [];
  raw.forEach((c, i) => {
    const entry = {
      path: c.path,
      ...(c.oldPath ? { oldPath: c.oldPath } : {}),
      status: changeStatus(c),
      additions: null,
      deletions: null,
    };
    out[i] = entry;
    const known = tracked.get(c.path);
    if (known) Object.assign(entry, known);
    else if (!hasCommits || (c.index === '?' && c.worktree === '?')) pending.push(i);
  });
  for (let n = 0; n < pending.length; n += 16) {
    await Promise.all(
      pending.slice(n, n + 16).map(async (i) => {
        // A deleted file has nothing to read; only files on disk are counted this way.
        if (out[i].status === 'deleted') return;
        Object.assign(out[i], await untrackedCounts(root, out[i].path));
      }),
    );
  }
  return out;
}

function taskFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = statSync(path.join(dir, d.name));
        return { name: d.name, size: st.size, mtime: Math.floor(st.mtimeMs) };
      });
  } catch {
    return [];
  }
}

// The GET /api/tasks body (also the SSE `tasks` event data).
export async function collectTasks(app) {
  const { root } = app.repo;
  const { cfg, error } = app.repo.getConfig();
  const changes = await collectChanges(root);
  if (!cfg) return { tasks: [], changes, configError: error };

  const taskView = makeTaskView(app);
  const tasks = readOpenTasks(root).map(taskView);
  return { tasks, changes };
}

// Task entries (from readOpenTasks or readTask) -> the Task shape the browser gets. Stage names come from the task's
// workflow file; a `jira` stage in the manifest finds the workflow's `ticket` stage and the other way round.
function makeTaskView(app) {
  const { root } = app.repo;
  const workflows = new Map();
  const workflowStages = (id) => {
    if (!workflows.has(id)) {
      let stages = [];
      try {
        stages = app.repo.lib.loadWorkflow(root, id).stages;
      } catch {
        // Missing or broken workflow file: stage ids are shown instead of names.
      }
      workflows.set(id, stages);
    }
    return workflows.get(id);
  };
  return (t) => {
    const stagesCfg = workflowStages(t.workflow);
    return {
      dir: t.dir,
      slug: t.slug,
      title: t.manifest.task.title ?? t.slug,
      workflow: t.workflow,
      branch: t.branch,
      stages: t.manifest.stages.map((s) => {
        const found = findStage(stagesCfg, s.id);
        const stage = {
          id: s.id,
          name: (found && found.name) || s.id,
          status: s.status,
          artifact: s.artifact ?? null,
        };
        if (s.reason) stage.reason = s.reason;
        return stage;
      }),
      files: taskFiles(t.dir),
      checks: checksView(root, t.manifest),
    };
  };
}

// The tasks a chat has worked on, in order: its task_dirs resolved to the GET /api/tasks Task shape, finished tasks
// included. A folder that is gone, unreadable or outside the store is left out.
export function chatTasks(app, taskDirs) {
  const view = makeTaskView(app);
  const out = [];
  for (const dir of taskDirs || []) {
    const t = readTask(app.repo.root, dir);
    if (t) out.push(view(t));
  }
  return out;
}

// ---------- file access (ported from the v1 hub (removed)) ----------

export class AssetError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Resolves a requested path (absolute or relative) to a real file inside the repo, or throws. Symlinks are
// resolved first, so a link pointing outside the repo is rejected too.
export function resolveInsideWorktree(worktree, requested) {
  const root = realpathSync(worktree);
  let real;
  try {
    real = realpathSync(path.resolve(root, requested));
  } catch {
    throw new AssetError(404, 'File not found');
  }
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AssetError(403, 'Files can only be read from inside the repo');
  }
  return real;
}

const notFound = () => new HttpError(404, 'not-found', 'File not found');
const badPath = () =>
  new HttpError(400, 'bad-path', 'That path is not inside this repo or its task store');

const outside = (rel) => rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);

// A file inside this repo's store tasks/ folder (realpath-checked), or null when the absolute path is
// somewhere else.
function resolveInsideStore(root, abs) {
  let base;
  let real;
  try {
    base = realpathSync(tasksDir(root));
  } catch {
    return null;
  }
  try {
    real = realpathSync(abs);
  } catch {
    // Not on disk: it can only be a store path if it lexically starts there.
    return outside(path.relative(base, path.resolve(abs))) ? null : { missing: true };
  }
  return outside(path.relative(base, real)) ? null : { real };
}

// Reads are limited to: files in a task folder in the store (absolute paths), files in an open task folder,
// and files listed in the current `git status`. Anything else is 404, or 400 for an absolute path that is
// outside both the repo and the store.
async function resolveRequested(app, requested) {
  if (!requested || requested.includes('\0')) throw notFound();
  const { root } = app.repo;

  if (path.isAbsolute(requested)) {
    const abs = path.resolve(requested);
    const inStore = resolveInsideStore(root, abs);
    if (inStore) {
      if (inStore.missing) throw notFound();
      return { rel: abs, change: undefined, real: inStore.real };
    }
    let realRoot;
    try {
      realRoot = realpathSync(root);
    } catch {
      throw badPath();
    }
    const lexical = path.relative(root, abs);
    const realRel = path.relative(realRoot, abs);
    if (outside(lexical) && outside(realRel)) throw badPath();
    requested = outside(lexical) ? realRel : lexical;
  }

  const rel = path.posix.normalize(requested.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel === '.')
    throw notFound();

  const changes = await gitChanges(root);
  const change = changes.find((c) => c.path === rel);
  if (!change) throw notFound();

  let real = null;
  if (existsSync(path.join(root, rel))) {
    try {
      real = resolveInsideWorktree(root, rel);
    } catch (e) {
      if (e instanceof AssetError) throw notFound();
      throw e;
    }
  } else {
    // Deleted path: no realpath, so check containment lexically.
    const lex = path.relative(root, path.resolve(root, rel));
    if (lex.startsWith('..') || path.isAbsolute(lex)) throw notFound();
  }
  return { rel, change, real };
}

export function routes(app) {
  return [
    { method: 'GET', path: '/api/tasks', handler: () => collectTasks(app) },
    {
      method: 'GET',
      path: '/api/file',
      async handler({ url }) {
        const mode = url.searchParams.get('mode') === 'diff' ? 'diff' : 'content';
        const { rel, change, real } = await resolveRequested(app, url.searchParams.get('path'));
        if (mode === 'diff') {
          if (!change) throw notFound(); // task files that aren't changed have no diff
          return { path: rel, ...(await fileDiff(app.repo.root, change, real)) };
        }
        if (!real || !statSync(real).isFile()) throw notFound();
        if (statSync(real).size > FILE_LIMIT)
          throw new HttpError(413, 'too-large', 'File is larger than 1 MB');
        const buf = readFileSync(real);
        if (looksBinary(buf)) return { path: rel, binary: true };
        return { path: rel, content: buf.toString('utf8') };
      },
    },
  ];
}
