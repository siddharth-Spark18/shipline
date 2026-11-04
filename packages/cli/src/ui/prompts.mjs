// Pending permission prompts, the relay endpoint and the per-spawn MCP config. The relay applies no policy:
// hooks run before the permission prompt, so a `block` denial never gets here. Node 20+, no dependencies.
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from './auth.mjs';
import { HttpError } from './http.mjs';
import { log } from './log.mjs';
import { uiStateDir } from './sessions.mjs';

// How long a prompt waits for the developer. 600 000 ms by default.
// UNVERIFIED (chat test Q5): claude itself lets a permission-prompt call wait this long. If the test records a
// shorter limit, set this to that limit minus 30 s (see claude.mjs MCP_TOOL_TIMEOUT_ENV).
export const PROMPT_TIMEOUT_MS = 600_000;

export const DENY_MESSAGE = 'Denied by the developer in Shipline UI';
// UNVERIFIED (chat test Q3): AskUserQuestion arrives here and is answered through updatedInput.answers.
export const ASK_USER_QUESTION = 'AskUserQuestion';
const MCP_SERVER_NAME = 'shipline_ui';
const RELAY_PATH = fileURLToPath(new URL('./relay.mjs', import.meta.url));

export const timeoutMessage = (ms) => `No answer within ${Number((ms / 60_000).toFixed(2))} minutes`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createPrompts(app) {
  const timeoutMs = (() => {
    const n = Number(process.env.SHIPLINE_UI_PROMPT_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : PROMPT_TIMEOUT_MS;
  })();
  const root = app.repo.root;
  const pending = new Map(); // id -> prompt
  const secrets = new Map(); // chatId -> this spawn's secret
  const denied = []; // prompts the developer denied on a card, for the "You denied" notice

  const view = (p) => ({
    id: p.id,
    chatId: p.chatId,
    tool: p.tool,
    input: p.input,
    expiresAt: p.expiresAt,
  });

  // Pending prompts are sent again on every SSE connect, so reloading the tab doesn't lose them.
  app.hub.onConnect((reply) => {
    for (const p of pending.values()) reply('prompt', view(p));
  });

  function settle(p, outcome, answer) {
    if (!pending.delete(p.id)) return;
    clearTimeout(p.timer);
    if (outcome === 'deny' && p.byUser) {
      denied.push({ chatId: p.chatId, toolUseId: p.toolUseId, tool: p.tool, used: false });
      if (denied.length > 200) denied.shift();
    }
    log('prompt-resolved', { id: p.id, chatId: p.chatId, tool: p.tool, outcome });
    p.resolve(answer);
    app.hub.send('prompt-resolved', { id: p.id, outcome });
  }

  function chatForSecret(supplied) {
    for (const [chatId, secret] of secrets) if (safeEqual(supplied, secret)) return chatId;
    return null;
  }

  function relayHandler({ req, res, body }) {
    // Defence in depth: auth.check has already refused any Origin.
    if (req.headers.origin !== undefined)
      throw new HttpError(403, 'bad-origin', 'Origin not allowed');
    const supplied = req.headers['x-shipline-relay'];
    const chatId = typeof supplied === 'string' && supplied ? chatForSecret(supplied) : null;
    if (!chatId) throw new HttpError(403, 'bad-secret', 'Wrong relay secret');
    if (!isObject(body) || typeof body.tool_name !== 'string' || !body.tool_name)
      throw new HttpError(400, 'bad-request', 'tool_name is required');
    if (body.input !== undefined && !isObject(body.input))
      throw new HttpError(400, 'bad-request', 'input must be an object');
    if (body.tool_use_id !== undefined && typeof body.tool_use_id !== 'string')
      throw new HttpError(400, 'bad-request', 'tool_use_id must be a string');

    return new Promise((resolve) => {
      const p = {
        id: crypto.randomUUID(),
        chatId,
        tool: body.tool_name,
        input: body.input || {},
        toolUseId: body.tool_use_id || null,
        expiresAt: Date.now() + timeoutMs,
        byUser: false,
        resolve,
        timer: null,
      };
      p.timer = setTimeout(
        () => settle(p, 'timeout', { behavior: 'deny', message: timeoutMessage(timeoutMs) }),
        timeoutMs,
      );
      pending.set(p.id, p);
      log('prompt', { id: p.id, chatId, tool: p.tool, toolUseId: p.toolUseId });
      if (app.hub.size() === 0)
        console.log(
          `Shipline UI: Claude is waiting for a permission answer (${p.tool}). Open the UI to answer.`,
        );
      app.hub.send('prompt', view(p));
      // The relay went away (claude was killed): drop the card.
      res.on('close', () =>
        settle(p, 'deny', { behavior: 'deny', message: 'The request was cancelled' }),
      );
    });
  }

  function answerHandler({ params, body }) {
    const p = pending.get(params.id);
    if (!p) throw new HttpError(404, 'not-found', 'No such prompt, or it is already resolved');
    if (!isObject(body) || (body.decision !== 'allow' && body.decision !== 'deny'))
      throw new HttpError(400, 'bad-request', 'decision must be "allow" or "deny"');
    if (body.answers !== undefined && !isObject(body.answers))
      throw new HttpError(400, 'bad-request', 'answers must be an object');
    if (body.decision === 'allow') {
      const updatedInput =
        p.tool === ASK_USER_QUESTION && body.answers
          ? { ...p.input, answers: body.answers }
          : p.input;
      settle(p, 'allow', { behavior: 'allow', updatedInput });
    } else {
      p.byUser = true;
      settle(p, 'deny', { behavior: 'deny', message: DENY_MESSAGE });
    }
    return { ok: true };
  }

  return {
    timeoutMs,
    pendingCount: () => pending.size,

    routes: () => [
      { method: 'POST', path: '/api/relay', handler: relayHandler },
      { method: 'POST', path: '/api/prompts/:id', handler: answerHandler },
    ],

    // Makes a new secret for this spawn and writes <state>/ui/mcp-<uuid>.json (mode 0600). The secret is only
    // in that file's env, which goes to the relay process, not in claude's own environment.
    writeMcpConfig(sessionId, port) {
      const mcpJson = path.join(root, '.mcp.json');
      if (existsSync(mcpJson)) {
        let defined = false;
        try {
          const j = JSON.parse(readFileSync(mcpJson, 'utf8'));
          defined = !!(j && j.mcpServers && MCP_SERVER_NAME in j.mcpServers);
        } catch {
          // An unreadable .mcp.json can't collide.
        }
        if (defined)
          throw new HttpError(
            409,
            'mcp-name-collision',
            `This repo's .mcp.json already defines an MCP server named "${MCP_SERVER_NAME}". Rename it, then start the chat again.`,
          );
      }
      const secret = crypto.randomBytes(32).toString('hex');
      const file = path.join(uiStateDir(root), `mcp-${sessionId}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
      const config = {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: process.execPath,
            args: [RELAY_PATH],
            env: {
              SHIPLINE_UI_RELAY_URL: `http://127.0.0.1:${port}/api/relay`,
              SHIPLINE_UI_RELAY_SECRET: secret,
            },
          },
        },
      };
      writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      secrets.set(sessionId, secret);
      return file;
    },

    // Forgets the secret and deletes the config file (it holds the secret).
    removeMcpConfig(sessionId) {
      secrets.delete(sessionId);
      try {
        unlinkSync(path.join(uiStateDir(root), `mcp-${sessionId}.json`));
      } catch {
        // Already gone.
      }
    },

    // stop() calls this: every pending prompt of the chat is denied.
    denyAll(chatId) {
      for (const p of [...pending.values()]) {
        if (p.chatId === chatId)
          settle(p, 'deny', { behavior: 'deny', message: 'The chat was stopped' });
      }
    },

    // A tool result for a call the developer denied on a card: matched by tool_use_id, or, when the prompt had
    // none, to the most recent denied prompt for the same tool name. Each denial matches once.
    takeDenied(chatId, toolUseId, toolName) {
      let hit = denied.find((d) => !d.used && d.chatId === chatId && d.toolUseId && d.toolUseId === toolUseId);
      if (!hit && toolName) {
        for (let i = denied.length - 1; i >= 0; i--) {
          const d = denied[i];
          if (!d.used && d.chatId === chatId && !d.toolUseId && d.tool === toolName) {
            hit = d;
            break;
          }
        }
      }
      if (hit) hit.used = true;
      return !!hit;
    },
  };
}
