// Plan item 59 (Goal 11, plan "Permission and question cards"): the MCP stdio relay, POST /api/relay,
// POST /api/prompts/<id>, SSE prompt / prompt-resolved, the timeout, reconnect, stop, the MCP config and the
// no-timeout rules. Round trips go through test/fixtures/fake-claude.mjs, which starts relay.mjs from the
// --mcp-config file and calls approve over MCP stdio, as claude does. Never runs the real claude.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { CLI_ROOT, makeRepo, removeDir } from '../helpers.mjs';
import { api, openEvents, rawRequest, sleep, startUi } from './helpers.mjs';
import {
  isEventType,
  lockPath,
  postChat,
  readSessions,
  startChat,
  stopChat,
  uiDir,
  useFakeClaude,
  waitUntil,
} from './chat-helpers.mjs';
import { relayRequestOptions } from '../../src/ui/relay.mjs';
import { DENY_MESSAGE, PROMPT_TIMEOUT_MS, timeoutMessage } from '../../src/ui/prompts.mjs';

const RELAY = path.join(CLI_ROOT, 'src', 'ui', 'relay.mjs');
const PKG_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;

let dir;
let fake;
let ui;
let ev;
let httpServer; // the node:http server startServer made

const secretOf = (d, id) => JSON.parse(readFileSync(path.join(uiDir(d), `mcp-${id}.json`), 'utf8')).mcpServers.shipline_ui.env.SHIPLINE_UI_RELAY_SECRET;

// POST /api/relay like relay.mjs does: no cookie, no Origin unless given. Resolves when the server answers.
const relayPost = (u, secret, body = { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_x' }, headers = {}) =>
  rawRequest(u.port, {
    method: 'POST',
    path: '/api/relay',
    headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-shipline-relay': secret }), ...headers },
    body: JSON.stringify(body),
  });

const isPrompt = (e) => e.type === 'prompt';
const resolvedOf = (id) => (e) => e.type === 'prompt-resolved' && e.data.id === id;

// relay.mjs as a process, speaking newline-delimited JSON-RPC.
function startRelay(env = {}) {
  const child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, SHIPLINE_UI_RELAY_URL: 'http://127.0.0.1:1/api/relay', SHIPLINE_UI_RELAY_SECRET: 'x'.repeat(64), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    lines.push(JSON.parse(l));
    while (waiters.length && lines.length) waiters.shift()(lines.shift());
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    exited,
    send: (msg) => child.stdin.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n'),
    next: (ms = 5000) =>
      new Promise((resolve, reject) => {
        if (lines.length) return resolve(lines.shift());
        const t = setTimeout(() => reject(new Error('no relay response')), ms);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      }),
  };
}

before(async () => {
  fake = useFakeClaude();
  dir = makeRepo({ commitInit: true });
  const orig = http.createServer;
  http.createServer = (...args) => (httpServer = orig.apply(http, args));
  try {
    ui = await startUi(dir);
  } finally {
    http.createServer = orig;
  }
  ev = await openEvents(ui);
});

after(async () => {
  if (ev) ev.close();
  if (ui) await ui.close();
  removeDir(dir);
  if (fake) fake.cleanup();
});

describe('relay.mjs over MCP stdio', () => {
  test('the JSON-RPC handshake: initialize, notifications/initialized (no reply), tools/list', async () => {
    const r = startRelay();
    try {
      r.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      assert.deepEqual(await r.next(), {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'shipline_ui', version: PKG_VERSION } },
      });
      r.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      r.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const list = await r.next(); // the notification got no reply, so this is tools/list's
      assert.equal(list.id, 2);
      assert.equal(list.result.tools.length, 1);
      const tool = list.result.tools[0];
      assert.equal(tool.name, 'approve');
      assert.equal(tool.inputSchema.type, 'object');
      assert.deepEqual(tool.inputSchema.properties, { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } });
      assert.ok(!(tool.inputSchema.required || []).includes('tool_use_id'), 'tool_use_id is optional');
    } finally {
      r.child.stdin.end();
      await r.exited;
    }
  });

  test('an unknown method gives -32601; a line that is not JSON gives -32700', async () => {
    const r = startRelay();
    try {
      r.send({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
      const unknown = await r.next();
      assert.equal(unknown.id, 7);
      assert.equal(unknown.error.code, -32601);
      r.send('{"jsonrpc": "2.0", "id": 8, "method": ');
      const bad = await r.next();
      assert.equal(bad.error.code, -32700);
      assert.equal(bad.id, null);
      // Still serving afterwards.
      r.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
      assert.equal((await r.next()).id, 9);
    } finally {
      r.child.stdin.end();
      await r.exited;
    }
  });

  test('when the UI cannot be reached, approve answers deny "Shipline UI is not reachable"', async () => {
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const r = startRelay({ SHIPLINE_UI_RELAY_URL: `http://127.0.0.1:${port}/api/relay` });
    try {
      r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } } });
      const res = await r.next();
      assert.deepEqual(JSON.parse(res.result.content[0].text), { behavior: 'deny', message: 'Shipline UI is not reachable' });
    } finally {
      r.child.stdin.end();
      await r.exited;
    }
  });

  test('the relay process exits when its stdin closes', async () => {
    const r = startRelay();
    r.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await r.next();
    r.child.stdin.end();
    const code = await Promise.race([r.exited, sleep(3000).then(() => 'still running')]);
    if (code === 'still running') r.child.kill();
    assert.equal(code, 0);
  });
});

