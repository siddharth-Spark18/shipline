// The Tasks panel's data: open tasks, working-tree changes and file access. Node 20+, no dependencies.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { fileDiff, gitRun, looksBinary } from './git.mjs';

const FILE_LIMIT = 1024 * 1024;

const isDone = (status) => status === 'done' || status === 'skipped';

function readManifest(root, dir) {
  try {
    return JSON.parse(readFileSync(path.join(root, dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Every task folder under cfg.artifact_root whose manifest still has a stage that isn't done or skipped,
// with its manifest. The UI's own copy of the scan, used for every repo whatever its interface.
export function readOpenTasks(root, cfg) {
  const open = [];
  const base = path.join(root, cfg.artifact_root);
  if (!existsSync(base)) return open;
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return open;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = `${cfg.artifact_root}/${d.name}`;
    const m = readManifest(root, dir);
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
export function listOpenTasks(root, cfg) {
  return readOpenTasks(root, cfg).map(({ manifest, ...task }) => task);
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

function taskFiles(root, dir) {
  try {
    return readdirSync(path.join(root, dir), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = statSync(path.join(root, dir, d.name));
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
  const changes = await gitChanges(root);
  if (!cfg) return { tasks: [], changes, configError: error };

  const workflows = new Map();
  const workflowStages = (id) => {
    if (!workflows.has(id)) {
      let names = new Map();
      try {
        names = new Map(app.repo.lib.loadWorkflow(root, id).stages.map((s) => [s.id, s.name]));
      } catch {
        // Missing or broken workflow file: stage ids are shown instead of names.
      }
      workflows.set(id, names);
    }
    return workflows.get(id);
  };

  const tasks = readOpenTasks(root, cfg).map((t) => {
    const names = workflowStages(t.workflow);
    return {
      dir: t.dir,
      slug: t.slug,
      title: t.manifest.task.title ?? t.slug,
      workflow: t.workflow,
      branch: t.branch,
      stages: t.manifest.stages.map((s) => {
        const stage = {
          id: s.id,
          name: names.get(s.id) || s.id,
          status: s.status,
          artifact: s.artifact ?? null,
        };
        if (s.reason) stage.reason = s.reason;
        return stage;
      }),
      files: taskFiles(root, t.dir),
    };
  });
  return { tasks, changes };
}

// ---------- file access (copied from apps/local/src/server/assets.ts) ----------

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

// Only a path inside an open task's folder, or listed in the current `git status`, can be read.
async function resolveRequested(app, requested) {
  if (!requested || requested.includes('\0')) throw notFound();
  const rel = path.posix.normalize(requested.replace(/\\/g, '/'));
  if (path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel === '.')
    throw notFound();

  const { root } = app.repo;
  const { cfg } = app.repo.getConfig();
  const changes = await gitChanges(root);
  const change = changes.find((c) => c.path === rel);
  const inTask = cfg ? readOpenTasks(root, cfg).some((t) => rel.startsWith(`${t.dir}/`)) : false;
  if (!change && !inTask) throw notFound();

  let real = null;
  if (existsSync(path.join(root, rel))) {
    try {
      real = resolveInsideWorktree(root, rel);
    } catch (e) {
      if (e instanceof AssetError) throw notFound();
      throw e;
    }
  } else if (!change) {
    throw notFound(); // a deleted file is only reachable through the status list
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
