import crypto from 'crypto';
import http from 'http';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  DiffMode,
  LocalConfigDTO,
  LocalHelloDTO,
  LocalPairRequestDTO,
  LocalPairResponseDTO,
  LocalProjectDTO,
  LocalProjectSetupDTO,
  LocalStatusDTO,
  SessionMessage,
} from '@shipline/shared';
import { ApiError, apiJson } from './api-client';
import { AssetError, readAsset, readAssetMeta } from './assets';
import { claudeHealth, ghInstalled } from './claude-cli';
import { getConfig, saveConfig } from './config';
import { diffFile, diffSummary } from './diff';
import { mcpProxyRouter } from './mcp-proxy';
import { getPairingCode, isValidToken, pair, pairedBrowserCount, regeneratePairingCode, revokeAllTokens, revokeToken } from './pairing';
import { readAppVersion, readPluginVersion } from './paths';
import { cloneWorkingCopy } from './repo';
import { completeLogin, isSignedIn, logout, startLogin } from './shipline-auth';
import {
  StageMarker,
  StartError,
  getSession,
  listSessions,
  resolvePrompt,
  sendMarkerMessage,
  sendUserMessage,
  startSession,
  stopAllSessions,
  stopSession,
} from './session-manager';

export const DEFAULT_PORT = 4777;
const WS_TOKEN_PREFIX = 'shipline-token.';

export interface LocalServer {
  port: number;
  hubUrl: string;
  /** The one-time code the browser enters to pair. */
  pairingCode: () => string;
  regeneratePairingCode: () => string;
  pairedBrowsers: () => number;
  revokeAllPairings: () => void;
  isSignedIn: () => boolean;
  activeSessionCount: () => number;
  close: () => Promise<void>;
}