describe('no timeouts on the wait', () => {
  test('the UI server has requestTimeout 0 and timeout 0', () => {
    assert.ok(httpServer, 'captured the server startServer created');
    assert.equal(httpServer.requestTimeout, 0);
    assert.equal(httpServer.timeout, 0);
  });

  test('relayRequestOptions builds node:http options with timeout 0, the secret header and no Origin', () => {
    const o = relayRequestOptions('http://127.0.0.1:4567/api/relay', 's3cret', 12);
    assert.equal(o.method, 'POST');
    assert.equal(o.hostname, '127.0.0.1');
    assert.equal(String(o.port), '4567');
    assert.equal(o.path, '/api/relay');
    assert.equal(o.timeout, 0);
    assert.equal(o.headers['X-Shipline-Relay'], 's3cret');
    assert.ok(!Object.keys(o.headers).some((k) => k.toLowerCase() === 'origin'), 'no Origin header');
    assert.ok(!Object.keys(o.headers).some((k) => k.toLowerCase() === 'cookie'), 'no cookie');
  });

  test('relay.mjs uses node:http with setTimeout(0) and never fetch (source check)', () => {
    const src = readFileSync(RELAY, 'utf8');
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.match(src, /from 'node:http'/);
    assert.match(src, /http\.request\(/);
    assert.match(src, /\.setTimeout\(0\)/);
  });

  test('askUi keeps waiting past Node\'s 5 s keep-alive agent socket timeout', async () => {
    const slow = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ behavior: 'allow', updatedInput: { a: 1 } }));
      }, 6000);
    });
    slow.requestTimeout = 0;
    slow.timeout = 0;
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const { askUi } = await import('../../src/ui/relay.mjs');
      const answer = await askUi({ tool_name: 'Bash', input: {} }, `http://127.0.0.1:${slow.address().port}/api/relay`, 'secret');
      assert.deepEqual(answer, { behavior: 'allow', updatedInput: { a: 1 } });
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  test('PROMPT_TIMEOUT_MS defaults to 600 000', () => {
    assert.equal(PROMPT_TIMEOUT_MS, 600_000);
    assert.equal(timeoutMessage(PROMPT_TIMEOUT_MS), 'No answer within 10 minutes');
  });
});

