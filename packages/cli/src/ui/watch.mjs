// File watching for the Tasks panel. Ported from the v1 hub (removed) (watchWorktree),
// changed to report errors and to fall back to polling. Node 20+, no dependencies.
import { existsSync, mkdirSync, readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../store.mjs';
import { git } from './git.mjs';
import { log } from './log.mjs';
import { collectTasks, tasksBase } from './tasks.mjs';

const DEBOUNCE_MS = 300;
const POLL_MS = 2000;
const STATUS_EVERY_MS = 10_000;
// .shipline/.state is ignored (interface-2 repos still write there) so old UI log and lock writes don't trigger it.
const IGNORED =
  /(^|[\\/])(\.git|node_modules|dist)([\\/]|$)|(^|[\\/])\.shipline[\\/]\.state([\\/]|$)/;
const CONFIG_EVENT = /^\.shipline[\\/]config\.yml$/;

function mtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// A string that changes when a task folder, a manifest, a task file, the git index/HEAD or config.yml does.
function pollSignature(root, taskBases, gitDir) {
  const parts = [];
  for (const base of taskBases) {
    try {
      for (const d of readdirSync(base, { withFileTypes: true })) {
        parts.push(`${base}:${d.name}`);
        if (!d.isDirectory()) continue;
        try {
          for (const f of readdirSync(path.join(base, d.name), { withFileTypes: true })) {
            const st = statSync(path.join(base, d.name, f.name));
            parts.push(`${d.name}/${f.name}:${st.size}:${st.mtimeMs}`);
          }
        } catch {
          // A folder that vanished mid-scan shows up in the next poll.
        }
      }
    } catch {
      // The tasks folder doesn't exist yet.
    }
  }
  if (gitDir)
    parts.push(
      `index:${mtime(path.join(gitDir, 'index'))}`,
      `HEAD:${mtime(path.join(gitDir, 'HEAD'))}`,
    );
  const config = mtime(path.join(root, '.shipline', 'config.yml'));
  parts.push(`config:${config}`);
  return { text: parts.join('\n'), config };
}

// Watches the repo root recursively and the git directory (not `index`/`HEAD` as single files: git replaces
// those, and a watch on a single file stops firing). onChange({ configChanged }) runs 300 ms after the last
// event. On a startup throw or any later 'error' event (ENOSPC on Linux) it switches to polling and calls
// opts.onFallback(reason). Returns { mode, close }; `mode` is 'watch' or 'poll'.
// opts.taskBases(): the absolute task folders to watch (the store's tasks/, plus the old artifact_root for an
// interface-2 repo), read on every poll. The store folders live outside the repo, so they are watched separately.
export async function watchRepo(root, onChange, opts = {}) {
  const handle = { mode: 'watch', close: () => {} };
  const watchers = [];
  let timer = null;
  let pollTimer = null;
  let closed = false;
  let configChanged = false;

  const fire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const info = { configChanged };
      configChanged = false;
      onChange(info);
    }, DEBOUNCE_MS);
  };

  const bases = () => (opts.taskBases ? opts.taskBases() : []);

  let gitDir = null;
  try {
    gitDir = path.resolve(root, await git(root, ['rev-parse', '--git-dir']));
  } catch {
    // Not a git repo: file watching still works.
  }

  const stopWatchers = () => {
    for (const w of watchers.splice(0)) w.close();
  };

  const startPolling = (reason) => {
    if (closed || handle.mode === 'poll') return;
    stopWatchers();
    handle.mode = 'poll';
    log('watch-fallback', { reason });
    if (opts.onFallback) opts.onFallback(reason);
    let last = pollSignature(root, bases(), gitDir);
    let lastStatus = Date.now();
    pollTimer = setInterval(() => {
      const sig = pollSignature(root, bases(), gitDir);
      const now = Date.now();
      let changed = false;
      if (sig.config !== last.config) configChanged = changed = true;
      if (sig.text !== last.text) changed = true;
      if (now - lastStatus >= STATUS_EVERY_MS) {
        lastStatus = now;
        changed = true; // re-run `git status` to catch working-tree edits
      }
      last = sig;
      if (changed) fire();
    }, POLL_MS);
  };

  const add = (target, recursive, filter) => {
    const w = watch(target, { recursive }, (_event, name) => {
      if (!name) return;
      const n = String(name);
      if (!filter(n)) return;
      if (CONFIG_EVENT.test(n)) configChanged = true;
      fire();
    });
    w.on('error', (e) => startPolling(e && e.code ? e.code : String(e && e.message)));
    watchers.push(w);
  };

  try {
    add(root, true, (n) => !IGNORED.test(n));
    if (gitDir && existsSync(gitDir)) add(gitDir, false, (n) => n === 'HEAD' || n === 'index');
    for (const dir of bases()) {
      if (!path.relative(root, dir).startsWith('..')) continue; // inside the repo: the root watch covers it
      mkdirSync(dir, { recursive: true });
      add(dir, true, () => true);
    }
    mkdirSync(stateDir(root), { recursive: true });
    add(stateDir(root), false, () => true);
  } catch (e) {
    startPolling(e && e.code ? e.code : String(e && e.message));
  }

  handle.close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (pollTimer) clearInterval(pollTimer);
    stopWatchers();
  };
  return handle;
}

