// The machine-wide project registry: $SHIPLINE_HOME/projects.json lists every repo with Shipline, so one
// `shipline ui` server can serve them all and `upgrade --all` can find them. Registered by `init`, `ui` and
// `upgrade`, removed by `uninstall`; seeded once from the stores that already exist. Node 22+, no dependencies.
//
//   { "version": 1, "projects": [ { "id", "root", "group", "addedAt" } ] }
//
// `id` is the first 12 hex characters of sha256 of the repo's real root; `group` is the realpath of
// `git rev-parse --git-common-dir` (worktrees of one repo share it), or null outside git.
import crypto from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { shiplineHome } from './store.mjs';
import { gitCommonDir, probeRepo } from './ui/repo.mjs';

export const registryFile = () => path.join(shiplineHome(), 'projects.json');

// The real path of a repo root (the same folder the task store is named after), or the resolved path when it is gone.
export function realRootOf(root) {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

// The id of a repo: its real root, hashed. Used in the registry, in API paths and in URLs.
export function projectId(root) {
  const real = realRootOf(root);
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// The folder name of the main worktree: the common git dir's parent (`<repo>/.git`), or the dir itself for a bare repo.
export function groupNameOf(group) {
  if (!group) return null;
  const base = path.basename(group);
  return base === '.git' ? path.basename(path.dirname(group)) : base.replace(/\.git$/, '') || base;
}

const isEntry = (p) =>
  p && typeof p === 'object' && typeof p.id === 'string' && typeof p.root === 'string';

function readStores() {
  const dir = path.join(shiplineHome(), 'projects');
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, name, 'repo.json'), 'utf8'));
      // Most stores left behind are test temp folders: only a root that still has Shipline is listed.
      if (meta && typeof meta.root === 'string' && existsSync(path.join(meta.root, '.shipline', 'config.yml'))) {
        out.push({ root: meta.root, created: typeof meta.created === 'string' ? meta.created : null });
      }
    } catch {
      // Not a store.
    }
  }
  return out;
}

function entryFor(root, addedAt) {
  const real = realRootOf(root);
  return { id: projectId(real), root: real, group: gitCommonDir(real), addedAt: addedAt || new Date().toISOString() };
}

function writeProjects(projects) {
  const file = registryFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2) + '\n');
  renameSync(tmp, file);
}

// Reads the registry from disk. Returns { projects, problem }:
//   missing -> seeded from the existing stores (and written, so it happens once);
//   unparseable -> `problem` says so, the list is empty, and the file is left alone until the next registration
//   (which keeps a .bak of it).
export function readRegistry() {
  const file = registryFile();
  if (!existsSync(file)) {
    const projects = readStores()
      .map((s) => entryFor(s.root, s.created))
      .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
      .sort((a, b) => a.root.localeCompare(b.root));
    try {
      writeProjects(projects);
    } catch {
      // Read-only home: the list still works for this run.
    }
    return { projects, problem: null };
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) throw new Error('not a registry');
    return { projects: data.projects.filter(isEntry), problem: null };
  } catch (e) {
    return { projects: [], problem: `${file} could not be read (${e.message})` };
  }
}

export const listProjects = () => readRegistry().projects;

// The state of one registered repo from small files only (no context, no lib): 'ok', 'pre-1.0', 'repo-newer' or
// 'missing' (the folder or its .shipline/config.yml is gone). See probeRepo for the version and the card text.
export const probeStateOf = (root) => probeRepo(root).state;
export { probeRepo };

export function findProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

// Re-reads, changes and writes in one go, so two CLI runs merge by id instead of overwriting each other.
function update(change) {
  const { projects, problem } = readRegistry();
  const next = change(projects);
  if (problem) {
    try {
      copyFileSync(registryFile(), `${registryFile()}.bak`);
    } catch {
      // Nothing to keep.
    }
  }
  writeProjects(next);
  return next;
}

// Adds the repo (or refreshes its root and group), keeping `addedAt`. Throws when the registry can't be written;
// use registerQuietly in commands, where that is only a warning.
export function registerProject(root) {
  const fresh = entryFor(root);
  let entry = fresh;
  update((projects) => {
    const i = projects.findIndex((p) => p.id === fresh.id);
    if (i >= 0) entry = { ...fresh, addedAt: projects[i].addedAt || fresh.addedAt };
    const rest = projects.filter((p) => p.id !== fresh.id);
    return [...rest, entry].sort((a, b) => a.root.localeCompare(b.root));
  });
  return entry;
}

// Removes the repo by id or root. Returns whether it was listed. Never touches the store or any file in the repo.
export function unregisterProject(rootOrId) {
  const id = /^[0-9a-f]{12}$/.test(rootOrId) ? rootOrId : projectId(rootOrId);
  let found = false;
  update((projects) => {
    found = projects.some((p) => p.id === id);
    return projects.filter((p) => p.id !== id);
  });
  return found;
}

// A registry that can't be written is a warning, never a failed command.
export function registerQuietly(root, warn = (m) => console.warn(m)) {
  try {
    return registerProject(root);
  } catch (e) {
    warn(`shipline: could not record this repo in the project list (${e.message}).`);
    return null;
  }
}

export function unregisterQuietly(root, warn = (m) => console.warn(m)) {
  try {
    return unregisterProject(root);
  } catch (e) {
    warn(`shipline: could not remove this repo from the project list (${e.message}).`);
    return false;
  }
}