describe('POST /api/relay', () => {
  let id;
  let secret;

  before(async () => {
    fake.script('hang');
    id = await startChat(ui, ev);
    secret = secretOf(dir, id);
  });

  after(async () => {
    if (id) await stopChat(ui, ev, id);
  });

  test('no Origin, no cookie and the right secret: a prompt is created, held open, and answered', async () => {
    const since = ev.mark();
    const pending = relayPost(ui, secret, { tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_a' });
    const p = await ev.waitFor(isPrompt, 5000, since);
    assert.deepEqual(Object.keys(p.data).sort(), ['chatId', 'expiresAt', 'id', 'input', 'tool']);
    assert.equal(p.data.chatId, id);
    assert.equal(p.data.tool, 'Bash');
    assert.deepEqual(p.data.input, { command: 'npm test' });
    assert.ok(Math.abs(p.data.expiresAt - (Date.now() + PROMPT_TIMEOUT_MS)) < 10_000);
    // Answering needs the browser cookie.
    const noCookie = await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'allow' }, cookie: null });
    assert.equal(noCookie.status, 401);
    const ok = await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'allow' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true });
    const res = await pending;
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { behavior: 'allow', updatedInput: { command: 'npm test' } });
    const resolved = await ev.waitFor(resolvedOf(p.data.id), 5000, since);
    assert.equal(resolved.data.outcome, 'allow');
    // Already resolved: 404.
    const again = await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'deny' } });
    assert.equal(again.status, 404);
    assert.equal(again.json.error.code, 'not-found');
  });

  test('any Origin header gives 403 bad-origin, even with the right secret, and creates no prompt', async () => {
    const since = ev.mark();
    for (const origin of [ui.origin, 'http://evil.example', 'null']) {
      const r = await relayPost(ui, secret, undefined, { origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.json.error.code, 'bad-origin');
    }
    await sleep(100);
    assert.equal(ev.events.slice(since).some(isPrompt), false);
  });

  test('a wrong secret, a wrong-length secret or none gives 403 bad-secret (never 500)', async () => {
    const wrong = secret.slice(0, -1) + (secret.endsWith('0') ? '1' : '0');
    for (const s of [wrong, 'short', secret + 'aa', '', null]) {
      const r = await relayPost(ui, s);
      assert.equal(r.status, 403, String(s));
      assert.equal(r.json.error.code, 'bad-secret');
    }
    // The browser cookie is no substitute for the secret.
    const r = await relayPost(ui, null, undefined, { cookie: ui.cookie });
    assert.equal(r.status, 403);
  });

  test('an unknown prompt id is 404 not-found', async () => {
    const r = await api(ui, 'POST', '/api/prompts/00000000-0000-4000-8000-000000000000', { body: { decision: 'allow' } });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not-found');
  });

  test('a pending prompt is sent again on every SSE connect (reload), and resolution reaches every tab', async () => {
    const since = ev.mark();
    const pending = relayPost(ui, secret, { tool_name: 'Write', input: { file_path: 'x.txt', content: 'hi' } });
    const p = await ev.waitFor(isPrompt, 5000, since);
    const tab2 = await openEvents(ui);
    try {
      const again = await tab2.waitFor((e) => e.type === 'prompt' && e.data.id === p.data.id, 5000);
      assert.deepEqual(again.data, p.data);
      // A third connection after a reload gets it too.
      const tab3 = await openEvents(ui);
      await tab3.waitFor((e) => e.type === 'prompt' && e.data.id === p.data.id, 5000);
      tab3.close();
      await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'deny' } });
      const res = await pending;
      assert.deepEqual(res.json, { behavior: 'deny', message: DENY_MESSAGE });
      assert.equal((await tab2.waitFor(resolvedOf(p.data.id), 5000)).data.outcome, 'deny');
      assert.equal((await ev.waitFor(resolvedOf(p.data.id), 5000, since)).data.outcome, 'deny');
      // Once resolved it is not re-sent.
      const tab4 = await openEvents(ui);
      await sleep(200);
      assert.equal(tab4.events.some((e) => e.type === 'prompt' && e.data.id === p.data.id), false);
      tab4.close();
    } finally {
      tab2.close();
    }
  });

  test('stop() denies pending prompts; the ended chat\'s secret no longer works', async () => {
    const since = ev.mark();
    const pending = relayPost(ui, secret);
    const p = await ev.waitFor(isPrompt, 5000, since);
    await stopChat(ui, ev, id);
    const stoppedId = id;
    id = null;
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(res.json.behavior, 'deny');
    assert.equal(typeof res.json.message, 'string');
    assert.equal((await ev.waitFor(resolvedOf(p.data.id), 5000, since)).data.outcome, 'deny');
    const late = await relayPost(ui, secret);
    assert.equal(late.status, 403);
    assert.equal(late.json.error.code, 'bad-secret');
    assert.equal(existsSync(path.join(uiDir(dir), `mcp-${stoppedId}.json`)), false);
  });
});