// Starts the watch for the Tasks panel on `app`. Every change recomputes the tasks once (single-flight: a
// change during a run schedules exactly one more run) and sends an SSE `tasks` event. A change to config.yml
// reloads the config; a changed artifact_root (interface-2 repos) restarts the watch.
export async function startTaskWatch(app) {
  let handle = null;
  let running = false;
  let again = false;
  let closed = false;
  let configChanged = false;

  // The store's tasks/ folder, plus the old in-repo artifact_root until the repo is upgraded.
  const taskBases = () => {
    const { cfg } = app.repo.getConfig();
    return [
      tasksBase(app.repo.root, cfg, false),
      ...(app.repo.needsUpgrade ? [tasksBase(app.repo.root, cfg, true)] : []),
    ];
  };

  const onFallback = (reason) => {
    app.addBanner({
      id: 'watch',
      kind: 'watch',
      text: `File watching failed (${reason}), so the Tasks panel now polls every 2 s.`,
    });
  };

  const start = async () => {
    handle = await watchRepo(
      app.repo.root,
      (info) => {
        if (info.configChanged) configChanged = true;
        refresh();
      },
      { onFallback, taskBases },
    );
  };

  async function refresh() {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (configChanged) {
          configChanged = false;
          const before = taskBases().join('\n');
          app.repo.reloadConfig();
          if (taskBases().join('\n') !== before) {
            handle.close();
            await start();
          }
        }
        app.hub.send('tasks', await collectTasks(app));
      } while (again && !closed);
    } catch (e) {
      log('refresh-error', { message: e.message });
    } finally {
      running = false;
    }
  }

  await start();
  return {
    mode: () => handle.mode,
    refresh,
    close() {
      closed = true;
      handle.close();
    },
  };
}

// Watches the store's state/ directory (non-recursive) and calls onBound() when <sessionId>.json appears or
// changes: the file `stage.mjs start` or `resume` writes. The directory is watched, not the file, because the
// file doesn't exist until then. Falls back to a 2 s poll on any watch error. Returns { close }.
export function watchState(root, sessionId, onBound) {
  const dir = stateDir(root);
  const name = `${sessionId}.json`;
  const file = path.join(dir, name);
  let closed = false;
  let watcher = null;
  let pollTimer = null;
  let timer = null;
  let lastSig = null;

  const sig = () => {
    try {
      const st = statSync(file);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  };
  const check = () => {
    if (closed) return;
    const s = sig();
    if (s !== null && s !== lastSig) {
      lastSig = s;
      try {
        onBound();
      } catch (e) {
        log('state-watch-error', { message: e && e.message });
      }
    }
  };
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, 50);
  };
  const startPolling = () => {
    if (closed || pollTimer) return;
    if (watcher) watcher.close();
    pollTimer = setInterval(check, POLL_MS);
  };

  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, { recursive: false }, (_event, changed) => {
      if (!changed || String(changed) === name) fire();
    });
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }
  fire(); // the file may already exist (a resumed chat)
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (watcher) watcher.close();
    },
  };
}
