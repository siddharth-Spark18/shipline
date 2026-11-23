// The projects one `shipline ui` server serves: a lazily created context per repo, the install contexts for folders
// that have no Shipline yet, and the server-wide routes that list them (/api/projects, /api/overview, the CLI
// handoff). Node 20+, no dependencies.
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { INTERFACE, semverGt } from '../interface.mjs';
import {
  findProject,
  groupNameOf,
  projectId,
  readRegistry,
  registerQuietly,
  unregisterProject,
} from '../registry.mjs';
import { mainRoot, storeDir, uiDir } from '../store.mjs';
import { routes as diagnosticsRoutes } from './diagnostics.mjs';
import { createChats } from './chat.mjs';
import { routes as chatRoutes } from './chat-routes.mjs';
import { HttpError } from './http.mjs';
import { installedRoutes, routes as installRoutes } from './install-routes.mjs';
import { createLogger, withLogger } from './log.mjs';
import { createPrompts, promptTimeoutFromEnv } from './prompts.mjs';
import {
  findRepoRoot,
  gitBranch,
  gitCommonDir,
  gitRootOf,
  installRootFor,
  loadRepoLib,
  probeRepo,
  resolveRepo,
} from './repo.mjs';
import { safeEqual } from './auth.mjs';
import { MIN_CLAUDE_VERSION, claudeHealth } from './claude.mjs';
import { redact } from './log.mjs';
import { listChats, liveLock } from './sessions.mjs';
import { routes as preferencesRoutes } from './preferences.mjs';
import { routes as setupRoutes } from './setup.mjs';
import { makeTaskView, readOpenTasks, readTask, routes as taskRoutes } from './tasks.mjs';
import { startTaskWatch } from './watch.mjs';

const CLAUDE_HEALTH_TTL_MS = 60_000;
const LOG_TAIL_LINES = 50;

const configFile = (root) => path.join(root, '.shipline', 'config.yml');

