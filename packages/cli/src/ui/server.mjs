// `shipline ui`: the local server. Node 20+, no dependencies.
import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectId, readRegistry, registerQuietly } from '../registry.mjs';
import { createAuth } from './auth.mjs';
import { createDevices } from './devices.mjs';
import { HttpError, parseJsonBody, readBody, sendError, sendJson } from './http.mjs';
import { createLogger, serverLogFile, setDefaultLogger, withLogger } from './log.mjs';
import { openBrowser } from './open-browser.mjs';
import { createProjects } from './projects.mjs';
import { notInstalled } from './install-routes.mjs';
import { createRemote } from './remote.mjs';
import { routes as remoteRoutes } from './remote-routes.mjs';
import { resolveRepo } from './repo.mjs';
import { removeServerRecord, serverFile, writeServerRecord } from './server-record.mjs';
import { stopEverything as stopAllShells } from './shell.mjs';
import { createHub } from './sse.mjs';
import { storeDir } from '../store.mjs';

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
  '.webmanifest': 'application/manifest+json',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const UI_USAGE = `Usage: npx @forgeyard/shipline ui [--dir <path>] [--port <n>] [--no-open] [--remote]

Local web UI for setup and tasks (Node 20+). One server serves every repo on this machine: when one is already
running, this opens the folder in it instead of starting another.

Options:
  --dir <path>   Target folder (default: the current directory)
  --port <n>     Port to listen on (default: a free one; ignored when a server is already running)
  --no-open      Don't open the browser
  --remote       Also serve the UI to your paired phone over Tailscale (turns it on in a running server too)
  -h, --help     Show this help`;

function usageError(message) {
  console.error(`shipline: ${message}`);
  process.exit(2);
}

// ui [--dir <path>] [--port <n>] [--no-open] [--remote] [--help]. A bare argument is an error: the folder is given with --dir.
export function parseUiArgs(argv) {
  let dir = null;
  let port = 0;
  let open = true;
  let remote = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(UI_USAGE);
      process.exit(0);
    } else if (a === '--no-open') open = false;
    else if (a === '--remote') remote = true;
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
  return { dir: dir === null ? process.cwd() : path.resolve(dir), port, open, remote };
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

// '/api/repos/<id>/chats' -> { id, rest: '/api/chats' } (the per-repo modules keep their own route paths), or null.
function splitRepoPath(pathname) {
  const m = /^\/api\/repos\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return { id: null, rest: null };
  }
  return { id, rest: `/api${m[2] || ''}` };
}