export async function startLocalServer(opts: { port?: number } = {}): Promise<LocalServer> {
  const hubOrigin = new URL(getConfig().hubUrl).origin;
  let port = 0;
  const app = express();

  const allowedHosts = (): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

  // DNS-rebinding guard: only loopback host names are served.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!allowedHosts().includes(req.headers.host ?? '')) {
      res.status(403).send('Forbidden host');
      return;
    }
    next();
  });

  // Claude -> loopback MCP proxy authenticates with its own per-session secret.
  app.use('/mcp-proxy', mcpProxyRouter);

  // The browser lands here after Google SSO on the hub (this service signing in to the hub);
  // `state` ties it to a login this app started. Then it goes back to the hub UI.
  app.get('/auth/callback', async (req, res) => {
    const ok = await completeLogin(String(req.query.code ?? ''), String(req.query.state ?? '')).catch(() => false);
    res.redirect(`${getConfig().hubUrl}/?local=${ok ? 'signed-in' : 'signin-failed'}`);
  });

  // Strict CORS: only the hub origin. Chrome's Private Network Access preflight is answered too.
  // OPEN-QUESTION #2: an HTTPS hub calling http://127.0.0.1 must be verified in Chrome and Safari;
  // the fallback is a tray-opened hub deep link.
  const cors = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      if (origin !== hubOrigin) {
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', hubOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shipline-Local-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };

  // Every API call and WebSocket needs the pairing token: this service spawns processes.
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.headers['x-shipline-local-token'];
    if (typeof supplied !== 'string' || !isValidToken(supplied)) {
      res.status(401).json({ error: 'Not paired with this browser. Enter the pairing code from the Shipline tray.', code: 'NOT_PAIRED' });
      return;
    }
    next();
  };

  const api = express.Router();
  wrapAsync(api);
  api.use(cors);
  api.use(express.json());

  // --- Public (no token) ---

  api.get('/hello', (_req, res) => {
    const body: LocalHelloDTO = { service: 'shipline-local', appVersion: readAppVersion(), pluginVersion: readPluginVersion() };
    res.json(body);
  });

  api.post('/pair', (req, res) => {
    const { code } = req.body as Partial<LocalPairRequestDTO>;
    const token = typeof code === 'string' ? pair(code) : null;
    if (!token) {
      res.status(401).json({ error: 'That pairing code is not valid. Read the current one from the Shipline tray.', code: 'BAD_CODE' });
      return;
    }
    const body: LocalPairResponseDTO = { token };
    res.json(body);
  });

  // --- Everything below needs the token ---
  api.use(guard);

  api.post('/unpair', (req, res) => {
    revokeToken(String(req.headers['x-shipline-local-token']));
    res.status(204).end();
  });

  api.get('/status', async (_req, res) => {
    const signedIn = isSignedIn();
    let minClaude: string | null = null;
    if (signedIn) {
      minClaude = await apiJson<LocalConfigDTO>('/api/local/config').then((c) => c.minClaudeCliVersion).catch(() => null);
    }
    const body: LocalStatusDTO = {
      signedIn,
      apiUrl: getConfig().apiUrl,
      appVersion: readAppVersion(),
      pluginVersion: readPluginVersion(),
      claude: await claudeHealth(minClaude),
      ghInstalled: await ghInstalled(),
    };
    res.json(body);
  });

  api.post('/auth/login', (_req, res) => {
    res.json({ url: startLogin(port) });
  });
  api.post('/auth/logout', (_req, res) => {
    logout();
    res.status(204).end();
  });

  api.get('/projects', async (_req, res) => {
    const projects = await apiJson<LocalProjectDTO[]>('/api/local/projects');
    const cfg = getConfig();
    const rows: LocalProjectSetupDTO[] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      githubRepo: p.githubRepo,
      sessionMode: p.sessionMode,
      localPath: cfg.projectPaths[p.id] ?? null,
      localSessionMode: cfg.sessionModes[p.id] ?? null,
    }));
    res.json(rows);
  });

  api.put('/projects/:id/path', (req, res) => {
    const p = String((req.body as { path?: string }).path ?? '').trim();
    if (!p || !path.isAbsolute(p)) {
      res.status(400).json({ error: 'An absolute path is required' });
      return;
    }
    saveConfig({ projectPaths: { ...getConfig().projectPaths, [req.params.id]: p } });
    res.status(204).end();
  });

  api.post('/projects/:id/clone', async (req, res) => {
    const { path: target, githubRepo } = req.body as { path?: string; githubRepo?: string };
    if (!target || !path.isAbsolute(target) || !githubRepo) {
      res.status(400).json({ error: 'path (absolute) and githubRepo are required' });
      return;
    }
    // The repo must belong to a project the user is on.
    const projects = await apiJson<LocalProjectDTO[]>('/api/local/projects');
    if (!projects.some((p) => p.id === req.params.id && p.githubRepo === githubRepo)) {
      res.status(403).json({ error: 'Not a registered Shipline project repo' });
      return;
    }
    await cloneWorkingCopy(githubRepo, target);
    saveConfig({ projectPaths: { ...getConfig().projectPaths, [req.params.id]: target } });
    res.status(204).end();
  });

  api.put('/projects/:id/session-mode', (req, res) => {
    const mode = (req.body as { mode?: string }).mode;
    const modes = { ...getConfig().sessionModes };
    if (mode === 'chat' || mode === 'terminal') modes[req.params.id] = mode;
    else delete modes[req.params.id];
    saveConfig({ sessionModes: modes });
    res.status(204).end();
  });

  // --- Sessions: one per chat ---

  api.get('/sessions', (_req, res) => {
    res.json(listSessions());
  });

  api.post('/sessions/:ticketId/start', async (req, res) => {
    const { mode, firstMessage } = req.body as { mode?: string; firstMessage?: string };
    try {
      const s = await startSession(
        req.params.ticketId,
        port,
        mode === 'chat' || mode === 'terminal' ? mode : undefined,
        firstMessage?.trim() || undefined,
      );
      res.json({ ticketId: s.ticketId, mode: s.mode });
    } catch (err) {
      if (err instanceof StartError) {
        res.status(409).json({ error: err.message, code: err.code, guidance: err.guidance });
        return;
      }
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  api.post('/sessions/:ticketId/stop', (req, res) => {
    stopSession(req.params.ticketId);
    res.status(204).end();
  });

  // The browser posts stage-change markers, "Not yet" notices and PR comments into the conversation.
  api.post('/sessions/:ticketId/message', (req, res) => {
    const b = req.body as { text?: string; marker?: StageMarker };
    if (!b.text?.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const ok = b.marker
      ? sendMarkerMessage(req.params.ticketId, b.text, b.marker)
      : sendUserMessage(req.params.ticketId, b.text);
    if (!ok) {
      res.status(409).json({ error: 'No running session for this chat', code: 'NO_SESSION' });
      return;
    }
    res.status(204).end();
  });

  api.post('/sessions/:ticketId/tool-decisions/:id/resolve', async (req, res) => {
    const { allow, answers } = req.body as { allow?: boolean; answers?: Record<string, string> };
    await resolvePrompt(req.params.ticketId, req.params.id, !!allow, answers);
    res.status(204).end();
  });

  // --- Diff and assets (read from the ticket's worktree; works after a restart too) ---

  const workspaceOf = (ticketId: string, res: Response) => {
    const w = getConfig().workspaces[ticketId];
    if (!w) res.status(404).json({ error: 'No worktree for this chat yet. Start the chat first.', code: 'NO_WORKTREE' });
    return w;
  };
  const modeOf = (value: unknown): DiffMode => (value === 'uncommitted' ? 'uncommitted' : 'branch');

  api.get('/sessions/:ticketId/diff', async (req, res) => {
    const w = workspaceOf(req.params.ticketId, res);
    if (!w) return;
    res.json(await diffSummary(w.worktreePath, w.baseBranch, modeOf(req.query.mode)));
  });

  api.get('/sessions/:ticketId/diff/file', async (req, res) => {
    const w = workspaceOf(req.params.ticketId, res);
    if (!w) return;
    const file = String(req.query.path ?? '');
    if (!file) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const oldPath = typeof req.query.oldPath === 'string' && req.query.oldPath ? req.query.oldPath : null;
    res.json(await diffFile(w.worktreePath, w.baseBranch, modeOf(req.query.mode), file, oldPath, req.query.full === '1'));
  });

  api.get('/sessions/:ticketId/asset', (req, res) => {
    const w = workspaceOf(req.params.ticketId, res);
    if (!w) return;
    const file = String(req.query.path ?? '');
    if (!file) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    res.json(req.query.meta === '1' ? readAssetMeta(w.worktreePath, file) : readAsset(w.worktreePath, file));
  });

  app.use('/api', api, (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError || err instanceof AssetError) {
      res.status(err.status).json({ error: err.message, code: err instanceof ApiError ? err.code : undefined });
      return;
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    // The token travels as a subprotocol (browsers cannot set headers on WebSockets); echo it back.
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .find((p) => p.startsWith(WS_TOKEN_PREFIX));
    const origin = req.headers.origin;
    const ok =
      url.pathname === '/ws' &&
      allowedHosts().includes(req.headers.host ?? '') &&
      !!protocol &&
      isValidToken(protocol.slice(WS_TOKEN_PREFIX.length)) &&
      (!origin || origin === hubOrigin);
    if (!ok) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachSession(ws, url.searchParams.get('ticketId') ?? ''));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;

  return {
    port,
    hubUrl: getConfig().hubUrl,
    pairingCode: getPairingCode,
    regeneratePairingCode,
    pairedBrowsers: pairedBrowserCount,
    revokeAllPairings: revokeAllTokens,
    isSignedIn,
    activeSessionCount: () => listSessions().length,
    close: () =>
      new Promise((resolve) => {
        stopAllSessions();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function attachSession(ws: WebSocket, ticketId: string): void {
  const session = getSession(ticketId);
  if (!session) {
    ws.close(4404, 'No active session');
    return;
  }
  const send = (msg: SessionMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  // Replay so navigating away and back (or a second tab) shows the whole conversation.
  session.history.forEach(send);
  send({ kind: 'state', state: session.state });
  session.emitter.on('message', send);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as
        | { kind: 'user'; text: string }
        | { kind: 'pty-input'; data: string }
        | { kind: 'resize'; cols: number; rows: number };
      if (msg.kind === 'user' && session.chat) sendUserMessage(ticketId, msg.text);
      else if (msg.kind === 'pty-input') session.terminal?.write(msg.data);
      else if (msg.kind === 'resize') session.terminal?.resize(msg.cols, msg.rows);
    } catch {
      // Ignore malformed client frames.
    }
  });
  ws.on('close', () => session.emitter.off('message', send));
}

// Express 4 does not forward rejected promises from async handlers; route them to the error handler.
function wrapAsync(router: express.Router): void {
  for (const method of ['get', 'post', 'put', 'delete'] as const) {
    const original = router[method].bind(router) as (path: string, ...handlers: unknown[]) => unknown;
    (router as unknown as Record<string, unknown>)[method] = (path: string, ...handlers: Array<(...a: unknown[]) => unknown>) =>
      original(
        path,
        ...handlers.map((h) => (req: Request, res: Response, next: NextFunction) => {
          try {
            Promise.resolve(h(req, res, next)).catch(next);
          } catch (err) {
            next(err);
          }
        }),
      );
  }
}