describe('round trips through claude and the relay', () => {
  test('allow: the fake claude gets { behavior: allow, updatedInput } and prompt-resolved is sent', async () => {
    fake.script('relay-bash');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    try {
      const p = await ev.waitFor(isPrompt, 10_000, since);
      assert.equal(p.data.chatId, id);
      assert.equal(p.data.tool, 'Bash');
      assert.deepEqual(p.data.input, { command: 'npm test' });
      assert.equal((await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'allow' } })).status, 200);
      assert.equal((await ev.waitFor(resolvedOf(p.data.id), 5000, since)).data.outcome, 'allow');
      await ev.waitFor(isEventType(id, 'result'), 10_000, since);
      const [rec] = fake.relayAnswers();
      assert.deepEqual(rec.answer, { behavior: 'allow', updatedInput: { command: 'npm test' } });
      // The relay the fake started is the one in the MCP config, and it did the handshake.
      assert.equal(rec.handshake.init.result.serverInfo.name, 'shipline_ui');
      assert.deepEqual(rec.handshake.list.result.tools.map((t) => t.name), ['approve']);
      const toolResult = ev.events.slice(since).find(isEventType(id, 'user'));
      assert.equal(toolResult.data.notices, undefined);
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('deny: the fake claude gets the deny message, and its tool_result is labelled you-denied', async () => {
    fake.script('relay-bash');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    try {
      const p = await ev.waitFor(isPrompt, 10_000, since);
      assert.equal((await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'deny' } })).status, 200);
      assert.equal((await ev.waitFor(resolvedOf(p.data.id), 5000, since)).data.outcome, 'deny');
      await ev.waitFor(isEventType(id, 'result'), 10_000, since);
      assert.deepEqual(fake.relayAnswers()[0].answer, { behavior: 'deny', message: 'Denied by the developer in Shipline UI' });
      const toolResult = ev.events.slice(since).find(isEventType(id, 'user'));
      assert.deepEqual(toolResult.data.notices, [{ kind: 'you-denied', toolUseId: 'toolu_bash_1' }]);
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('AskUserQuestion: the answers arrive in updatedInput.answers, with the original input kept', async () => {
    fake.script('relay-ask');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    try {
      const p = await ev.waitFor(isPrompt, 10_000, since);
      assert.equal(p.data.tool, 'AskUserQuestion');
      const answers = { 'Which format?': 'CSV', 'Which columns?': 'id, email' };
      assert.equal((await api(ui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'allow', answers } })).status, 200);
      await ev.waitFor(isEventType(id, 'result'), 10_000, since);
      const { answer } = fake.relayAnswers()[0];
      assert.equal(answer.behavior, 'allow');
      assert.deepEqual(answer.updatedInput, { ...p.data.input, answers });
      assert.equal(answer.updatedInput.questions.length, 2);
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('a repo .mcp.json that already defines shipline_ui refuses to start the chat', async () => {
    const mcpJson = path.join(dir, '.mcp.json');
    const before = readSessions(dir).length;
    try {
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { shipline_ui: { command: 'node', args: ['x.mjs'] } } }));
      fake.script('normal-turn');
      const r = await postChat(ui);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error.code, 'mcp-name-collision');
      assert.match(r.json.error.message, /shipline_ui/);
      assert.equal(fake.runs().length, 0, 'claude was not started');
      assert.equal(existsSync(lockPath(dir)), false, 'the lock was released');
      assert.equal(readSessions(dir).length, before);
      // Another server name is fine.
      writeFileSync(mcpJson, JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x.mjs'] } } }));
      const id = await startChat(ui, ev);
      await stopChat(ui, ev, id);
    } finally {
      if (existsSync(mcpJson)) unlinkSync(mcpJson);
    }
  });
});

describe('timeout', () => {
  let tdir;
  let tui;

  before(async () => {
    tdir = makeRepo({ commitInit: true });
    tui = await startUi(tdir, { env: { SHIPLINE_UI_PROMPT_TIMEOUT_MS: '1000' } });
  });

  after(async () => {
    if (tui) await tui.close();
    removeDir(tdir);
  });

  test('with no answer, the prompt is denied with a message built from the constant; no tab open prints a notice', async () => {
    fake.script('relay-bash');
    const printed = [];
    const log = console.log;
    console.log = (...a) => printed.push(a.join(' '));
    let id;
    try {
      const r = await postChat(tui); // no SSE connection open on this server
      assert.equal(r.status, 200, r.text);
      id = r.json.id;
      await waitUntil(() => fake.relayAnswers().length > 0, 10_000);
    } finally {
      console.log = log;
    }
    const { answer } = fake.relayAnswers()[0];
    assert.deepEqual(answer, { behavior: 'deny', message: timeoutMessage(1000) });
    assert.match(answer.message, /^No answer within [\d.]+ minutes$/);
    assert.equal(printed.filter((l) => /waiting for a permission answer/.test(l)).length, 1, printed.join('\n'));
    const tev = await openEvents(tui);
    try {
      await api(tui, 'POST', `/api/chats/${id}/stop`);
      await waitUntil(() => !existsSync(lockPath(tdir)), 10_000);
    } finally {
      tev.close();
    }
  });

  test('a timed-out prompt sends prompt-resolved with outcome timeout and can no longer be answered', async () => {
    const tev = await openEvents(tui);
    fake.script('hang');
    const id = await startChat(tui, tev);
    try {
      const since = tev.mark();
      const t0 = Date.now();
      const pending = relayPost(tui, secretOf(tdir, id));
      const p = await tev.waitFor(isPrompt, 5000, since);
      assert.ok(p.data.expiresAt - t0 <= 1500 && p.data.expiresAt - t0 >= 500, 'expiresAt follows the override');
      const res = await pending;
      assert.deepEqual(res.json, { behavior: 'deny', message: timeoutMessage(1000) });
      assert.equal((await tev.waitFor(resolvedOf(p.data.id), 5000, since)).data.outcome, 'timeout');
      const late = await api(tui, 'POST', `/api/prompts/${p.data.id}`, { body: { decision: 'allow' } });
      assert.equal(late.status, 404);
    } finally {
      await stopChat(tui, tev, id);
      tev.close();
    }
  });
});
