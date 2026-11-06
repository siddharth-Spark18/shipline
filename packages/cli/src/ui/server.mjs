// `shipline ui`: the local server. Node 20+, no dependencies.
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERFACE } from '../interface.mjs';
import { createAuth } from './auth.mjs';
import { createChats } from './chat.mjs';
import { routes as chatRoutes } from './chat-routes.mjs';
import { routes as diagnosticsRoutes } from './diagnostics.mjs';
import { installedRoutes, notInstalled, routes as installRoutes } from './install-routes.mjs';
import { HttpError, parseJsonBody, readBody, sendError, sendJson } from './http.mjs';
import { initLog, log } from './log.mjs';
import { openBrowser } from './open-browser.mjs';
import { createPrompts } from './prompts.mjs';
import { gitRootOf, installRootFor, resolveRepo } from './repo.mjs';
import { stopEverything as stopAllShells } from './shell.mjs';
import { routes as setupRoutes } from './setup.mjs';
import { createHub } from './sse.mjs';
import { routes as taskRoutes } from './tasks.mjs';
import { storeDir } from '../store.mjs';
import { startTaskWatch } from './watch.mjs';

const UI_DIST = fileURLToPath(new URL('../../ui-dist/', import.meta.url));
const UI_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
const SHUTDOWN_LIMIT_MS = 7000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const UI_USAGE = `Usage: npx @forgeyard/shipline ui [--dir <path>] [--port <n>] [--no-open]

Local web UI for setup and tasks (Node 20+).

Options:
  --dir <path>   Target folder (default: the current directory)
  --port <n>     Port to listen on (default: a free one)
  --no-open      Don't open the browser
  -h, --help     Show this help`;

function usageError(message) {
  console.error(`shipline: ${message}`);
  process.exit(2);
}

// ui [--dir <path>] [--port <n>] [--no-open] [--help]. A bare argument is an error: the folder is given with --dir.
export function parseUiArgs(argv) {
  let dir = null;
  let port = 0;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(UI_USAGE);
      process.exit(0);
    } else if (a === '--no-open') open = false;
    else if (a === '--dir' || a.startsWith('--dir=')) {
      const value = a === '--dir' ? argv[++i] : a.slice('--dir='.length);
      if (!value) usageError('--dir needs a path (see shipline ui --help)');
      dir = value;
    } else if (a === '--port' || a.startsWith('--port=')) {
      const value = a === '--port' ? argv[++i] : a.slice('--port='.length);
      if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) {
        usageError('--port needs a number from 0 to 65535 (see shipline ui --help)');
      }
      port = Number(value);
    } else if (a.startsWith('-')) usageError(`unknown option ${a} (see shipline ui --help)`);
    else usageError(`unexpected argument ${a} (use --dir)`);
  }
  return { dir: dir === null ? process.cwd() : path.resolve(dir), port, open };
}

// '/api/chats/:id/stop' against '/api/chats/<uuid>/stop' -> { id }, or null. A param never spans a '/'.
function matchPath(pattern, pathname) {
  if (!pattern.includes(':')) return pattern === pathname ? {} : null;
  const a = pattern.split('/');
  const b = pathname.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      if (!b[i]) return null;
      try {
        params[a[i].slice(1)] = decodeURIComponent(b[i]);
      } catch {
        return null;
      }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

function sendStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    rel = '';
  }
  let file = path.resolve(UI_DIST, rel || 'index.html');
  const inside = path.relative(UI_DIST, file);
  if (
    inside.startsWith('..') ||
    path.isAbsolute(inside) ||
    !existsSync(file) ||
    !statSync(file).isFile()
  ) {
    file = path.join(UI_DIST, 'index.html'); // unknown paths get the app
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('The UI bundle is not built. Run: pnpm --filter @shipline/ui build');
  }
  const ext = path.extname(file).toLowerCase();
  const body = readFileSync(file);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
  };
  if (path.basename(file) === 'index.html') headers['Cache-Control'] = 'no-store';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Builds everything a repo needs (repo, log, store, prompts, chats, watch) on `app` and returns its route table.
// Used when the server starts on an installed repo, and again when the install wizard finishes. `repo` is an
// already resolved repo (startServer resolves it first to detect install mode).
export async function startRepoMode(app, root, repo = null) {
  repo = repo || (await resolveRepo(root));
  storeDir(repo.root);
  initLog(repo.root);
  log('start', { root: repo.root, uiVersion: UI_VERSION, node: process.version });
  log('version', { repo: repo.version, ui: INTERFACE, state: repo.state });

  app.repo = repo;
  if (repo.state === 'pre-1.0') {
    app.addBanner({ id: 'version', kind: 'version', text: repo.versionMessage });
  } else if (repo.state === 'repo-newer') {
    const v = repo.version.package || 'latest';
    app.addBanner({
      id: 'version',
      kind: 'version',
      text: `This repo was set up with Shipline ${v}. Run \`npx @forgeyard/shipline@${v} ui\`.`,
    });
  }
  app.prompts = createPrompts(app);
  app.chats = createChats(app);
  app.watch = await startTaskWatch(app);
  app.table = [
    ...diagnosticsRoutes(app),
    ...app.prompts.routes(),
    ...chatRoutes(app),
    ...setupRoutes(app),
    ...taskRoutes(app),
    ...installedRoutes(),
    { method: 'GET', path: '/api/events', handler: ({ req, res }) => app.hub.connect(req, res) },
  ];
  app.mode = 'repo'; // last: until now the install routes answer
  return app.table;
}

