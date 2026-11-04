// Chat API handlers: GET/POST /api/chats, GET /api/chats/<id>, and <id>/message, /stop, /continue.
// Node 20+, no dependencies.
import { MIN_CLAUDE_VERSION, claudeHealth } from './claude.mjs';
import { HttpError } from './http.mjs';
import { getChat, listChats, readLock } from './sessions.mjs';
import { readHistory } from './transcript.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A chat counts as active only when this server runs it, or another live server's lock names it.
function withStatus(app, chat) {
  if (chat.status !== 'active') return chat;
  const lock = readLock(app.repo.root);
  const live = app.chats.activeId() === chat.id || (lock && lock.session_id === chat.id);
  return live ? chat : { ...chat, status: 'ended' };
}

function requireChat(app, id) {
  const chat = UUID.test(id) ? getChat(app.repo.root, id) : null;
  if (!chat) throw new HttpError(404, 'not-found', 'No such chat');
  return chat;
}

// 412 claude-missing / claude-too-old / claude-signed-out, with the matching notice.
async function requireClaude() {
  const h = await claudeHealth(MIN_CLAUDE_VERSION);
  if (!h.installed) throw new HttpError(412, 'claude-missing', h.guidance);
  if (!h.meetsMinVersion) throw new HttpError(412, 'claude-too-old', h.guidance, { version: h.version, minVersion: h.minVersion });
  if (!h.loggedIn) throw new HttpError(412, 'claude-signed-out', h.guidance);
  return h;
}

export function routes(app) {
  const root = app.repo.root;

  const preflight = async () => {
    app.repo.requireWritable();
    const activeId = app.chats.activeId();
    if (activeId)
      throw new HttpError(409, 'chat-active', 'A chat is already active here.', { chatId: activeId });
    return requireClaude();
  };

  return [
    {
      method: 'GET',
      path: '/api/chats',
      handler: () => ({
        chats: listChats(root)
          .map((c) => withStatus(app, c))
          .sort((a, b) => String(b.last_active).localeCompare(String(a.last_active))),
      }),
    },
    {
      method: 'POST',
      path: '/api/chats',
      handler: async ({ body }) => {
        if (!body || typeof body.message !== 'string' || !body.message.trim())
          throw new HttpError(400, 'bad-request', 'message is required');
        const health = await preflight();
        const id = await app.chats.start({ message: body.message, claudeVersion: health.version });
        return { id };
      },
    },
    {
      method: 'GET',
      path: '/api/chats/:id',
      handler: ({ params }) => {
        const chat = withStatus(app, requireChat(app, params.id));
        const h = readHistory(root, chat.id);
        return h.unavailable ? { chat, history: null, unavailable: true } : { chat, history: h.history };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/message',
      handler: ({ params, body }) => {
        requireChat(app, params.id);
        if (!body || typeof body.text !== 'string' || !body.text.trim())
          throw new HttpError(400, 'bad-request', 'text is required');
        app.chats.send(params.id, body.text);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/stop',
      handler: async ({ params }) => {
        requireChat(app, params.id);
        await app.chats.stop(params.id);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/continue',
      handler: async ({ params }) => {
        requireChat(app, params.id);
        const health = await preflight();
        await app.chats.resume({ id: params.id, claudeVersion: health.version });
        return { ok: true };
      },
    },
  ];
}
