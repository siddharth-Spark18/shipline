// Chat API handlers (served under /api/repos/:repoId): GET/POST /api/chats, GET /api/chats/<id>, <id>/message, /stop, /interrupt, /kill, /continue,
// <id>/events (catch-up and older entries), <id>/images/<ref>, <id>/queue (PUT, DELETE), plus
// /api/chat/commands, /api/chat/controls and /api/trust.
// Node 20+, no dependencies.
import { MIN_CLAUDE_VERSION, claudeHealth } from './claude.mjs';
import { listCommands } from './commands.mjs';
import { readDefaults, validateControls } from './controls.mjs';
import { HttpError, MAX_IMAGE_BODY } from './http.mjs';
import { getChat, listChats, liveLock } from './sessions.mjs';
import { startShell, stopRun } from './shell.mjs';
import { sameStage } from '../../templates/shipline/bin/lib.mjs';
import { chatTasks } from './tasks.mjs';
import { ticketStatus } from './tracker.mjs';
import { trustRepo } from './trust.mjs';
import { DEFAULT_PAGE } from './chat-log.mjs';
import { readTranscriptImage } from './transcript.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const badImage = (reason) => new HttpError(400, 'bad-image', reason);

// `images` from a request body -> [{ media_type, data }] (empty when absent). Throws 400 bad-image.
function parseImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw badImage('images must be a list');
  if (images.length > MAX_IMAGES) throw badImage(`At most ${MAX_IMAGES} images per message`);
  return images.map((img, n) => {
    const at = `Image ${n + 1}`;
    if (!img || typeof img !== 'object') throw badImage(`${at}: not an image`);
    if (!IMAGE_TYPES.has(img.media_type))
      throw badImage(`${at}: only PNG, JPEG, GIF or WebP images are accepted`);
    const data = img.data;
    if (typeof data !== 'string' || !data || data.length % 4 !== 0 || !BASE64.test(data))
      throw badImage(`${at}: data must be base64 with no data: prefix`);
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if ((data.length / 4) * 3 - pad > MAX_IMAGE_BYTES) throw badImage(`${at}: larger than 5 MB`);
    return { media_type: img.media_type, data };
  });
}

const PAGE_MAX = 1000;

// ?limit=: a positive integer up to PAGE_MAX, default 200.
function pageLimit(url) {
  const raw = url && url.searchParams.get('limit');
  if (raw === null || raw === undefined) return DEFAULT_PAGE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new HttpError(400, 'bad-request', 'limit must be a positive integer');
  return Math.min(n, PAGE_MAX);
}

// ?name= as a non-negative integer, or undefined when absent. 400 when it is not one.
function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (raw === '' || !Number.isInteger(n) || n < 0)
    throw new HttpError(400, 'bad-request', `${name} must be a non-negative integer`);
  return n;
}

// A chat counts as active only when this server runs it, or another live server's lock names it.
// A lock left by a server that exited without releasing it is ignored, or the chat would show as
// active forever while every message to it fails with chat-ended.
function withStatus(app, chat) {
  if (chat.status !== 'active') return { ...chat, busy: false, busySince: null };
  const lock = liveLock(app.repo.root, app.port);
  const live = app.chats.activeId() === chat.id || (lock && lock.session_id === chat.id);
  if (!live) return { ...chat, status: 'ended', busy: false, busySince: null };
  return { ...chat, ...app.chats.busyInfo(chat.id) };
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
  if (!h.meetsMinVersion)
    throw new HttpError(412, 'claude-too-old', h.guidance, {
      version: h.version,
      minVersion: h.minVersion,
    });
  if (!h.loggedIn) throw new HttpError(412, 'claude-signed-out', h.guidance);
  return h;
}