export async function startServer({ dir, port = 0, open = true } = {}) {
  let repo = null;
  try {
    repo = await resolveRepo(dir);
  } catch (e) {
    // No Shipline setup here: serve the install wizard, which writes nothing until Install.
    if (e.code !== 'NO_REPO') fail(`Could not load the repo's .shipline/bin/lib.mjs: ${e.message}`);
  }
  const hub = createHub();
  const banners = new Map();
  let switching = null;
  const app = {
    mode: repo ? 'repo' : 'install',
    install: repo ? null : { root: installRootFor(dir), isGit: gitRootOf(dir) !== null },
    repo,
    hub,
    uiVersion: UI_VERSION,
    port: null,
    auth: null,
    watch: null,
    prompts: null,
    chats: null,
    table: [],
    addBanner(banner) {
      banners.set(banner.id, banner);
      hub.send('banner', banner);
    },
    // After a successful install: the same server, port and auth, now with the repo's full routes. Requests
    // that arrive meanwhile share the one switch; a failed switch can be tried again.
    async switchToRepo() {
      if (app.mode === 'repo') return;
      switching ||= startRepoMode(app, app.install.root).catch((e) => {
        switching = null;
        throw e;
      });
      await switching;
    },
  };
  hub.onConnect((reply) => {
    for (const b of banners.values()) reply('banner', b);
  });
  if (!repo) app.table = installRoutes(app);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const { pathname } = url;
      const isApi = pathname.startsWith('/api/');
      const isStatic = !isApi && (req.method === 'GET' || req.method === 'HEAD');

      // The Host check comes first, then the token exchange, then cookie and Origin.
      if (req.headers.host !== `127.0.0.1:${app.port}`)
        throw new HttpError(403, 'bad-host', 'Host not allowed');
      if (req.method === 'GET' && pathname === '/' && url.searchParams.has('t')) {
        return app.auth.exchange(req, res, url.searchParams.get('t'));
      }
      app.auth.check(req, { method: req.method, pathname, isStatic });

      if (isStatic) return sendStatic(req, res, pathname);
      // Installed meanwhile (a terminal `init`, or another tab's Install): serve the repo from now on, so the
      // wizard's reload opens the normal UI.
      if (
        isApi &&
        app.mode === 'install' &&
        existsSync(path.join(app.install.root, '.shipline', 'config.yml'))
      )
        await app.switchToRepo();
      // Routes may have :params (for example /api/chats/:id); an exact path matches first.
      const matches = [];
      for (const r of app.table) {
        const params = matchPath(r.path, pathname);
        if (params) matches.push({ ...r, params });
      }
      const route = matches.find((r) => r.method === req.method);
      if (!route) {
        if (isApi && app.mode === 'install') notInstalled();
        if (isApi && matches.length)
          throw new HttpError(405, 'method-not-allowed', 'Method not allowed');
        throw new HttpError(404, 'not-found', 'Not found');
      }
      const body =
        req.method === 'POST'
          ? parseJsonBody(await readBody(req, { max: route.maxBody }))
          : undefined;
      const result = await route.handler({ req, res, url, body, params: route.params });
      if (!res.headersSent) sendJson(res, 200, result === undefined ? {} : result);
    } catch (e) {
      if (!(e instanceof HttpError)) log('error', { method: req.method, message: e && e.message });
      sendError(res, e);
    }
  });
  server.requestTimeout = 0;
  server.timeout = 0;

  // listen first (port 0 picks a free port): the token and cookie name depend on the real port.
  await new Promise((resolve) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') fail(`Port ${port} is in use`);
      fail(`Could not listen on 127.0.0.1:${port}: ${e.message}`);
    });
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  });
  app.port = server.address().port;
  app.auth = createAuth(app.port);

  // Started modules, closed in reverse order. watch, chats and shell exist only once a repo is served.
  const closers = [{ name: 'hub', close: () => hub.close() }];
  if (repo) {
    try {
      await startRepoMode(app, repo.root, repo);
    } catch (e) {
      fail(e.message);
    }
  }
  closers.push({ name: 'watch', close: () => app.watch && app.watch.close() });
  closers.push({
    name: 'http',
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });

  // After http, so shutdown stops the claude process group and releases the lock before the server closes.
  closers.push({ name: 'chats', close: () => app.chats && app.chats.close() });
  closers.push({ name: 'shell', close: () => stopAllShells() });

  let shuttingDown = false;
  async function shutdown(code, reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('exit', { reason, code });
    const closeAll = (async () => {
      for (const c of [...closers].reverse()) {
        try {
          await c.close();
        } catch (e) {
          log('close-error', { name: c.name, message: e && e.message });
        }
      }
    })();
    let limit;
    await Promise.race([
      closeAll,
      new Promise((resolve) => (limit = setTimeout(resolve, SHUTDOWN_LIMIT_MS))),
    ]);
    clearTimeout(limit);
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('uncaughtException', (e) => {
    log('uncaught', { message: e && e.message, stack: e && e.stack });
    console.error(e);
    shutdown(1, 'uncaughtException');
  });
  process.on('unhandledRejection', (e) => {
    log('unhandled-rejection', { message: e && e.message });
    console.error(e);
    shutdown(1, 'unhandledRejection');
  });

  // The URL carries the token on purpose: it is printed and opened, and never logged.
  const url = `http://127.0.0.1:${app.port}/?t=${app.auth.token}`;
  if (!repo) {
    console.log(`Shipline setup for ${app.install.root}`);
    console.log('Nothing is written until you press Install in the browser.');
  } else console.log(`Shipline UI for ${repo.root}`);
  console.log(url);
  console.log('Press Ctrl+C to stop.');
  if (open) openBrowser(url);

  return { port: app.port, url, close: () => shutdown(0, 'close') };
}