// Returns { port, url, repoId, close }. Always starts a server: finding a running one and handing over to it is
// `launchUi` (server-record.mjs), which the CLI calls.
export async function startServer({ dir, port = 0, open = true, remote = false } = {}) {
  let repo = null;
  try {
    repo = await resolveRepo(dir);
  } catch (e) {
    // No Shipline setup here: serve the install wizard, which writes nothing until Install.
    if (e.code !== 'NO_REPO') fail(`Could not load the repo's .shipline/bin/lib.mjs: ${e.message}`);
  }
  // The start folder's task store must be usable (the repo's own context is created later, on its first request).
  if (repo) {
    try {
      storeDir(repo.root);
    } catch (e) {
      fail(e.message);
    }
  }
  // Phone access state: the hub asks it on every heartbeat whether a device's stream may stay open.
  const devices = createDevices();
  const hub = createHub({
    deviceState: (id) => {
      if (!app.remote || !app.remote.enabled) return 'remote-off';
      return devices.has(id) ? null : 'revoked';
    },
  });
  const serverLogger = createLogger(serverLogFile());
  setDefaultLogger(serverLogger);
  const recordFile = serverFile();
  const app = {
    hub,
    uiVersion: UI_VERSION,
    port: null,
    auth: null,
    remote: null,
    projects: null,
    serverLogger,
    log: (event, data) => serverLogger.log(event, data),
    // The key a later `shipline ui` run shows to the handoff routes (it is also in server.json, mode 0600).
    serverKey: crypto.randomBytes(32).toString('hex'),
    table: [],
  };

  const server = http.createServer(async (req, res) => {
    let logger = serverLogger;
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const { pathname } = url;
      const isApi = pathname.startsWith('/api/');
      const isStatic = !isApi && (req.method === 'GET' || req.method === 'HEAD');
      const repoPath = isApi ? splitRepoPath(pathname) : null;
      const peeked = repoPath && repoPath.id ? app.projects.peek(repoPath.id) : null;
      if (peeked) logger = peeked.logger;

      // The Host classification comes first (a foreign Host is refused), then the token exchange (laptop host
      // only), then cookie and Origin.
      const kind = app.auth.classify(req);
      if (req.method === 'GET' && pathname === '/' && url.searchParams.has('t')) {
        return app.auth.exchange(req, res, url.searchParams.get('t'));
      }
      const who = app.auth.check(req, { method: req.method, pathname, isStatic });
      // Audit: what a paired device changed (method, path and status only; never a body). It goes to the repo's
      // log for /api/repos/:id/..., and to the server log otherwise.
      if (kind === 'remote' && isApi && who.deviceId && req.method !== 'GET') {
        const audit = logger;
        res.once('finish', () =>
          audit.log('remote', {
            device: who.deviceId,
            name: who.name,
            method: req.method,
            path: pathname,
            status: res.statusCode,
          }),
        );
      }

      if (isStatic) return sendStatic(req, res, pathname);

      let table = app.table;
      let routePath = pathname;
      let ctx = null;
      if (repoPath) {
        if (!repoPath.id) throw new HttpError(404, 'unknown-repo', 'No such project');
        ctx = await app.projects.contextFor(repoPath.id);
        logger = ctx.logger;
        // Installed meanwhile (a terminal `init`, or another tab's Install): serve the repo from now on, so the
        // wizard's reload opens the normal UI.
        if (ctx.mode === 'install' && existsSync(path.join(ctx.install.root, '.shipline', 'config.yml')))
          await withLogger(logger, () => ctx.switchToRepo());
        table = ctx.table;
        routePath = repoPath.rest;
        logger = ctx.logger;
      }
      // Routes may have :params (for example /api/chats/:id); an exact path matches first.
      const matches = [];
      for (const r of table) {
        const params = matchPath(r.path, routePath);
        if (params) matches.push({ ...r, params });
      }
      const route = matches.find((r) => r.method === req.method);
      if (!route) {
        if (ctx && ctx.mode === 'install') notInstalled();
        if (isApi && matches.length)
          throw new HttpError(405, 'method-not-allowed', 'Method not allowed');
        throw new HttpError(404, 'not-found', 'Not found');
      }
      const body =
        req.method === 'POST'
          ? parseJsonBody(await readBody(req, { max: route.maxBody }))
          : undefined;
      const result = await withLogger(logger, () =>
        route.handler({ req, res, url, body, params: route.params, who }),
      );
      if (!res.headersSent) sendJson(res, 200, result === undefined ? {} : result);
    } catch (e) {
      if (!(e instanceof HttpError)) logger.log('error', { method: req.method, message: e && e.message });
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
  app.remote = createRemote({ app, devices });
  app.auth = createAuth(app.port, app);
  app.projects = createProjects(app);
  app.table = [
    ...app.projects.routes(),
    ...remoteRoutes(app),
    {
      method: 'GET',
      path: '/api/events',
      handler: ({ req, res, who }) =>
        app.hub.connect(req, res, {
          deviceId: who && who.kind === 'device' ? who.deviceId : undefined,
        }),
    },
  ];

  // The start folder: registered when it has Shipline, an install context when it doesn't. Its repo context is
  // created on its first request, like every other.
  let repoId;
  if (repo) {
    repoId = projectId(repo.root);
    if (!registerQuietly(repo.root, (m) => console.error(m))) app.projects.adopt(repoId, repo.root);
  } else repoId = app.projects.openInstall(dir).id;
  try {
    writeServerRecord({
      pid: process.pid,
      port: app.port,
      version: UI_VERSION,
      key: app.serverKey,
      startedAt: new Date().toISOString(),
    });
  } catch (e) {
    // The server works without it; a later `shipline ui` just can't find it to hand over.
    console.error(`shipline: could not write ${recordFile} (${e.message}); other terminals will start their own UI.`);
  }
  serverLogger.log('start', { port: app.port, version: UI_VERSION, node: process.version, dir });

  // Started modules, closed in reverse order. The first one pushed runs last: server.json goes only after
  // everything else has stopped (and only if it is still ours).
  const closers = [{ name: 'server-record', close: () => removeServerRecord(recordFile, app.port) }];
  closers.push({ name: 'hub', close: () => hub.close() });
  closers.push({ name: 'watch', close: () => app.projects.closeWatches() });
  closers.push({
    name: 'http',
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });

  // After http, so shutdown stops every claude process group and releases the locks before the server closes.
  closers.push({ name: 'chats', close: () => app.projects.closeChats() });
  closers.push({ name: 'shell', close: () => stopAllShells() });
  // Last pushed, first closed: take the phone mapping down before anything else stops.
  closers.push({ name: 'remote', close: () => app.remote.stop() });

  let shuttingDown = false;
  async function shutdown(code, reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    serverLogger.log('exit', { reason, code });
    const closeAll = (async () => {
      for (const c of [...closers].reverse()) {
        try {
          await c.close();
        } catch (e) {
          serverLogger.log('close-error', { name: c.name, message: e && e.message });
        }
      }
    })();
    let limit;
    await Promise.race([
      closeAll,
      new Promise((resolve) => (limit = setTimeout(resolve, SHUTDOWN_LIMIT_MS))),
    ]);
    clearTimeout(limit);
    removeServerRecord(recordFile, app.port);
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
  process.on('uncaughtException', (e) => {
    serverLogger.log('uncaught', { message: e && e.message, stack: e && e.stack });
    console.error(e);
    shutdown(1, 'uncaughtException');
  });
  process.on('unhandledRejection', (e) => {
    serverLogger.log('unhandled-rejection', { message: e && e.message });
    console.error(e);
    shutdown(1, 'unhandledRejection');
  });

  // The URL carries the token on purpose: it is printed and opened, and never logged. The fragment opens the
  // start folder's project: the new-chat screen preset to it, or its Setup wizard when it has no Shipline yet.
  const url = `http://127.0.0.1:${app.port}/?t=${app.auth.token}#/${repo ? 'new' : 'setup'}/${repoId}`;
  if (!repo) {
    console.log(`Shipline setup for ${app.projects.peek(repoId).install.root}`);
    console.log('Nothing is written until you press Install in the browser.');
  } else console.log(`Shipline UI for ${repo.root}`);
  console.log(url);
  if (remote) {
    if (!repo && readRegistry().projects.length === 0) {
      console.log(
        'Phone access needs an installed repo, so it is off. Install Shipline here first.',
      );
    } else {
      const status = await app.remote.start();
      if (status.enabled) {
        console.log(`Phone access: ${status.url}`);
        console.log('Open Setup > Phone access in the UI to pair a phone.');
      } else console.log(`Phone access is off: ${status.tailscale.message}`);
    }
  }
  console.log('Press Ctrl+C to stop.');
  if (open) openBrowser(url);

  return { port: app.port, url, repoId, close: () => shutdown(0, 'close') };
}