export function routes(app) {
  const root = app.repo.root;
  const ghCache = {}; // the 60 s `gh auth status` result, per server

  const preflight = async () => {
    app.repo.requireWritable();
    const activeId = app.chats.activeId();
    if (activeId)
      throw new HttpError(409, 'chat-active', 'A chat is already active here.', {
        chatId: activeId,
      });
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
      maxBody: MAX_IMAGE_BODY,
      handler: async ({ body }) => {
        if (!body || typeof body.message !== 'string')
          throw new HttpError(400, 'bad-request', 'message is required');
        const images = parseImages(body.images);
        if (!body.message.trim() && images.length === 0)
          throw new HttpError(400, 'bad-request', 'message is required');
        const health = await preflight();
        const id = await app.chats.start({
          message: body.message,
          images,
          claudeVersion: health.version,
        });
        return { id };
      },
    },
    {
      method: 'GET',
      path: '/api/chats/:id',
      handler: async ({ params, url }) => {
        const chat = withStatus(app, requireChat(app, params.id));
        app.chats.markSeen(chat.id); // opening a chat counts as seeing its error
        const limit = pageLimit(url);
        const { log, unavailable } = app.chats.log(chat.id);
        const entries = log.slice(undefined, limit);
        const first = entries.length ? entries[0].pos : log.lastPos + 1;
        const init = app.chats.initInfo(chat.id);
        const tasks = chatTasks(app, chat.task_dirs);
        const { cfg } = app.repo.getConfig();
        const current = tasks.find((t) => t.dir === chat.task_dir);
        const stage =
          current && current.stages.find((s) => s.status !== 'done' && s.status !== 'skipped');
        const ticket = await ticketStatus((cfg && cfg.tracker) || 'none', init, {
          atTicketStage: Boolean(stage && sameStage(stage.id, 'ticket')),
          ghCache,
        });
        return {
          chat,
          epoch: log.epoch,
          version: log.version,
          entries,
          // Entries below the in-memory part (or below this page) exist when the first one is not pos 1.
          has_earlier: first > 1,
          queue: app.chats.queue(chat.id),
          ...(unavailable ? { unavailable: true } : {}),
          ticket,
          tasks,
        };
      },
    },
    {
      // ?since=<version>&epoch=<epoch>: what changed after that version, with the chat's busy/ended state and its
      // prompts. 410 gap when the client has to refetch the page. ?before=<pos>&limit=: older entries.
      method: 'GET',
      path: '/api/chats/:id/events',
      handler: ({ params, url }) => {
        const chat = withStatus(app, requireChat(app, params.id));
        const before = intParam(url, 'before');
        const since = intParam(url, 'since');
        if (before !== undefined) return app.chats.earlier(chat.id, before, pageLimit(url));
        if (since === undefined)
          throw new HttpError(400, 'bad-request', 'since or before is required');
        const { log } = app.chats.log(chat.id);
        const entries = url.searchParams.get('epoch') === log.epoch ? log.since(since) : null;
        if (!entries) throw new HttpError(410, 'gap', 'Reload the chat: this log has changed.');
        return {
          entries,
          version: log.version,
          busy: chat.busy === true,
          busySince: chat.busySince ?? null,
          ended: chat.status === 'ended',
          prompts: app.prompts.pendingFor(chat.id),
          queue: app.chats.queue(chat.id),
        };
      },
    },
    {
      // One image of the chat: `t:<message uuid>:<index>` from the transcript, `l:<pos>:<index>` sent live.
      method: 'GET',
      path: '/api/chats/:id/images/:ref',
      handler: ({ params }) => {
        requireChat(app, params.id);
        const m = /^([tl]):([^:]+):(\d+)$/.exec(params.ref);
        if (!m) throw new HttpError(400, 'bad-request', 'Not an image reference');
        const img =
          m[1] === 't'
            ? readTranscriptImage(root, params.id, m[2], Number(m[3]))
            : app.chats.log(params.id).log.image(params.ref);
        if (!img) throw new HttpError(404, 'not-found', 'Image no longer available');
        return img;
      },
    },
    {
      method: 'PUT',
      path: '/api/chats/:id/queue',
      maxBody: MAX_IMAGE_BODY,
      handler: ({ params, body }) => {
        app.repo.requireWritable();
        requireChat(app, params.id);
        if (!body || typeof body.text !== 'string')
          throw new HttpError(400, 'bad-request', 'text is required');
        if (body.id !== undefined && !Number.isInteger(body.id))
          throw new HttpError(400, 'bad-request', 'id must be an integer');
        const images = parseImages(body.images);
        if (!body.text.trim() && images.length === 0)
          throw new HttpError(400, 'bad-request', 'text is required');
        return app.chats.setQueue(params.id, { text: body.text, images }, body.id);
      },
    },
    {
      method: 'DELETE',
      path: '/api/chats/:id/queue',
      handler: ({ params, url }) => {
        requireChat(app, params.id);
        app.chats.clearQueue(params.id, intParam(url, 'id'));
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/message',
      maxBody: MAX_IMAGE_BODY,
      handler: ({ params, body }) => {
        app.repo.requireWritable();
        requireChat(app, params.id);
        if (!body || typeof body.text !== 'string')
          throw new HttpError(400, 'bad-request', 'text is required');
        const images = parseImages(body.images);
        if (!body.text.trim() && images.length === 0)
          throw new HttpError(400, 'bad-request', 'text is required');
        app.chats.send(params.id, body.text, images);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/shell',
      handler: ({ params, body }) => {
        requireChat(app, params.id);
        if (!body || typeof body.command !== 'string' || !body.command.trim())
          throw new HttpError(400, 'bad-request', 'command is required');
        app.repo.requireWritable();
        if (app.chats.activeId() !== params.id)
          throw new HttpError(409, 'chat-ended', 'This chat has ended.');
        const run = startShell({
          chatId: params.id,
          root,
          command: body.command,
          onEvent: (payload) => app.hub.send('shell', payload),
        });
        return { runId: run.runId };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/shell/:runId/stop',
      handler: ({ params }) => {
        requireChat(app, params.id);
        if (!stopRun(params.id, params.runId))
          throw new HttpError(404, 'not-found', 'No such running command');
        return { stopped: true };
      },
    },
    {
      method: 'GET',
      path: '/api/chat/commands',
      handler: ({ url }) => {
        const chatId = url && url.searchParams.get('chat');
        const init = chatId ? app.chats.initInfo(chatId) : null;
        return {
          commands: listCommands(root, {
            parseYaml: app.repo.lib.parseYaml,
            initCommands: init ? init.slashCommands : [],
            terminalCommands: init ? init.terminalSlashCommands : [],
          }),
        };
      },
    },
    {
      method: 'GET',
      path: '/api/chat/controls',
      handler: ({ url }) => {
        const chatId = url.searchParams.get('chat');
        if (chatId) requireChat(app, chatId);
        return app.chats.getControls(chatId || null);
      },
    },
    {
      method: 'POST',
      path: '/api/chat/controls',
      handler: ({ body }) => {
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new HttpError(400, 'bad-request', 'A JSON object is required');
        const { chat: chatId, ...rest } = body;
        if (chatId !== undefined && chatId !== null) requireChat(app, chatId);
        const patch = validateControls(rest, readDefaults(root).models);
        if (!Object.keys(patch).length)
          throw new HttpError(400, 'bad-control', 'Nothing to change');
        return app.chats.setControls(chatId || null, patch);
      },
    },
    {
      method: 'POST',
      path: '/api/trust',
      handler: ({ body }) => trustRepo(root, body && body.path),
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
      path: '/api/chats/:id/interrupt',
      handler: async ({ params }) => {
        requireChat(app, params.id);
        await app.chats.interrupt(params.id);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/kill',
      handler: ({ params }) => {
        requireChat(app, params.id);
        if (!app.chats.killOrphans(params.id))
          throw new HttpError(404, 'not-found', 'Nothing is left running');
        return { killed: true };
      },
    },
    {
      method: 'POST',
      path: '/api/chats/:id/continue',
      handler: async ({ params, body }) => {
        requireChat(app, params.id);
        const health = await preflight();
        // `sendQueued`: the message queued before the chat ended goes out as soon as claude is running again.
        await app.chats.resume({
          id: params.id,
          claudeVersion: health.version,
          sendQueued: Boolean(body && body.sendQueued === true),
        });
        return { ok: true };
      },
    },
  ];
}
