// Pending permission prompts, the relay endpoint and the per-spawn MCP config. The relay applies no policy:
// hooks run before the permission prompt, so a `block` denial never gets here. Node 20+, no dependencies.
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from './auth.mjs';
import { HttpError } from './http.mjs';
import { appendAllowRule, ruleFor, splitRule } from './local-settings.mjs';
import { log } from './log.mjs';
import { uiStateDir } from './sessions.mjs';

// How long a prompt waits for the developer: 25 minutes.
// Checked in the claude 2.1.331 binary (not with a live 30-minute call): a stdio MCP server's tool call has no
// wall-clock limit but MCP_TOOL_TIMEOUT (default about 28 hours; claude.mjs sets it above this), and the call is also
// cut after a stdio idle timeout of 30 minutes (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT). The relay sends nothing while it
// waits, so the wait stays well under 30 minutes.
export const PROMPT_TIMEOUT_MS = 1_500_000;

// Claude Code reads `updatedPermissions` in a permission-prompt tool's allow answer (2.1.331: the answer's schema has
// `updatedPermissions: PermissionUpdate[]`, an `addRules` entry with destination `session` lasts for the chat's
// session). Checked in the binary, not with a live call; if a Claude Code ever stops honouring it, set this to false and
// the cards stop offering "Allow for this chat".
export const ALLOW_FOR_CHAT_SUPPORTED = true;

const REASON_LIMIT = 2000;

export const DENY_MESSAGE = 'Denied by the developer in Shipline UI';
// Verified 2026-11-04 (claude 2.1.317): AskUserQuestion arrives here and is answered through updatedInput.answers.
export const ASK_USER_QUESTION = 'AskUserQuestion';
const MCP_SERVER_NAME = 'shipline_ui';
const RELAY_PATH = fileURLToPath(new URL('./relay.mjs', import.meta.url));

export const timeoutMessage = (ms) =>
  `No answer within ${Number((ms / 60_000).toFixed(2))} minutes`;

const DECISIONS = ['allow', 'allow_chat', 'allow_repo', 'deny'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The timeout from SHIPLINE_UI_PROMPT_TIMEOUT_MS (a test override), or the default. The server reads it once when it
// starts, because repo contexts are created lazily, long after the environment it was started in may have changed.
export function promptTimeoutFromEnv() {
  const n = Number(process.env.SHIPLINE_UI_PROMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : PROMPT_TIMEOUT_MS;
}

export function createPrompts(app) {
  const timeoutMs = app.promptTimeoutMs || promptTimeoutFromEnv();
  const root = app.repo.root;
  const pending = new Map(); // id -> prompt
  const secrets = new Map(); // chatId -> this spawn's secret
  const denied = []; // prompts the developer denied on a card, for the "You denied" notice

  // `rule` is what "Allow for this chat" and "Always allow in this repo" would remember (null: not offered).
  const view = (p) => ({
    id: p.id,
    chatId: p.chatId,
    tool: p.tool,
    input: p.input,
    expiresAt: p.expiresAt,
    allowForChat: ALLOW_FOR_CHAT_SUPPORTED,
    rule: ruleFor(p.tool, p.input),
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
    if (app.changed) app.changed();
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
      if (app.changed) app.changed();
      // The relay went away (claude was killed): drop the card.
      res.on('close', () =>
        settle(p, 'deny', { behavior: 'deny', message: 'The request was cancelled' }),
      );
    });
  }

  function answerHandler({ params, body }) {
    const p = pending.get(params.id);
    if (!p) throw new HttpError(404, 'not-found', 'No such prompt, or it is already resolved');
    if (!isObject(body) || !DECISIONS.includes(body.decision))
      throw new HttpError(
        400,
        'bad-request',
        'decision must be "allow", "allow_chat", "allow_repo" or "deny"',
      );
    if (body.answers !== undefined && !isObject(body.answers))
      throw new HttpError(400, 'bad-request', 'answers must be an object');
    if (body.message !== undefined && typeof body.message !== 'string')
      throw new HttpError(400, 'bad-request', 'message must be a string');
    if (body.decision === 'deny') {
      p.byUser = true;
      const reason = (body.message || '').trim().slice(0, REASON_LIMIT);
      settle(p, 'deny', { behavior: 'deny', message: reason || DENY_MESSAGE });
      return { ok: true };
    }
    const updatedInput =
      p.tool === ASK_USER_QUESTION && body.answers
        ? { ...p.input, answers: body.answers }
        : p.input;
    const answer = { behavior: 'allow', updatedInput };
    if (body.decision !== 'allow') {
      const rule = ruleFor(p.tool, p.input);
      if (!rule)
        throw new HttpError(
          400,
          'no-rule',
          'There is no permission rule to remember for this call.',
        );
      if (body.decision === 'allow_chat' && !ALLOW_FOR_CHAT_SUPPORTED)
        throw new HttpError(
          400,
          'not-supported',
          'This Claude Code cannot allow a tool for one chat.',
        );
      // Repo first: when the file can't be written the error goes back and the prompt stays pending.
      if (body.decision === 'allow_repo') appendAllowRule(root, rule);
      if (ALLOW_FOR_CHAT_SUPPORTED)
        answer.updatedPermissions = [
          { type: 'addRules', rules: [splitRule(rule)], behavior: 'allow', destination: 'session' },
        ];
    }
    settle(p, 'allow', answer);
    return { ok: true };
  }

  return {
    timeoutMs,
    pendingCount: () => pending.size,

    // The views of one chat's pending prompts (what a reconnecting tab needs).
    pendingFor: (chatId) => [...pending.values()].filter((p) => p.chatId === chatId).map(view),

    // What waits for the developer, for the project switcher's badge: [{ chatId, reason }] where the reason is
    // 'question' (AskUserQuestion, which also carries the stage confirmations) or 'permission'.
    waiting: () =>
      [...pending.values()].map((p) => ({
        chatId: p.chatId,
        reason: p.tool === ASK_USER_QUESTION ? 'question' : 'permission',
      })),

    routes: () => [
      // Served at /api/repos/:repoId/relay (the repo id is in the URL the MCP config gives the relay).
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
              SHIPLINE_UI_RELAY_URL: `http://127.0.0.1:${port}/api/repos/${app.id}/relay`,
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
      let hit = denied.find(
        (d) => !d.used && d.chatId === chatId && d.toolUseId && d.toolUseId === toolUseId,
      );
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
