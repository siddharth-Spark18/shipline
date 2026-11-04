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
import { HttpError, parseJsonBody, readBody, sendError, sendJson } from './http.mjs';
import { initLog, log } from './log.mjs';
import { openBrowser } from './open-browser.mjs';
import { createPrompts } from './prompts.mjs';
import { resolveRepo } from './repo.mjs';
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

// Every repo older than interface 3 still has its tasks and state inside the repo.
const UPGRADE_TEXT =
  'Task data is still stored in this repo. Run `npx @forgeyard/shipline upgrade` to move it to ~/.shipline.';

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ui [dir] [--port <n>] [--no-open]. The first argument that isn't a flag or a flag's value is `dir`.
export function parseUiArgs(argv) {
  let dir = null;
  let port = 0;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') open = false;
    else if (a === '--port' || a.startsWith('--port=')) {
      const value = a === '--port' ? argv[++i] : a.slice('--port='.length);
      if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) {
        fail('--port needs a number from 0 to 65535.');
      }
      port = Number(value);
    } else if (a.startsWith('-'))
      fail(`Unknown option ${a}. Usage: npx @forgeyard/shipline ui [dir] [--port <n>] [--no-open]`);
    else if (dir === null) dir = a;
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

export async function startServer({ dir, port = 0, open = true } = {}) {
  let repo;
  try {
    repo = await resolveRepo(dir);
  } catch (e) {
    if (e.code === 'NO_REPO')
      fail('No Shipline setup found here. Run `npx @forgeyard/shipline init` first.');
    fail(`Could not load the repo's .shipline/bin/lib.mjs: ${e.message}`);
  }
  try {
    storeDir(repo.root);
  } catch (e) {
    fail(e.message);
  }
  initLog(repo.root);
  log('start', { root: repo.root, uiVersion: UI_VERSION, node: process.version });
  log('version', { repo: repo.version, ui: INTERFACE, state: repo.state });

  const hub = createHub();
  const banners = new Map();
  const app = {
    repo,
    hub,
    uiVersion: UI_VERSION,
    port: null,
    auth: null,
    watch: null,
    prompts: null,
    chats: null,
    addBanner(banner) {
      banners.set(banner.id, banner);
      hub.send('banner', banner);
    },
  };
  hub.onConnect((reply) => {
    for (const b of banners.values()) reply('banner', b);
  });
  if (repo.state === 'repo-older') {
    banners.set('version', {
      id: 'version',
      kind: 'version',
      text: UPGRADE_TEXT,
    });
  } else if (repo.state === 'repo-newer') {
    const v = repo.version.package || 'latest';
    banners.set('version', {
      id: 'version',
      kind: 'version',
      text: `This repo was set up with Shipline ${v}. Run \`npx @forgeyard/shipline@${v} ui\`.`,
    });
  }

  app.prompts = createPrompts(app);
  app.chats = createChats(app);

  const table = [
    ...diagnosticsRoutes(app),
    ...app.prompts.routes(),
    ...chatRoutes(app),
    ...setupRoutes(app),
    ...taskRoutes(app),
    { method: 'GET', path: '/api/events', handler: ({ req, res }) => hub.connect(req, res) },
  ];

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
      // Routes may have :params (for example /api/chats/:id); an exact path matches first.
      const matches = [];
      for (const r of table) {
        const params = matchPath(r.path, pathname);
        if (params) matches.push({ ...r, params });
      }
      const route = matches.find((r) => r.method === req.method);
      if (!route) {
        if (isApi && matches.length)
          throw new HttpError(405, 'method-not-allowed', 'Method not allowed');
        throw new HttpError(404, 'not-found', 'Not found');
      }
      const body = req.method === 'POST' ? parseJsonBody(await readBody(req)) : undefined;
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

  // Started modules, closed in reverse order.
  const closers = [{ name: 'hub', close: () => hub.close() }];
  app.watch = await startTaskWatch(app);
  closers.push({ name: 'watch', close: () => app.watch.close() });
  closers.push({
    name: 'http',
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });

  // After http, so shutdown stops the claude process group and releases the lock before the server closes.
  closers.push({ name: 'chats', close: () => app.chats.close() });

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
  console.log(`Shipline UI for ${repo.root}`);
  console.log(url);
  console.log('Press Ctrl+C to stop.');
  if (open) openBrowser(url);

  return { port: app.port, url, close: () => shutdown(0, 'close') };
}