// app: the server (hub, port, auth, remote, uiVersion, serverKey, serverLogger). Returns the project manager.
export function createProjects(app) {
  const contexts = new Map(); // id -> ProjectContext ({ mode: 'repo' | 'install' })
  const creating = new Map(); // id -> Promise<ProjectContext>: concurrent first requests share one creation
  const configCache = new Map(); // config path -> { mtimeMs, setupDone }, for repos that aren't loaded
  // Repos this server was pointed at (start folder, handoff) that the registry could not record (an unwritable home):
  // they are still served and listed, for this run.
  const adopted = new Map(); // id -> root
  const promptTimeoutMs = promptTimeoutFromEnv(); // read at server start (contexts are created later)
  let scheduled = false;
  let stopped = false;

  // ---------- contexts ----------

  // What the per-repo modules get instead of the single `app`: the same shape (repo, hub, port, prompts, chats,
  // ...), with events tagged by repoId and a logger of its own.
  function baseContext(id, root) {
    const connectFns = [];
    const banners = new Map();
    const ctx = {
      id,
      root,
      mode: 'repo',
      install: null,
      repo: null,
      group: null,
      uiVersion: app.uiVersion,
      promptTimeoutMs,
      get port() {
        return app.port;
      },
      logger: app.serverLogger,
      log: (event, data) => ctx.logger.log(event, data),
      prompts: null,
      chats: null,
      watch: null,
      table: [],
      banners,
      connectFns,
      hub: {
        send: (type, data) => {
          app.hub.send(type, { ...data, repoId: id });
          // A task's stages changed: the flat chat list carries them.
          if (type === 'tasks') scheduleChange();
        },
        size: () => app.hub.size(),
        onConnect: (fn) => connectFns.push(fn),
      },
      addBanner(banner) {
        banners.set(banner.id, banner);
        ctx.hub.send('banner', banner);
      },
      // The `projects` event: registration, state, waiting or chatRunning changed.
      changed: () => scheduleChange(),
      // { count, items: [{ chatId, reason }], chatRunning }
      waitingInfo() {
        const items = [];
        const seen = new Set();
        const add = (list) => {
          for (const w of list) {
            if (seen.has(w.chatId)) continue;
            seen.add(w.chatId);
            items.push(w);
          }
        };
        if (ctx.prompts) add(ctx.prompts.waiting());
        if (ctx.chats) add(ctx.chats.unseenErrors());
        return {
          count: items.length,
          items,
          chatRunning: Boolean(ctx.chats && ctx.chats.activeId()),
        };
      },
      // After a successful install: the same context, now with the repo's full routes. Requests that arrive
      // meanwhile share the one switch; a failed switch can be tried again.
      switching: null,
      async switchToRepo() {
        if (ctx.mode === 'repo') return;
        ctx.switching ||= resolveRepo(ctx.install.root)
          .then((repo) => enterRepoMode(ctx, repo))
          .catch((e) => {
            ctx.switching = null;
            throw e;
          });
        await ctx.switching;
      },
    };
    return ctx;
  }

  // Builds what a repo needs (log, store, prompts, chats, watch) on `ctx` and its route table.
  async function enterRepoMode(ctx, repo) {
    storeDir(repo.root);
    ctx.logger = createLogger(path.join(uiDir(repo.root), 'ui.log'));
    ctx.repo = repo;
    ctx.root = repo.root;
    ctx.group = ctx.group || gitCommonDir(repo.root);
    await withLogger(ctx.logger, async () => {
      ctx.log('start', { root: repo.root, uiVersion: app.uiVersion, node: process.version });
      ctx.log('version', { repo: repo.version, ui: INTERFACE, state: repo.state });
      ctx.prompts = createPrompts(ctx);
      ctx.chats = createChats(ctx);
      try {
        ctx.watch = await startTaskWatch(ctx);
      } catch (e) {
        await ctx.chats.close();
        throw e;
      }
      ctx.table = [
        ...diagnosticsRoutes(ctx),
        ...ctx.prompts.routes(),
        ...chatRoutes(ctx),
        ...setupRoutes(ctx),
        ...taskRoutes(ctx),
        ...installedRoutes(),
      ];
    });
    ctx.mode = 'repo'; // last: until now the install routes answer
  }

  async function createRepoContext(id, root) {
    let repo;
    try {
      repo = await resolveRepo(root);
    } catch (e) {
      throw new HttpError(
        500,
        'repo-load-failed',
        `Could not load the repo's .shipline/bin/lib.mjs: ${e.message}`,
      );
    }
    const ctx = baseContext(id, repo.root);
    try {
      await enterRepoMode(ctx, repo);
    } catch (e) {
      app.serverLogger.log('context-error', { id, root, message: e && e.message });
      throw new HttpError(
        500,
        'repo-load-failed',
        e && e.message ? e.message : 'Could not open this repo',
      );
    }
    contexts.set(id, ctx);
    scheduleChange();
    return ctx;
  }

  // The context for a request to /api/repos/:repoId/..., created on first use. Throws 404 unknown-repo, 410
  // repo-missing, 409 repo-too-old or repo-newer.
  async function contextFor(id) {
    const loaded = contexts.get(id);
    if (loaded) {
      if (loaded.mode === 'repo' && !existsSync(configFile(loaded.repo.root)))
        throw new HttpError(410, 'repo-missing', 'Folder not found');
      return loaded;
    }
    let p = creating.get(id);
    if (!p) {
      const entry =
        findProject(id) || (adopted.has(id) ? { id, root: adopted.get(id), group: null } : null);
      if (!entry) throw new HttpError(404, 'unknown-repo', 'No such project');
      const probe = probeRepo(entry.root);
      if (probe.state === 'missing') throw new HttpError(410, 'repo-missing', probe.message);
      if (probe.state === 'pre-1.0') throw new HttpError(409, 'repo-too-old', probe.message);
      if (probe.state === 'repo-newer') throw new HttpError(409, 'repo-newer', probe.message);
      p = createRepoContext(id, entry.root).finally(() => creating.delete(id));
      creating.set(id, p);
    }
    return p;
  }

  // An install context for a folder without Shipline: in memory only, "Not set up" until Install succeeds or it is
  // dismissed. Its id is the registry id of the install root, so the URL stays the same after Install; a repeat
  // handoff for the same folder reuses it.
  function openInstall(dir) {
    const root = installRootFor(dir);
    const id = projectId(root);
    const existing = contexts.get(id);
    if (existing) return existing;
    const ctx = baseContext(id, root);
    ctx.mode = 'install';
    ctx.install = { root, isGit: gitRootOf(dir) !== null };
    ctx.group = gitCommonDir(root);
    ctx.table = installRoutes(ctx);
    contexts.set(id, ctx);
    scheduleChange();
    return ctx;
  }

  // Stops a loaded repo's file watch and chats, releases its lock and drops it. A chat that runs is the caller's
  // check (409 chat-running).
  async function dispose(ctx) {
    contexts.delete(ctx.id);
    if (ctx.watch) await ctx.watch.close();
    if (ctx.chats) await ctx.chats.close();
    ctx.connectFns.length = 0;
  }

  // ---------- SSE ----------

  // Pending prompts and banners are sent again on every SSE connect, tagged with their repo.
  app.hub.onConnect((reply) => {
    for (const ctx of contexts.values()) {
      const tagged = (type, data) => reply(type, { ...data, repoId: ctx.id });
      for (const b of ctx.banners.values()) tagged('banner', b);
      for (const fn of ctx.connectFns) {
        try {
          fn(tagged);
        } catch {
          // One module's failure must not stop the stream.
        }
      }
    }
  });

  function scheduleChange() {
    if (scheduled || stopped) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (stopped || app.hub.size() === 0) return;
      list()
        .then((projects) => {
          app.hub.send('projects', projects);
          return chatsList().then((chats) => app.hub.send('chats', chats));
        })
        .catch((e) => app.serverLogger.log('projects-error', { message: e && e.message }));
    });
  }

  // ---------- listing (no contexts are created) ----------

  // { setupDone, configError }: from the loaded repo, or (cached by the file's mtime) from its own lib.
  async function configInfoOf(entry, ctx, state) {
    if (ctx && ctx.mode === 'repo') {
      const { cfg, error } = ctx.repo.getConfig();
      return { setupDone: Boolean(cfg && cfg.setup === 'done'), configError: error || null };
    }
    if (state === 'missing') return { setupDone: false, configError: null };
    const file = configFile(entry.root);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return { setupDone: false, configError: null };
    }
    const hit = configCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.info;
    let info = { setupDone: false, configError: null };
    try {
      const lib = await loadRepoLib(entry.root);
      info = { setupDone: lib.loadConfig(entry.root).setup === 'done', configError: null };
    } catch (e) {
      // An unreadable config or lib: not done.
      info = { setupDone: false, configError: (e && e.message) || 'The config could not be read' };
    }
    configCache.set(file, { mtimeMs, info });
    return info;
  }

  const setupDoneOf = async (entry, ctx, state) =>
    (await configInfoOf(entry, ctx, state)).setupDone;

  const versionOf = (v) => (v ? { package: v.package ?? null, interface: v.interface } : null);

  // A worktree whose branch still carries pre-2.2 hooks keeps its own task store (they don't know the shared one).
  function sharedStoreNote(root, probe) {
    if (probe.state !== 'ok' || !probe.version || probe.version.interface >= 2) return null;
    try {
      return mainRoot(root) !== realpathSync(root)
        ? "Older Shipline hooks: tasks aren't shared with other worktrees until this branch is upgraded."
        : null;
    } catch {
      return null;
    }
  }

  async function describe(entry) {
    const ctx = contexts.get(entry.id);
    const probe = probeRepo(entry.root);
    const w = ctx && ctx.mode === 'repo' ? ctx.waitingInfo() : { count: 0, chatRunning: false };
    return {
      id: entry.id,
      root: entry.root,
      name: path.basename(entry.root),
      group: entry.group ?? null,
      groupName: groupNameOf(entry.group),
      branch: gitBranch(entry.root),
      state: probe.state,
      version: versionOf(probe.version),
      setupDone: await setupDoneOf(entry, ctx, probe.state),
      loaded: Boolean(ctx && ctx.mode === 'repo'),
      waiting: w.count,
      chatRunning: w.chatRunning,
      message: probe.message,
      note: sharedStoreNote(entry.root, probe),
    };
  }

  function describeInstall(ctx) {
    return {
      id: ctx.id,
      root: ctx.install.root,
      name: path.basename(ctx.install.root),
      group: ctx.group,
      groupName: groupNameOf(ctx.group),
      branch: gitBranch(ctx.install.root),
      state: 'install',
      version: null,
      setupDone: false,
      loaded: true,
      waiting: 0,
      chatRunning: false,
      message: 'Not set up',
    };
  }

  // GET /api/projects: the registry (sorted by path) plus the install contexts.
  async function list() {
    const { projects } = readRegistry();
    const out = [];
    const listed = new Set();
    for (const entry of projects) {
      listed.add(entry.id);
      out.push(await describe(entry));
    }
    for (const [id, root] of adopted) {
      if (listed.has(id)) continue;
      listed.add(id);
      out.push(await describe({ id, root, group: null }));
    }
    for (const ctx of contexts.values()) {
      if (listed.has(ctx.id)) continue;
      if (ctx.mode === 'install') out.push(describeInstall(ctx));
      // Serving, but the registry couldn't be written: still listed.
      else out.push(await describe({ id: ctx.id, root: ctx.repo.root, group: ctx.group }));
    }
    return out;
  }

  // The unfinished tasks of one repo for the combined view, without a context. Stage names come from the repo's own
  // lib; files and checks are left out.
  async function openTasksOf(entry, ctx) {
    try {
      const repo =
        ctx && ctx.mode === 'repo'
          ? ctx.repo
          : { root: entry.root, lib: await loadRepoLib(entry.root) };
      const view = makeTaskView({ repo });
      return readOpenTasks(repo.root).map((t) => {
        const v = view(t);
        return {
          dir: v.dir,
          slug: v.slug,
          title: v.title,
          workflow: v.workflow,
          branch: v.branch,
          stages: v.stages.map((s) => ({ id: s.id, name: s.name, status: s.status })),
        };
      });
    } catch {
      return [];
    }
  }

  // ---------- chats (the flat list), health ----------

  // Every repo this server can serve, as { id, root }: the registry, the adopted ones and any loaded repo. No probing.
  function repoEntries() {
    const out = [];
    const seen = new Set();
    const add = (id, root) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, root });
    };
    for (const e of readRegistry().projects) add(e.id, e.root);
    for (const [id, root] of adopted) add(id, root);
    for (const ctx of contexts.values()) if (ctx.mode === 'repo') add(ctx.id, ctx.repo.root);
    return out;
  }

  // The task a chat is bound to, as { workflow, stage, stages }, read from the task files (no context). `stage` is the
  // id of the stage in progress, else the first pending one, else the last.
  function chatTaskOf(entry, chat, view) {
    if (!chat.task_dir) return null;
    try {
      const t = readTask(entry.root, chat.task_dir);
      if (!t) return null;
      const v = view(t);
      const stages = v.stages.map((s) => ({ id: s.id, name: s.name, status: s.status }));
      const current =
        stages.find((s) => s.status === 'in_progress') ||
        stages.find((s) => s.status === 'pending') ||
        stages[stages.length - 1];
      return { workflow: v.workflow, stage: current ? current.id : null, stages };
    } catch {
      return null;
    }
  }

  // GET /api/chats: every chat of every `ok` project, newest activity first. Built from sessions.json and the task
  // files; `waiting` only for loaded repos (only they can have a prompt or an unseen error).
  async function chatsList() {
    const out = [];
    for (const entry of repoEntries()) {
      if (probeRepo(entry.root).state !== 'ok') continue;
      const ctx = contexts.get(entry.id);
      const loaded = ctx && ctx.mode === 'repo';
      const sessions = listChats(entry.root);
      let view = null;
      if (sessions.some((c) => c.task_dir)) {
        try {
          const lib = loaded ? ctx.repo.lib : await loadRepoLib(entry.root);
          view = makeTaskView({ repo: { root: entry.root, lib } });
        } catch {
          view = null; // A broken lib: the chats are listed without their stage trail.
        }
      }
      const waiting = new Map();
      if (loaded) for (const w of ctx.waitingInfo().items) waiting.set(w.chatId, w.reason);
      for (const c of sessions) {
        out.push({
          id: c.id,
          repoId: entry.id,
          title: c.title,
          updatedAt: c.last_active || c.created || null,
          task: view && c.task_dir ? chatTaskOf(entry, c, view) : null,
          waiting: waiting.get(c.id) ?? null,
        });
      }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  // GET /api/chats/:chatId/repo
  function chatRepo(chatId) {
    for (const entry of repoEntries()) {
      if (probeRepo(entry.root).state !== 'ok') continue;
      if (listChats(entry.root).some((c) => c.id === chatId)) return { repoId: entry.id };
    }
    throw new HttpError(404, 'unknown-chat', 'No such chat');
  }

  let claudeCache = null; // { at, value }
  async function claudeInfo() {
    if (claudeCache && Date.now() - claudeCache.at < CLAUDE_HEALTH_TTL_MS) return claudeCache.value;
    let value;
    try {
      const h = await claudeHealth(MIN_CLAUDE_VERSION);
      value = {
        path: h.bin,
        installed: h.installed,
        version: h.version,
        signedIn: h.loggedIn,
        meetsMinVersion: h.meetsMinVersion,
        minVersion: h.minVersion,
      };
    } catch (e) {
      value = {
        path: null,
        installed: false,
        version: null,
        signedIn: false,
        meetsMinVersion: false,
        minVersion: MIN_CLAUDE_VERSION,
        error: e && e.message,
      };
    }
    claudeCache = { at: Date.now(), value };
    return value;
  }

  // red: Claude missing or not signed in, repo-newer / pre-1.0, a config parse error. amber: missing, setup not done,
  // other warnings. green otherwise.
  function dotOf({ state, setupDone, configError, warnings }, claude) {
    if (!claude.installed || !claude.signedIn) return 'red';
    if (state === 'repo-newer' || state === 'pre-1.0' || configError) return 'red';
    if (state === 'missing' || state === 'install') return 'amber';
    if (!setupDone || warnings > 0) return 'amber';
    return 'green';
  }

  // Per-project health rows, without loading contexts (warnings come from loaded ones; for the rest, what files say).
  async function projectHealth(claude, projects) {
    const rows = [];
    for (const p of projects || (await list())) {
      const ctx = contexts.get(p.id);
      let configError = null;
      let lock = null;
      if (p.state !== 'install') {
        configError = (await configInfoOf({ root: p.root }, ctx, p.state)).configError;
        if (p.state !== 'missing') {
          const l = liveLock(p.root, app.port);
          if (l) lock = { pid: l.pid ?? null, port: l.port ?? null };
        }
      }
      const warnings = ctx && ctx.mode === 'repo' ? ctx.banners.size : configError ? 1 : 0;
      const row = {
        id: p.id,
        state: p.state,
        setupDone: p.setupDone,
        configError,
        lock,
        warnings,
        message: p.message,
        version: p.version,
        upgradeAvailable: Boolean(
          p.state === 'ok' &&
          p.version &&
          p.version.package &&
          semverGt(app.uiVersion, p.version.package),
        ),
      };
      row.dot = dotOf(row, claude);
      rows.push(row);
    }
    return rows;
  }

  // GET /api/health
  async function health() {
    const claude = await claudeInfo();
    const projects = await projectHealth(claude);
    return {
      machine: {
        uiVersion: app.uiVersion,
        cliVersion: app.uiVersion,
        claude,
        node: process.version,
        port: app.port,
        phone: app.remote ? app.remote.snapshot() : null,
        logTail: redact(app.serverLogger.tail(LOG_TAIL_LINES)),
      },
      projects,
    };
  }

  // GET /api/overview: waiting chats (loaded repos only: only they can have running chats), the project cards and
  // unfinished tasks, each item carrying its repoId; `attention` counts the projects whose health dot isn't green.
  async function overview() {
    const list0 = await list();
    const claude = await claudeInfo();
    const healthRows = await projectHealth(claude, list0);
    const needsYou = [];
    const tasks = [];
    const projects = [];
    for (const p of list0) {
      const ctx = contexts.get(p.id);
      const h = healthRows.find((r) => r.id === p.id);
      const card = {
        ...p,
        uiVersion: app.uiVersion,
        dot: h.dot,
        upgradeAvailable: h.upgradeAvailable,
        unfinished: 0,
      };
      projects.push(card);
      if (p.state === 'install' || p.state === 'missing') continue;
      const titles = new Map();
      try {
        for (const c of listChats(p.root)) titles.set(c.id, c.title);
      } catch {
        // No chats.
      }
      if (ctx && ctx.mode === 'repo') {
        for (const w of ctx.waitingInfo().items) {
          needsYou.push({
            repoId: p.id,
            repoName: p.name,
            chatId: w.chatId,
            title: titles.get(w.chatId) ?? 'Chat',
            reason: w.reason,
          });
        }
      }
      if (p.state === 'ok') {
        const open = await openTasksOf({ root: p.root }, ctx);
        card.unfinished = open.length;
        for (const t of open) tasks.push({ repoId: p.id, repoName: p.name, ...t });
      }
    }
    return {
      needsYou,
      projects,
      tasks,
      attention: healthRows.filter((r) => r.dot !== 'green').length,
    };
  }

  // DELETE /api/projects/:repoId: unregisters only. The store and files are untouched.
  async function remove(id) {
    const ctx = contexts.get(id);
    if (ctx && ctx.mode === 'install') {
      contexts.delete(id);
      scheduleChange();
      return { ok: true };
    }
    const entry = findProject(id);
    if (!entry && !ctx) throw new HttpError(404, 'unknown-repo', 'No such project');
    const root = entry ? entry.root : ctx.repo.root;
    const lock = liveLock(root, app.port);
    if ((ctx && ctx.chats && ctx.chats.activeId()) || lock)
      throw new HttpError(409, 'chat-running', 'A chat is running in this project. Stop it first.');
    if (ctx) await dispose(ctx);
    try {
      unregisterProject(id);
    } catch (e) {
      throw new HttpError(
        500,
        'registry-failed',
        `Could not update the project list (${e.message})`,
      );
    }
    app.serverLogger.log('unregistered', { id, root });
    scheduleChange();
    return { ok: true };
  }

  // ---------- handoff ----------

  function requireKey(req) {
    const supplied = req.headers['x-shipline-key'];
    if (typeof supplied !== 'string' || !supplied || !safeEqual(supplied, app.serverKey))
      throw new HttpError(403, 'bad-key', 'Wrong server key');
  }

  // POST /api/handoff { dir, remote }: registers the folder's repo (or opens an install context for it), turns on
  // phone access when asked, and returns a one-time login link that opens it.
  async function handoff(body) {
    if (!body || typeof body.dir !== 'string' || !body.dir)
      throw new HttpError(400, 'bad-request', 'dir is required');
    if (!path.isAbsolute(body.dir))
      throw new HttpError(400, 'bad-dir', 'dir must be an absolute path.');
    const dir = path.resolve(body.dir);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new HttpError(400, 'bad-dir', `${dir} is not a directory.`);

    const repoRoot = findRepoRoot(dir);
    let id;
    let root = null;
    let installRoot = null;
    if (repoRoot) {
      root = repoRoot;
      id = projectId(repoRoot);
      if (
        !registerQuietly(repoRoot, (m) => app.serverLogger.log('registry-warning', { message: m }))
      )
        adopted.set(id, repoRoot);
    } else {
      const ctx = openInstall(dir);
      id = ctx.id;
      installRoot = ctx.install ? ctx.install.root : ctx.repo.root;
    }

    let phone;
    if (body.remote === true) {
      if (!repoRoot && readRegistry().projects.length === 0) {
        phone = {
          enabled: false,
          url: null,
          message:
            'Phone access needs an installed repo, so it is off. Install Shipline here first.',
        };
      } else {
        const status = await app.remote.start();
        phone = {
          enabled: status.enabled,
          url: status.url,
          message: status.enabled ? '' : status.tailscale.message,
        };
      }
    }
    app.serverLogger.log('handoff', {
      id,
      root: root || installRoot,
      remote: body.remote === true,
    });
    scheduleChange();
    const url = `http://127.0.0.1:${app.port}/?t=${app.auth.mintLoginToken()}#/${repoRoot ? 'new' : 'setup'}/${id}`;
    return { url, id, root, installRoot, version: app.uiVersion, ...(phone ? { phone } : {}) };
  }

  return {
    contextFor,
    openInstall,
    list,
    overview,
    remove,
    handoff,
    // Serves a repo the registry could not record (see `adopted`).
    adopt: (id, root) => adopted.set(id, root),
    // The context for an id if it is loaded (no creation), for the audit log.
    peek: (id) => contexts.get(id) || null,
    // After a start folder was registered or changed.
    changed: scheduleChange,

    // The server-wide routes.
    routes: () => [
      { method: 'GET', path: '/api/projects', handler: () => list() },
      {
        method: 'DELETE',
        path: '/api/projects/:repoId',
        handler: ({ params }) => remove(params.repoId),
      },
      ...preferencesRoutes(app),
      { method: 'GET', path: '/api/overview', handler: () => overview() },
      { method: 'GET', path: '/api/chats', handler: () => chatsList() },
      {
        method: 'GET',
        path: '/api/chats/:chatId/repo',
        handler: ({ params }) => chatRepo(params.chatId),
      },
      { method: 'GET', path: '/api/health', handler: () => health() },
      {
        method: 'GET',
        path: '/api/handoff/ping',
        handler: ({ req }) => {
          requireKey(req);
          return { ok: true, version: app.uiVersion };
        },
      },
      {
        method: 'POST',
        path: '/api/handoff',
        handler: ({ req, body }) => {
          requireKey(req);
          return handoff(body);
        },
      },
    ],

    // Shutdown, in two steps like the single-repo server had: stop the file watches, then (after http is closed) every
    // chat and its lock.
    async closeWatches() {
      stopped = true;
      await Promise.all([...contexts.values()].map((ctx) => ctx.watch && ctx.watch.close()));
    },
    async closeChats() {
      for (const ctx of contexts.values()) {
        if (ctx.chats) {
          try {
            await withLogger(ctx.logger, () => ctx.chats.close());
          } catch (e) {
            app.serverLogger.log('close-error', {
              name: `chats:${ctx.id}`,
              message: e && e.message,
            });
          }
        }
      }
    },
  };
}
