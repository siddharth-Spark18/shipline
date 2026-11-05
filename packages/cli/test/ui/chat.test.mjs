// Plan item 58, Chat (Goals 8-10, CUJs 3 and 4): the spawn argv, --session-id / --resume, the relay secret
// staying out of claude's environment, stream handling (invalid line, early exit, resume failure, busy turns,
// guard denials, usage limits) and the task binding. Runs the UI server in-process against
// test/fixtures/fake-claude.mjs; never the real claude.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_ROOT, hook, makeRepo, removeDir, stage, storeOf } from '../helpers.mjs';
import { api, openEvents, sleep, startUi } from './helpers.mjs';
import {
  FORBIDDEN,
  UUID_RE,
  groupPids,
  isChat,
  isEnd,
  isEventType,
  lockPath,
  pidAlive,
  postChat,
  readLockFile,
  readSessions,
  readUiLog,
  startChat,
  stateDirOf,
  tasksDirOf,
  stopChat,
  uiDir,
  useFakeClaude,
  waitUntil,
} from './chat-helpers.mjs';
import { FORBIDDEN_FLAGS, MIN_CLAUDE_VERSION, PERMISSION_TOOL, buildArgs } from '../../src/ui/claude.mjs';
import { guardDenial } from '../../src/ui/stream.mjs';
import { initLog } from '../../src/ui/log.mjs';

const RELAY = path.join(CLI_ROOT, 'src', 'ui', 'relay.mjs');
const OTHER_SESSION_ID = '00000000-0000-4000-8000-0000000000ff'; // fake-claude.mjs {{OTHER_SESSION_ID}}

let dir;
let fake;
let ui;
let ev;

const expectedArgv = (flag, id, mcp) => [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  flag,
  id,
  '--mcp-config',
  mcp,
  '--permission-prompt-tool',
  'mcp__shipline_ui__approve',
];
const sessionOf = (id) => readSessions(dir).find((c) => c.id === id);

before(async () => {
  fake = useFakeClaude();
  dir = makeRepo({ commitInit: true });
  ui = await startUi(dir);
  ev = await openEvents(ui);
});

after(async () => {
  if (ev) ev.close();
  if (ui) await ui.close();
  removeDir(dir);
  if (fake) fake.cleanup();
});

describe('spawn', () => {
  let id;
  let firstSecret;

  test('a new chat spawns claude with exactly the plan argv (--session-id), in the repo root, with SHIPLINE_SESSION', async () => {
    fake.script('normal-turn');
    const since = ev.mark();
    id = await startChat(ui, ev);
    assert.match(id, UUID_RE);
    await ev.waitFor(isEventType(id, 'result'), 10_000, since);

    const runs = fake.runs();
    assert.equal(runs.length, 1);
    const run = runs[0];
    const mcp = path.join(uiDir(dir), `mcp-${id}.json`);
    assert.deepEqual(run.argv, expectedArgv('--session-id', id, mcp));
    for (const f of FORBIDDEN) assert.ok(!run.argv.includes(f), `${f} must never be passed`);
    assert.ok(!run.argv.includes('--resume'));
    assert.equal(run.cwd, dir);
    assert.equal(run.shiplineEnv.SHIPLINE_SESSION, id);
  });

  test('the relay secret is only in the MCP config env, never in claude\'s environment', async () => {
    const run = fake.runs()[0];
    const server = run.mcpConfig.mcpServers.shipline_ui;
    assert.deepEqual(Object.keys(run.mcpConfig.mcpServers), ['shipline_ui']);
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [RELAY]);
    assert.equal(server.env.SHIPLINE_UI_RELAY_URL, `http://127.0.0.1:${ui.port}/api/relay`);
    assert.match(server.env.SHIPLINE_UI_RELAY_SECRET, /^[0-9a-f]{64}$/); // 32 random bytes
    assert.equal(run.secretInEnv, false, 'no env value of claude contains the secret');
    assert.ok(!run.envKeys.includes('SHIPLINE_UI_RELAY_SECRET'));
    assert.ok(!run.envKeys.includes('SHIPLINE_UI_RELAY_URL'));
    // The config file is 0600 while the chat runs. Windows has no POSIX modes (chmod is a no-op there, cleanup
    // plan C), so that one check is POSIX-only; the rest of this test runs everywhere.
    const mcp = path.join(uiDir(dir), `mcp-${id}.json`);
    if (process.platform !== 'win32') assert.equal(statSync(mcp).mode & 0o777, 0o600);
    firstSecret = server.env.SHIPLINE_UI_RELAY_SECRET;
    // Never logged.
    assert.ok(!readFileSync(path.join(uiDir(dir), 'ui.log'), 'utf8').includes(firstSecret));
    // The MCP config (it holds the secret) lives in the store, never in the repo.
    assert.ok(mcp.startsWith(storeOf(dir) + path.sep));
    assert.ok(!existsSync(path.join(dir, '.shipline', '.state')));
  });

  test('the stream is forwarded as SSE chat events; an unknown type is logged and skipped', async () => {
    const mine = ev.events.filter(isChat(id, 'event')).map((e) => e.data.event.type);
    assert.deepEqual(mine, ['system', 'stream_event', 'assistant', 'assistant', 'user', 'assistant', 'result']);
    assert.ok(readUiLog(dir).some((l) => l.event === 'unknown-event-type' && l.type === 'fake_unknown_event' && l.chatId === id));
    const spawnLog = readUiLog(dir).find((l) => l.event === 'spawn' && l.sessionId === id);
    assert.ok(spawnLog, 'each spawn is logged');
    assert.equal(spawnLog.argv[0], '-p');
  });

  test('sessions.json and lock.json describe the active chat', async () => {
    const s = sessionOf(id);
    assert.equal(s.status, 'active');
    assert.equal(s.title, 'Add a CSV export');
    assert.equal(s.task_dir, null);
    assert.ok(s.created && s.last_active);
    assert.deepEqual(readLockFile(dir), { pid: process.pid, hostname: os.hostname(), port: ui.port, session_id: id });
    const list = await api(ui, 'GET', '/api/chats');
    assert.equal(list.json.chats.find((c) => c.id === id).status, 'active');
  });

  test('stop ends the chat, releases the lock and deletes the MCP config (it holds the secret)', async () => {
    const pid = fake.runs()[0].pid;
    const end = await stopChat(ui, ev, id);
    assert.equal(end.data.kind, 'ended');
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(sessionOf(id).status, 'ended');
    assert.equal(existsSync(path.join(uiDir(dir), `mcp-${id}.json`)), false);
    await waitUntil(() => !pidAlive(pid));
  });

  test('continue resumes the same id with --resume (never --session-id or --fork-session)', async () => {
    fake.script('normal-turn');
    const r = await api(ui, 'POST', `/api/chats/${id}/continue`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true });
    const since = ev.mark();
    assert.equal((await api(ui, 'POST', `/api/chats/${id}/message`, { body: { text: 'go on' } })).status, 200);
    await ev.waitFor(isEventType(id, 'result'), 10_000, since);
    const run = fake.runs()[0];
    assert.deepEqual(run.argv, expectedArgv('--resume', id, path.join(uiDir(dir), `mcp-${id}.json`)));
    for (const f of FORBIDDEN) assert.ok(!run.argv.includes(f), `${f} must never be passed`);
    assert.ok(!run.argv.includes('--session-id'));
    assert.equal(run.shiplineEnv.SHIPLINE_SESSION, id);
    assert.equal(run.secretInEnv, false);
    const secret = run.mcpConfig.mcpServers.shipline_ui.env.SHIPLINE_UI_RELAY_SECRET;
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.notEqual(secret, firstSecret, 'a new secret for each spawn');
    assert.equal(sessionOf(id).status, 'active');
    assert.equal(readSessions(dir).filter((c) => c.id === id).length, 1, 'continuing does not add a second entry');
    await stopChat(ui, ev, id);
  });

  test('a resumed claude reporting a different session id: logged as a mismatch, the chat keeps its id (no rebind, plan "Session id")', async () => {
    fake.script('resume-new-id');
    assert.equal((await api(ui, 'POST', `/api/chats/${id}/continue`)).status, 200);
    const since = ev.mark();
    assert.equal((await api(ui, 'POST', `/api/chats/${id}/message`, { body: { text: 'again' } })).status, 200);
    const init = await ev.waitFor(isEventType(id, 'system', 'init'), 10_000, since);
    assert.equal(init.data.event.session_id, OTHER_SESSION_ID);
    await ev.waitFor(isEventType(id, 'result'), 10_000, since);
    const mismatch = readUiLog(dir).filter((l) => l.event === 'session-id-mismatch');
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].chatId, id);
    assert.equal(mismatch[0].reported, OTHER_SESSION_ID);
    assert.equal(ev.events.some(isChat(OTHER_SESSION_ID)), false, 'no events under the reported id');
    assert.equal(readSessions(dir).some((c) => c.id === OTHER_SESSION_ID), false);
    assert.equal(readLockFile(dir).session_id, id);
    await stopChat(ui, ev, id);
  });

  test('buildArgs never includes a forbidden flag, in either mode', () => {
    assert.deepEqual([...FORBIDDEN_FLAGS].sort(), FORBIDDEN.filter((f) => f !== '--fork-session').sort());
    for (const resume of [false, true]) {
      const argv = buildArgs({ sessionId: 'abc', resume, mcpConfig: '/x.json' });
      for (const f of FORBIDDEN) assert.ok(!argv.includes(f), f);
      assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], PERMISSION_TOOL);
    }
  });

  test('the title is the first 60 characters of the first message, line breaks replaced by spaces', async () => {
    fake.script('normal-turn');
    const message = 'line one\nline two\r\nline three ' + 'x'.repeat(100);
    const since = ev.mark();
    const cid = await startChat(ui, ev, message);
    await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
    assert.equal(sessionOf(cid).title, 'line one line two line three ' + 'x'.repeat(31));
    assert.equal(sessionOf(cid).title.length, 60);
    await stopChat(ui, ev, cid);
  });
});

describe('turns', () => {
  test('a message sent while a turn is running gets 409 busy; after result it is accepted', async () => {
    fake.unrelease();
    fake.script('busy-turn');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    try {
      const busy = await api(ui, 'POST', `/api/chats/${id}/message`, { body: { text: 'second' } });
      assert.equal(busy.status, 409);
      assert.equal(busy.json.error.code, 'busy');
      fake.release();
      await ev.waitFor(isEventType(id, 'result'), 10_000, since);
      const mark = ev.mark();
      const ok = await api(ui, 'POST', `/api/chats/${id}/message`, { body: { text: 'second' } });
      assert.equal(ok.status, 200, ok.text);
      const echo = await ev.waitFor(isEventType(id, 'result'), 10_000, mark);
      assert.equal(echo.data.event.result, 'echo: second');
    } finally {
      fake.unrelease();
      await stopChat(ui, ev, id);
    }
  });

  test('a message to an ended chat gets 409 chat-ended; an unknown chat 404', async () => {
    const ended = readSessions(dir).find((c) => c.status === 'ended');
    const r = await api(ui, 'POST', `/api/chats/${ended.id}/message`, { body: { text: 'hi' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'chat-ended');
    const unknown = '11111111-1111-4111-8111-111111111111';
    for (const [m, p] of [
      ['POST', `/api/chats/${unknown}/message`],
      ['POST', `/api/chats/${unknown}/stop`],
      ['POST', `/api/chats/${unknown}/continue`],
      ['GET', `/api/chats/${unknown}`],
    ]) {
      const x = await api(ui, m, p, m === 'POST' ? { body: { text: 'hi' } } : {});
      assert.equal(x.status, 404, `${m} ${p}`);
      assert.equal(x.json.error.code, 'not-found');
    }
  });

  test('a result event with usage-limit text raises the usage-limit banner', async () => {
    fake.script('usage-limit');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    const banner = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'usage-limit', 10_000, since);
    assert.equal(banner.data.id, 'usage-limit');
    assert.match(banner.data.text, /usage limit/i);
    await stopChat(ui, ev, id);
  });
});

describe('notices', () => {
  test('the fixture deny text is exactly what the vendored guard produces, and guardDenial matches it', () => {
    const repo = makeRepo({ commitInit: true });
    try {
      assert.equal(stage(repo, ['start', '--workflow', 'feature', '--title', 'Add export'], 'g1').code, 0);
      const r = hook(repo, 'guard.mjs', {
        session_id: 'g1',
        cwd: repo,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(repo, 'src/a.js'), old_string: 'a', new_string: 'b' },
      });
      const reason = r.json.hookSpecificOutput.permissionDecisionReason;
      const fixture = readFileSync(path.join(CLI_ROOT, 'test', 'fixtures', 'streams', 'guard-denial.jsonl'), 'utf8');
      assert.ok(fixture.includes(JSON.stringify(reason).slice(1, -1)), 'guard-denial.jsonl carries the real guard text');
      assert.ok(reason.startsWith('Shipline ('));
      assert.equal(guardDenial({ type: 'tool_result', is_error: true, content: reason }), reason);
      assert.equal(guardDenial({ type: 'tool_result', is_error: true, content: [{ type: 'text', text: reason }] }), reason);
      assert.equal(guardDenial({ type: 'tool_result', is_error: false, content: reason }), null);
    } finally {
      removeDir(repo);
    }
  });

  test('a guard denial in the stream is labelled shipline-block; an ordinary tool error is not', async () => {
    fake.script('guard-denial');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    await ev.waitFor(isEventType(id, 'result'), 10_000, since);
    const results = ev.events
      .slice(since)
      .filter(isEventType(id, 'user'))
      .map((e) => ({ toolUseId: e.data.event.message.content[0].tool_use_id, notices: e.data.notices }));
    assert.equal(results.length, 3);
    for (const r of results.slice(0, 2)) {
      assert.equal(r.notices.length, 1, r.toolUseId);
      assert.equal(r.notices[0].kind, 'shipline-block');
      assert.equal(r.notices[0].toolUseId, r.toolUseId);
      assert.match(r.notices[0].text, /Shipline \(Feature workflow, task add-export\)/);
    }
    assert.equal(results[2].toolUseId, 'toolu_fail');
    assert.equal(results[2].notices, undefined);
    await stopChat(ui, ev, id);
  });
});

describe('failures', () => {
  test('an invalid line stops the session with a fatal parse event carrying the resume command', async () => {
    fake.script('invalid-line');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    const fatal = await ev.waitFor(isEnd(id), 15_000, since);
    assert.equal(fatal.data.kind, 'fatal');
    assert.equal(fatal.data.reason, 'parse');
    assert.equal(fatal.data.resumeCommand, `claude --resume ${id}`);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(sessionOf(id).status, 'ended');
    await waitUntil(() => !pidAlive(fake.runs()[0].pid));
    assert.ok(readUiLog(dir).some((l) => l.event === 'stream-parse-error' && l.chatId === id));
    // Nothing after the bad line is forwarded as an event.
    assert.equal(ev.events.slice(since).filter(isChat(id, 'event')).length, 1);
  });

  test('an early exit gives a fatal exit event (code, stderr tail, resume command) and releases the lock', async () => {
    fake.script('early-exit');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    const fatal = await ev.waitFor(isEnd(id), 10_000, since);
    assert.equal(fatal.data.kind, 'fatal');
    assert.equal(fatal.data.reason, 'exit');
    assert.equal(fatal.data.code, 3);
    assert.match(fatal.data.stderrTail, /something went badly wrong/);
    assert.equal(fatal.data.resumeCommand, `claude --resume ${id}`);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(sessionOf(id).status, 'ended');
    const list = await api(ui, 'GET', '/api/chats');
    assert.equal(list.json.chats.find((c) => c.id === id).status, 'ended');
    // The lock is free: a new chat can start.
    fake.script('normal-turn');
    const next = await startChat(ui, ev);
    await stopChat(ui, ev, next);
  });

  test('an exit before system/init on resume gives resume-failed', async () => {
    const ended = readSessions(dir).find((c) => c.status === 'ended');
    fake.script('resume-fail');
    const since = ev.mark();
    const r = await api(ui, 'POST', `/api/chats/${ended.id}/continue`);
    assert.equal(r.status, 200, r.text);
    const fatal = await ev.waitFor(isEnd(ended.id), 10_000, since);
    assert.equal(fatal.data.kind, 'fatal');
    assert.equal(fatal.data.reason, 'resume-failed');
    assert.match(fatal.data.stderrTail, /No conversation found/);
    assert.equal(existsSync(lockPath(dir)), false);
    assert.equal(sessionOf(ended.id).status, 'ended');
  });

  test('claude missing from PATH gives 412 claude-missing and starts nothing', async () => {
    const savedPath = process.env.PATH;
    const savedBin = process.env.SHIPLINE_CLAUDE_BIN;
    const before = readSessions(dir).length;
    try {
      delete process.env.SHIPLINE_CLAUDE_BIN;
      process.env.PATH = fake.scratch; // no `claude` in here
      const r = await postChat(ui);
      assert.equal(r.status, 412);
      assert.equal(r.json.error.code, 'claude-missing');
      assert.match(r.json.error.message, /Install Claude Code/);
      process.env.SHIPLINE_CLAUDE_BIN = path.join(fake.scratch, 'no-such-claude');
      const r2 = await postChat(ui);
      assert.equal(r2.status, 412);
      assert.equal(r2.json.error.code, 'claude-missing');
    } finally {
      process.env.PATH = savedPath;
      process.env.SHIPLINE_CLAUDE_BIN = savedBin;
    }
    assert.equal(readSessions(dir).length, before);
    assert.equal(existsSync(lockPath(dir)), false);
  });

  test('an old claude gives 412 claude-too-old, a signed-out one 412 claude-signed-out', async () => {
    fake.script('normal-turn', { FAKE_CLAUDE_VERSION: '0.0.1' });
    let r = await postChat(ui);
    assert.equal(r.status, 412);
    assert.equal(r.json.error.code, 'claude-too-old');
    assert.equal(r.json.error.details.minVersion, MIN_CLAUDE_VERSION);
    fake.script('normal-turn', { FAKE_CLAUDE_VERSION: MIN_CLAUDE_VERSION });
    fake.script('normal-turn', { FAKE_CLAUDE_VERSION: MIN_CLAUDE_VERSION, FAKE_CLAUDE_LOGGED_OUT: '1' });
    r = await postChat(ui);
    assert.equal(r.status, 412);
    assert.equal(r.json.error.code, 'claude-signed-out');
    assert.equal(fake.runs().length, 0, 'nothing was spawned');
    assert.equal(existsSync(lockPath(dir)), false);
  });

  test('a claude at exactly MIN_CLAUDE_VERSION is accepted', async () => {
    fake.script('normal-turn', { FAKE_CLAUDE_VERSION: MIN_CLAUDE_VERSION });
    const id = await startChat(ui, ev);
    await stopChat(ui, ev, id);
  });

  test('a spawn ENOENT is handled like an early exit (fatal event, lock released, chat ended)', {
    skip: process.platform === 'win32' && 'starts a self-deleting .mjs directly (Windows needs a .cmd shim, so no ENOENT); covered by windows.test.mjs "a .cmd claude whose script is gone after the health checks ends the chat with a fatal exit event"',
  }, async () => {
    const copy = path.join(fake.scratch, 'claude-vanishing.mjs');
    copyFileSync(path.join(CLI_ROOT, 'test', 'fixtures', 'fake-claude.mjs'), copy);
    chmodSync(copy, 0o755);
    const savedBin = process.env.SHIPLINE_CLAUDE_BIN;
    try {
      // The copy answers --version and auth status, then deletes itself, so the spawn that follows fails.
      fake.script('normal-turn', { SHIPLINE_CLAUDE_BIN: copy, FAKE_CLAUDE_DELETE_SELF: '1' });
      const since = ev.mark();
      const r = await postChat(ui);
      assert.equal(existsSync(copy), false);
      if (r.status === 200) {
        const id = r.json.id;
        const fatal = await ev.waitFor(isEnd(id), 10_000, since);
        assert.equal(fatal.data.kind, 'fatal');
        assert.equal(fatal.data.reason, 'exit');
        assert.match(fatal.data.stderrTail, /ENOENT/);
        assert.equal(fatal.data.resumeCommand, `claude --resume ${id}`);
        assert.equal(sessionOf(id).status, 'ended');
      } else {
        assert.fail(`expected the chat to start and then fail like an early exit, got ${r.status} ${r.text}`);
      }
      assert.equal(existsSync(lockPath(dir)), false);
    } finally {
      process.env.SHIPLINE_CLAUDE_BIN = savedBin;
    }
  });
});

describe('task binding', () => {
  test('when claude runs stage.mjs start, the chat\'s task_dir is filled in', async () => {
    fake.script('stage-start');
    const since = ev.mark();
    const id = await startChat(ui, ev);
    const task = await ev.waitFor(isChat(id, 'task'), 10_000, since);
    const taskDir = path.join(tasksDirOf(dir), 'add-export');
    assert.equal(task.data.taskDir, taskDir);
    assert.equal(sessionOf(id).task_dir, taskDir);
    const state = JSON.parse(readFileSync(path.join(stateDirOf(dir), `${id}.json`), 'utf8'));
    assert.equal(state.session_id, id, 'stage.mjs found the session through SHIPLINE_SESSION');
    assert.equal(state.task_dir, taskDir);
    assert.ok(existsSync(path.join(taskDir, 'manifest.json')));
    assert.ok(!existsSync(path.join(dir, 'docs')), 'the task is not written into the repo');
    const got = await api(ui, 'GET', `/api/chats/${id}`);
    assert.equal(got.json.chat.task_dir, taskDir);
    await stopChat(ui, ev, id);
  });
});

// Plan "Interface change": chat is disabled for an interface-2 repo (its old hooks write state to
// .shipline/.state/, which the chat code no longer reads). Start, message and continue give 423 needs-upgrade.
describe('needs-upgrade (interface-2 repo)', () => {
  test('POST /api/chats, /message and /continue return 423 needs-upgrade; nothing is spawned; status says needsUpgrade', async () => {
    const legacy = makeRepo({ commitInit: true });
    const v = path.join(legacy, '.shipline', 'bin', 'VERSION');
    writeFileSync(v, JSON.stringify({ package: '0.6.0', interface: 2 }) + '\n');
    // A chat recorded earlier, so /message and /continue get past the 404 for an unknown chat.
    const chatId = '11111111-2222-4333-8444-555555555555';
    const ui2Dir = path.join(storeOf(legacy), 'ui');
    mkdirSync(ui2Dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(path.join(ui2Dir, 'sessions.json'), JSON.stringify([{ id: chatId, title: 'old', created: now, last_active: now, task_dir: null, status: 'ended' }]));
    const prevHome = process.env.SHIPLINE_HOME;
    const argvFile = fake.script('normal-turn');
    let legacyUi;
    try {
      legacyUi = await startUi(legacy);
      const status = await api(legacyUi, 'GET', '/api/status');
      assert.equal(status.json.needsUpgrade, true);
      assert.equal(status.json.versionState, 'repo-older');
      for (const [p, body] of [
        ['/api/chats', { message: 'hi' }],
        [`/api/chats/${chatId}/message`, { text: 'hi' }],
        [`/api/chats/${chatId}/continue`, {}],
      ]) {
        const r = await api(legacyUi, 'POST', p, { body });
        assert.equal(r.status, 423, `${p}: ${r.text}`);
        assert.equal(r.json.error.code, 'needs-upgrade', p);
        assert.match(r.json.error.message, /npx @forgeyard\/shipline upgrade/);
      }
      assert.deepEqual(fake.records(argvFile), [], 'claude was never spawned');
      assert.ok(!existsSync(path.join(ui2Dir, 'lock.json')), 'no lock was taken');
    } finally {
      if (legacyUi) await legacyUi.close();
      process.env.SHIPLINE_HOME = prevHome;
      removeDir(legacy);
    }
  });
});

// Chat input plan (docs/plans/shipline-chat-input.md), B. Images: the message and start-chat routes take
// base64 images, checked on the server, and claude gets one stream-json user message with the image blocks
// first, then the text block (left out when the text is empty).
describe('images', () => {
  const MB = 1024 * 1024;
  const b64 = (bytes, fill = 7) => Buffer.alloc(bytes, fill).toString('base64');
  const img = (media_type, bytes = 16) => ({ media_type, data: b64(bytes) });
  const block = (i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } });
  const stdinFile = () => process.env.FAKE_CLAUDE_STDIN_OUT;
  const stdinMessages = () =>
    existsSync(stdinFile()) ? readFileSync(stdinFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  let endedId;

  test('a message with images reaches claude as image blocks first, then the text block', async () => {
    const png = img('image/png');
    const jpeg = img('image/jpeg', 32);
    fake.script('normal-turn', { FAKE_CLAUDE_STDIN_OUT: path.join(fake.scratch, 'stdin-images.jsonl') });
    const since = ev.mark();
    const r = await api(ui, 'POST', '/api/chats', { body: { message: 'What is this?', images: [png, jpeg] } });
    assert.equal(r.status, 200, r.text);
    const id = r.json.id;
    try {
      await ev.waitFor(isEventType(id, 'result'), 10_000, since);
      assert.deepEqual(stdinMessages()[0], {
        type: 'user',
        message: { role: 'user', content: [block(png), block(jpeg), { type: 'text', text: 'What is this?' }] },
      });

      // Images only: no text block at all. A 5 MB image makes the body far bigger than the 1 MB default.
      const gif = img('image/gif', 5 * MB);
      const webp = img('image/webp');
      let mark = ev.mark();
      const onlyImages = await api(ui, 'POST', `/api/chats/${id}/message`, { body: { text: '', images: [gif, webp] } });
      assert.equal(onlyImages.status, 200, onlyImages.text);
      await ev.waitFor(isEventType(id, 'result'), 10_000, mark);
      assert.deepEqual(stdinMessages()[1].message.content, [block(gif), block(webp)]);

      // Text only: unchanged, one text block.
      mark = ev.mark();
      const textOnly = await api(ui, 'POST', `/api/chats/${id}/message`, { body: { text: 'plain' } });
      assert.equal(textOnly.status, 200, textOnly.text);
      await ev.waitFor(isEventType(id, 'result'), 10_000, mark);
      assert.deepEqual(stdinMessages()[2].message.content, [{ type: 'text', text: 'plain' }]);

      // Image data is never logged.
      assert.ok(!readFileSync(path.join(uiDir(dir), 'ui.log'), 'utf8').includes(gif.data.slice(0, 64)));
    } finally {
      delete process.env.FAKE_CLAUDE_STDIN_OUT;
      await stopChat(ui, ev, id);
    }
    endedId = id;
  });

  test('a chat started with images only is titled "Image" and claude gets no text block', async () => {
    const png = img('image/png');
    fake.script('normal-turn', { FAKE_CLAUDE_STDIN_OUT: path.join(fake.scratch, 'stdin-image-only.jsonl') });
    const since = ev.mark();
    const r = await api(ui, 'POST', '/api/chats', { body: { message: '', images: [png] } });
    assert.equal(r.status, 200, r.text);
    try {
      await ev.waitFor(isEventType(r.json.id, 'result'), 10_000, since);
      assert.equal(sessionOf(r.json.id).title, 'Image');
      assert.deepEqual(stdinMessages()[0].message.content, [block(png)]);
    } finally {
      delete process.env.FAKE_CLAUDE_STDIN_OUT;
      await stopChat(ui, ev, r.json.id);
    }
  });

  test('400 bad-image: wrong type, over 5 MB, more than 5 images, a data: prefix, not base64', async () => {
    assert.ok(endedId, 'needs the chat from the first images test');
    const png = img('image/png');
    const cases = [
      ['svg', [img('image/svg+xml')]],
      ['bmp', [img('image/bmp')]],
      ['no type', [{ data: png.data }]],
      ['over 5 MB', [img('image/png', 5 * MB + 1)]],
      ['6 images', Array.from({ length: 6 }, () => png)],
      ['data: prefix', [{ media_type: 'image/png', data: `data:image/png;base64,${png.data}` }]],
      ['not base64', [{ media_type: 'image/png', data: 'not base64!' }]],
      ['empty data', [{ media_type: 'image/png', data: '' }]],
      ['not a list', png],
      ['not an object', ['x']],
    ];
    const argvFile = fake.script('normal-turn');
    for (const [what, images] of cases) {
      // On the message route (checked before the chat-ended check) and on start-chat (before anything spawns).
      const m = await api(ui, 'POST', `/api/chats/${endedId}/message`, { body: { text: 'hi', images } });
      assert.equal(m.status, 400, `message, ${what}: ${m.text}`);
      assert.equal(m.json.error.code, 'bad-image', what);
      const s = await api(ui, 'POST', '/api/chats', { body: { message: 'hi', images } });
      assert.equal(s.status, 400, `start, ${what}: ${s.text}`);
      assert.equal(s.json.error.code, 'bad-image', what);
    }
    assert.deepEqual(fake.records(argvFile), [], 'nothing was spawned');
    assert.equal(existsSync(lockPath(dir)), false);
  });

  test('exactly 5 images of exactly 5 MB pass the checks (the ~33 MB body is accepted on the message route)', async () => {
    const big = Array.from({ length: 5 }, (_, n) => ({ media_type: 'image/png', data: b64(5 * MB, n) }));
    const r = await api(ui, 'POST', `/api/chats/${endedId}/message`, { body: { text: 'hi', images: big } });
    // Past the body limit and the image checks; the chat itself has ended.
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'chat-ended');
  });

  test('the 40 MB limit holds on the message and start-chat routes; 1 MB stays the limit elsewhere (413)', async () => {
    const over40 = JSON.stringify({ text: 'hi', pad: 'x'.repeat(40 * MB + 1) });
    for (const p of [`/api/chats/${endedId}/message`, '/api/chats']) {
      const r = await api(ui, 'POST', p, { body: over40 });
      assert.equal(r.status, 413, `${p}: ${r.text}`);
      assert.equal(r.json.error.code, 'too-large');
    }
    const under40 = JSON.stringify({ text: 'hi', pad: 'x'.repeat(39 * MB) });
    const ok = await api(ui, 'POST', `/api/chats/${endedId}/message`, { body: under40 });
    assert.equal(ok.status, 409, 'a 39 MB body is read and handled (the chat has ended)');

    const two = JSON.stringify({ command: 'echo hi', pad: 'x'.repeat(2 * MB) });
    for (const p of [`/api/chats/${endedId}/stop`, `/api/chats/${endedId}/shell`, `/api/chats/${endedId}/continue`]) {
      const r = await api(ui, 'POST', p, { body: two });
      assert.equal(r.status, 413, `${p}: ${r.text}`);
      assert.equal(r.json.error.code, 'too-large');
      assert.match(r.json.error.message, /1 MB/);
    }
  });
});

// Trust plan, E: processes a stopped chat leaves running. POSIX only: on Windows, Stop already takes down the
// whole tree with taskkill /T.
describe('leftover processes after Stop (Trust plan, E)', {
  skip:
    process.platform === 'win32' &&
    'POSIX process groups only; on Windows Stop kills the whole tree with taskkill /T, covered by windows.test.mjs "Stop leaves no fake-claude or child process in tasklist"',
}, () => {
  const kill = (id) => api(ui, 'POST', `/api/chats/${id}/kill`);
  const isOrphans = (id) => isChat(id, 'orphans');
  const isCleared = (id) => isChat(id, 'orphans-cleared');

  // Starts the hang-orphan script and stops it: claude dies on SIGTERM, its grandchild (which ignores SIGTERM)
  // stays in claude's process group. Returns { id, pgid, child, orphans }.
  async function stopWithOrphan() {
    fake.script('hang-orphan');
    const id = await startChat(ui, ev, 'Start a dev server');
    const since = ev.mark();
    const end = await stopChat(ui, ev, id);
    assert.equal(end.data.kind, 'ended');
    const pgid = fake.runs()[0].pid;
    const child = fake.records().find((r) => r.child).child;
    const orphans = await ev.waitFor(isOrphans(id), 5000, since);
    return { id, pgid, child, orphans };
  }

  test('a grandchild that ignores SIGTERM produces the orphans event with the group id; claude itself is gone', async () => {
    const { id, pgid, child, orphans } = await stopWithOrphan();
    try {
      assert.deepEqual(orphans.data, { chatId: id, kind: 'orphans', pgid });
      assert.ok(!pidAlive(pgid), 'claude exited');
      assert.ok(pidAlive(child), 'the grandchild is still running');
      assert.deepEqual(groupPids(pgid), [child]);
    } finally {
      await kill(id);
    }
  });

  test('POST /kill SIGKILLs the group, answers { killed: true } and sends orphans-cleared; a second /kill is 404', async () => {
    const { id, pgid, child } = await stopWithOrphan();
    const since = ev.mark();
    const r = await kill(id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { killed: true });
    const cleared = await ev.waitFor(isCleared(id), 2000, since);
    assert.deepEqual(cleared.data, { chatId: id, kind: 'orphans-cleared' });
    await waitUntil(() => !pidAlive(child), 3000);
    assert.deepEqual(groupPids(pgid), []);
    const again = await kill(id);
    assert.equal(again.status, 404, again.text);
    assert.equal(again.json.error.code, 'not-found');
  });

  test('a group that empties by itself clears the notice (orphans-cleared), and /kill is then 404', async () => {
    const { id, child } = await stopWithOrphan();
    const since = ev.mark();
    process.kill(child, 'SIGKILL');
    const cleared = await ev.waitFor(isCleared(id), 5000, since); // the poll runs every 2 s
    assert.deepEqual(cleared.data, { chatId: id, kind: 'orphans-cleared' });
    assert.equal((await kill(id)).status, 404);
  });

  test('a Stop that leaves nothing running sends no orphans event, and /kill is 404', async () => {
    fake.script('hang'); // its grandchild dies on SIGTERM
    const id = await startChat(ui, ev);
    const since = ev.mark();
    await stopChat(ui, ev, id);
    const child = fake.records().find((r) => r.child).child;
    await waitUntil(() => !pidAlive(child), 3000);
    await sleep(800); // past the ~400 ms check after the exit
    assert.ok(!ev.events.slice(since).some(isOrphans(id)), 'no orphans event');
    const r = await kill(id);
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.error.code, 'not-found');
  });

  test('/kill on an unknown chat is 404', async () => {
    const r = await kill('00000000-0000-4000-8000-00000000abcd');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not-found');
  });
});

// ---------- Chat reliability plan (docs/plans/shipline-chat-reliability.md) ----------

// Paths from claude's own output compared with the repo: Windows paths are case-insensitive.
const samePath = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

describe('chat reliability: reminders, trust, Jira, commands (2026-11-05 captures)', () => {
  let id;
  let since;

  // The needs-upgrade test's second server pointed the (process-wide) log at its own repo; point it back.
  before(() => initLog(dir));

  test('a hook reminder (system/informational) is forwarded with a reminder notice, prefix stripped', async () => {
    fake.release(); // reliability.jsonl waits for the release before system/init
    fake.script('reliability');
    since = ev.mark();
    id = await startChat(ui, ev);
    await ev.waitFor(isEventType(id, 'result'), 10_000, since);
    const info = ev.events.slice(since).find(isEventType(id, 'system', 'informational'));
    assert.ok(info, 'the informational event is forwarded');
    assert.equal(info.data.notices.length, 1);
    assert.equal(info.data.notices[0].kind, 'reminder');
    assert.match(info.data.notices[0].text, /^Shipline reminder: the "Plan" stage isn't done yet/);
    assert.ok(!ev.events.slice(since).some((e) => e.type === 'banner' && ['fail-open', 'lost-task'].includes(e.data.kind)));
  });

  test('the trust warning on stderr (printed twice) gives one trust banner, with the path from projects["…"]', async () => {
    const banner = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'trust', 5000, since);
    assert.equal(banner.data.id, 'trust');
    assert.ok(samePath(banner.data.path, dir), `${banner.data.path} is the repo`);
    assert.match(banner.data.text, /ignores this repo's Shipline permission rules until the repo is trusted/);
    await sleep(200);
    assert.equal(ev.events.slice(since).filter((e) => e.type === 'banner' && e.data.kind === 'trust').length, 1);
    const logged = readUiLog(dir).filter((l) => l.event === 'trust-needed' && l.chatId === id);
    assert.equal(logged.length, 1, 'once per chat');
    assert.ok(samePath(logged[0].path, dir));
  });

  test('GET /api/chat/commands?chat=<id> merges that chat\'s slash_commands, minus terminal, namespaced and interactive-only ones', async () => {
    const plain = await api(ui, 'GET', '/api/chat/commands');
    assert.equal(plain.status, 200, plain.text);
    const merged = await api(ui, 'GET', `/api/chat/commands?chat=${id}`);
    assert.equal(merged.status, 200, merged.text);
    const names = (r) => r.json.commands.map((c) => c.name);
    const m = Object.fromEntries(merged.json.commands.map((c) => [c.name, c]));
    for (const n of ['review', 'security-review']) {
      assert.ok(!names(plain).includes(n), `${n} is not listed without ?chat=`);
      assert.deepEqual(m[n], { name: n, description: '', source: 'builtin', kind: 'command' });
    }
    for (const n of ['doctor', 'color', 'focus', 'reload-plugins', 'example-plugin:deploy', 'help', 'status'])
      assert.ok(!(n in m), `${n} is left out`);
    assert.equal(m.context.description, 'Show context usage', 'a verified built-in keeps its description');
    assert.equal(names(merged).filter((n) => n === 'shipline-workflow').length, 1, 'no duplicate of a listed name');
    assert.equal(new Set(names(merged)).size, names(merged).length);
    const unknown = await api(ui, 'GET', '/api/chat/commands?chat=00000000-0000-4000-8000-00000000beef');
    assert.deepEqual(names(unknown), names(plain), 'an unknown chat adds nothing');
  });

  test('GET /api/chats/<id> reports jira from system/init.mcp_servers (the captured needs-auth), and keeps it after the chat ends', async () => {
    const r = await api(ui, 'GET', `/api/chats/${id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.jira, 'needs-auth');
    await stopChat(ui, ev, id);
    assert.equal((await api(ui, 'GET', `/api/chats/${id}`)).json.jira, 'needs-auth');
  });

  test('jira is null before system/init, then each of connected / failed / missing', async () => {
    fake.unrelease();
    fake.script('reliability');
    const mark = ev.mark();
    const pending = await startChat(ui, ev, 'Add a CSV export', { waitInit: false });
    try {
      const before = await api(ui, 'GET', `/api/chats/${pending}`);
      assert.equal(before.status, 200, before.text);
      assert.equal(before.json.jira, null);
      fake.release();
      await ev.waitFor(isEventType(pending, 'result'), 10_000, mark);
      assert.equal((await api(ui, 'GET', `/api/chats/${pending}`)).json.jira, 'needs-auth');
    } finally {
      await stopChat(ui, ev, pending);
    }
    const cases = [
      ['connected', [{ name: 'shipline_ui', status: 'connected' }, { name: 'claude.ai Atlassian', status: 'connected', source: 'claudeai' }]],
      ['failed', [{ name: 'claude.ai Atlassian', status: 'failed', source: 'claudeai' }]],
      ['missing', [{ name: 'shipline_ui', status: 'connected' }]],
    ];
    for (const [want, servers] of cases) {
      fake.script('reliability', { FAKE_CLAUDE_MCP_SERVERS: JSON.stringify(servers) });
      const m = ev.mark();
      const cid = await startChat(ui, ev);
      try {
        await ev.waitFor(isEventType(cid, 'result'), 10_000, m);
        assert.equal((await api(ui, 'GET', `/api/chats/${cid}`)).json.jira, want);
      } finally {
        await stopChat(ui, ev, cid);
      }
    }
  });
});

describe('chat controls: model, effort, permission mode, context', () => {
  const controlsFile = () => path.join(uiDir(dir), 'controls.json');
  const controlsOut = () => path.join(fake.scratch, `controls-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const readControlOut = (f) =>
    existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const subtypes = (f) => readControlOut(f).map((r) => r.request.subtype);
  const setControls = (body) => api(ui, 'POST', '/api/chat/controls', { body });
  const isControls = (cid, pred = () => true) => (e) => isChat(cid, 'controls')(e) && pred(e.data);
  const isContext = (cid) => isChat(cid, 'context');
  const flagsOf = (argv) => {
    const out = {};
    for (const f of ['--model', '--effort', '--permission-mode']) if (argv.includes(f)) out[f] = argv[argv.indexOf(f) + 1];
    return out;
  };

  before(() => {
    initLog(dir); // see the reliability describe
    rmSync(controlsFile(), { force: true });
    fake.release();
  });
  after(() => {
    rmSync(controlsFile(), { force: true });
    fake.unrelease();
  });

  let idle; // a running chat with its first turn done
  let idleOut;

  test('a new chat with no picks passes no control flags; start-up sends initialize then get_settings, and keeps only models[] and applied.*', async () => {
    idleOut = controlsOut();
    fake.script('controls-turn', { FAKE_CLAUDE_CONTROL_OUT: idleOut });
    const since = ev.mark();
    idle = await startChat(ui, ev);
    await ev.waitFor(isEventType(idle, 'result'), 10_000, since);
    const ctx = await ev.waitFor(isContext(idle), 10_000, since);

    assert.deepEqual(flagsOf(fake.runs()[0].argv), {}, 'nothing picked yet: Claude\'s own settings apply');
    const reqs = readControlOut(idleOut);
    assert.deepEqual(reqs.slice(0, 2).map((r) => r.request), [{ subtype: 'initialize' }, { subtype: 'get_settings' }]);
    assert.ok(reqs.every((r) => /^shipline-\d+$/.test(r.request_id)), 'every request_id is shipline-<n>');
    assert.equal(new Set(reqs.map((r) => r.request_id)).size, reqs.length);
    assert.ok(reqs.slice(0, 2).every((r) => r.results === 0), 'sent before the first turn ended');

    // context: after the result, the listed fields only, top 5 categories by tokens.
    assert.ok(reqs.some((r) => r.request.subtype === 'get_context_usage' && r.results === 1), 'get_context_usage after the result');
    assert.deepEqual(Object.keys(ctx.data.context).sort(), ['autoCompactThreshold', 'categories', 'isAutoCompactEnabled', 'maxTokens', 'percentage', 'totalTokens']);
    assert.equal(ctx.data.context.totalTokens, 20614);
    assert.equal(ctx.data.context.autoCompactThreshold, 967000);
    assert.equal(ctx.data.context.maxTokens, 1000000);
    assert.equal(ctx.data.context.isAutoCompactEnabled, true);
    assert.deepEqual(ctx.data.context.categories.map((c) => c.name), ['System tools', 'System prompt', 'Messages', 'MCP tools', 'Memory files']);
    assert.ok(ctx.data.context.categories.every((c) => Object.keys(c).join() === 'name,tokens'));

    // controls: effort from get_settings.applied, mode from initialize (default -> manual), models cached.
    const c = await api(ui, 'GET', `/api/chat/controls?chat=${idle}`);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.effort, 'high');
    assert.equal(c.json.permissionMode, 'manual');
    assert.equal(c.json.pending, null);
    assert.equal(c.json.context.totalTokens, 20614);
    assert.deepEqual(c.json.models.map((m) => m.value), ['default', 'opus', 'sonnet', 'haiku']);
    const saved = JSON.parse(readFileSync(controlsFile(), 'utf8'));
    assert.deepEqual(saved.models.map((m) => m.value), ['default', 'opus', 'sonnet', 'haiku']);
    assert.ok(!('isDefault' in saved.models[0]), 'only the listed model fields are kept');
    assert.equal(saved.model, undefined, 'nothing picked, nothing remembered');

    // initialize's account and get_settings' merged settings never leave the server.
    const everything = [
      readFileSync(path.join(uiDir(dir), 'ui.log'), 'utf8'),
      readFileSync(controlsFile(), 'utf8'),
      readFileSync(path.join(uiDir(dir), 'sessions.json'), 'utf8'),
      JSON.stringify(ev.events.slice(since)),
      c.text,
    ].join('\n');
    for (const secret of ['dev@example.com', 'Example Org', 'do-not-forward', 'SECRET_TOKEN'])
      assert.ok(!everything.includes(secret), `${secret} is never stored, logged or forwarded`);
  });

  test('control_response lines are not forwarded as chat events and never log unknown-event-type', () => {
    assert.ok(!ev.events.some((e) => e.type === 'chat' && e.data.kind === 'event' && e.data.event.type === 'control_response'));
    assert.ok(!readUiLog(dir).some((l) => l.event === 'unknown-event-type' && l.type === 'control_response'));
  });

  test('idle chat: a pick is sent now (set_model, set_permission_mode, apply_flag_settings) and remembered', async () => {
    let since = ev.mark();
    const r = await setControls({ chat: idle, model: 'sonnet' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied, 'now');
    assert.equal(r.json.controls.model, 'sonnet');
    await ev.waitFor(isControls(idle, (d) => d.controls.model === 'sonnet' && d.pending === null && !d.error), 5000, since);
    await ev.waitFor(isContext(idle), 5000, since); // a fresh reading after a successful set_model
    let reqs = readControlOut(idleOut);
    const setModel = reqs.find((x) => x.request.subtype === 'set_model');
    assert.deepEqual(setModel.request, { subtype: 'set_model', model: 'sonnet' });
    assert.ok(reqs.indexOf(setModel) < reqs.findLastIndex((x) => x.request.subtype === 'get_context_usage'));

    since = ev.mark();
    assert.equal((await setControls({ chat: idle, permissionMode: 'plan' })).json.applied, 'now');
    await ev.waitFor(isControls(idle, (d) => d.controls.permissionMode === 'plan'), 5000, since);
    assert.equal((await setControls({ chat: idle, effort: 'low' })).json.applied, 'now');
    await ev.waitFor(isControls(idle, (d) => d.controls.effort === 'low'), 5000, since);
    assert.equal((await setControls({ chat: idle, permissionMode: 'manual' })).json.applied, 'now');
    await ev.waitFor(isControls(idle, (d) => d.controls.permissionMode === 'manual'), 5000, since);
    reqs = readControlOut(idleOut);
    assert.deepEqual(reqs.filter((x) => x.request.subtype === 'set_permission_mode').map((x) => x.request.mode), ['plan', 'default'], 'manual is "default" in control messages');
    assert.deepEqual(reqs.find((x) => x.request.subtype === 'apply_flag_settings').request, { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
    assert.ok(!reqs.some((x) => x.request.subtype === 'set_effort'), 'set_effort is unsupported');

    // The chat keeps working, and the picks are on its sessions.json entry and in the repo defaults.
    const m = ev.mark();
    assert.equal((await api(ui, 'POST', `/api/chats/${idle}/message`, { body: { text: 'next' } })).status, 200);
    await ev.waitFor(isEventType(idle, 'result'), 10_000, m);
    assert.deepEqual(sessionOf(idle).controls, { model: 'sonnet', effort: 'low', permissionMode: 'manual' });
    const saved = JSON.parse(readFileSync(controlsFile(), 'utf8'));
    assert.deepEqual([saved.model, saved.effort, saved.permissionMode], ['sonnet', 'low', 'manual']);
    const c = (await api(ui, 'GET', `/api/chat/controls?chat=${idle}`)).json;
    assert.deepEqual([c.model, c.effort, c.permissionMode, c.pending], ['sonnet', 'low', 'manual', null]);
    await stopChat(ui, ev, idle);
  });

  test('a new chat starts with the repo defaults as separate argv flags', async () => {
    const d = await api(ui, 'GET', '/api/chat/controls');
    assert.deepEqual([d.json.model, d.json.effort, d.json.permissionMode, d.json.context, d.json.pending], ['sonnet', 'low', 'manual', null, null]);
    fake.script('controls-turn', { FAKE_CLAUDE_CONTROL_OUT: controlsOut() });
    const since = ev.mark();
    const cid = await startChat(ui, ev);
    try {
      await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
      const argv = fake.runs()[0].argv;
      assert.deepEqual(argv.slice(-6), ['--model', 'sonnet', '--effort', 'low', '--permission-mode', 'manual']);
      // system/init reports the resolved id and "default"; the controls show the picker's values.
      const c = (await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json;
      assert.deepEqual([c.model, c.effort, c.permissionMode], ['sonnet', 'low', 'manual']);
      assert.deepEqual(sessionOf(cid).controls, { model: 'sonnet', effort: 'low', permissionMode: 'manual' });
    } finally {
      await stopChat(ui, ev, cid);
    }
  });

  test('a picked alias that shares its resolved id with another (opus and default) stays as picked after system/init', async () => {
    assert.equal((await setControls({ model: 'opus' })).json.applied, 'next-start');
    fake.script('controls-turn');
    const since = ev.mark();
    const cid = await startChat(ui, ev);
    try {
      const init = await ev.waitFor(isEventType(cid, 'system', 'init'), 10_000, since);
      assert.equal(init.data.event.model, 'claude-opus-5-5', 'init reports the resolved id, which default also resolves to');
      await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
      assert.equal((await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json.model, 'opus');
      assert.ok(!ev.events.slice(since).some(isControls(cid, (d) => d.controls.model === 'default')), 'never shown as Default');
    } finally {
      await stopChat(ui, ev, cid);
      await setControls({ model: 'sonnet' });
    }
  });

  test('busy chat: picks wait for the result (last value of each wins), then are sent; pending is mirrored to sessions.json', async () => {
    fake.unrelease();
    const out = controlsOut();
    fake.script('controls-turn', { FAKE_CLAUDE_CONTROL_OUT: out });
    const since = ev.mark();
    const cid = await startChat(ui, ev);
    try {
      let r = await setControls({ chat: cid, model: 'haiku' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.applied, 'after-turn');
      await ev.waitFor(isControls(cid, (d) => d.pending && d.pending.model === 'haiku'), 5000, since);
      r = await setControls({ chat: cid, model: 'opus', effort: 'max' });
      assert.equal(r.json.applied, 'after-turn');
      const c = (await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json;
      assert.deepEqual(c.pending, { model: 'opus', effort: 'max' });
      assert.deepEqual(sessionOf(cid).controls.pending, { model: 'opus', effort: 'max' });
      await sleep(300);
      assert.ok(!subtypes(out).some((s) => s === 'set_model' || s === 'apply_flag_settings'), 'nothing is sent mid-turn');

      const m = ev.mark();
      fake.release();
      await ev.waitFor(isEventType(cid, 'result'), 10_000, m);
      await ev.waitFor(isControls(cid, (d) => d.controls.model === 'opus' && d.controls.effort === 'max' && d.pending === null), 5000, m);
      const reqs = readControlOut(out);
      const sent = reqs.filter((x) => ['set_model', 'apply_flag_settings'].includes(x.request.subtype));
      assert.deepEqual(sent.map((x) => x.request), [
        { subtype: 'set_model', model: 'opus' },
        { subtype: 'apply_flag_settings', settings: { effortLevel: 'max' } },
      ]);
      assert.ok(sent.every((x) => x.results === 1), 'sent after the turn\'s result');
      assert.equal((await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json.pending, null);
      const entry = sessionOf(cid).controls;
      assert.equal(entry.pending, undefined);
      assert.deepEqual([entry.model, entry.effort], ['opus', 'max']);
    } finally {
      await stopChat(ui, ev, cid);
    }
  });

  test('ended chat: a pick (and a pending one left by a stop mid-turn) is passed as flags when the chat continues', async () => {
    fake.unrelease();
    fake.script('controls-turn');
    const cid = await startChat(ui, ev);
    // Picked during the turn, then the chat stops before the result: the pick stays pending on the entry.
    assert.equal((await setControls({ chat: cid, permissionMode: 'acceptEdits' })).json.applied, 'after-turn');
    await stopChat(ui, ev, cid);
    assert.deepEqual(sessionOf(cid).controls.pending, { permissionMode: 'acceptEdits' });
    const pend = (await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json;
    assert.deepEqual(pend.pending, { permissionMode: 'acceptEdits' });

    const r = await setControls({ chat: cid, model: 'haiku' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied, 'next-start');
    assert.equal(r.json.controls.model, 'haiku');
    assert.equal(sessionOf(cid).controls.model, 'haiku');

    fake.release();
    fake.script('controls-turn');
    const since = ev.mark();
    assert.equal((await api(ui, 'POST', `/api/chats/${cid}/continue`)).status, 200);
    try {
      assert.equal((await api(ui, 'POST', `/api/chats/${cid}/message`, { body: { text: 'go on' } })).status, 200);
      await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
      const flags = flagsOf(fake.runs()[0].argv);
      assert.equal(flags['--model'], 'haiku');
      assert.equal(flags['--permission-mode'], 'acceptEdits', 'the pending pick is merged in at continue');
      assert.ok(fake.runs()[0].argv.includes('--resume'));
      const entry = sessionOf(cid).controls;
      assert.equal(entry.pending, undefined);
      assert.equal(entry.permissionMode, 'acceptEdits');
    } finally {
      await stopChat(ui, ev, cid);
    }
  });

  test('system/status (Claude changing the mode itself) emits controls with the new mode', async () => {
    fake.script('status-change');
    const since = ev.mark();
    const cid = await startChat(ui, ev);
    try {
      const e = await ev.waitFor(isControls(cid, (d) => d.controls.permissionMode === 'acceptEdits'), 10_000, since);
      assert.equal(e.data.chatId, cid);
      await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
      assert.equal((await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json.permissionMode, 'acceptEdits');
    } finally {
      await stopChat(ui, ev, cid);
    }
  });

  test('an error response reverts the value and sends the error for the toast', async () => {
    fake.script('controls-turn', { FAKE_CLAUDE_CONTROL_FAIL: 'set_model' });
    const since = ev.mark();
    const cid = await startChat(ui, ev);
    try {
      await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
      const before = (await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json.model;
      const m = ev.mark();
      assert.equal((await setControls({ chat: cid, model: 'opus' })).json.applied, 'now');
      const e = await ev.waitFor(isControls(cid, (d) => d.error), 5000, m);
      assert.match(e.data.error, /^Couldn't change model: Fake failure for set_model/);
      assert.equal(e.data.controls.model, before);
      assert.equal((await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json.model, before);
    } finally {
      await stopChat(ui, ev, cid);
    }
  });

  test('no response within 10 s reverts the value; the chat refuses messages while the change is in flight', { timeout: 30_000 }, async () => {
    fake.script('controls-turn', { FAKE_CLAUDE_CONTROL_SILENT: 'set_permission_mode' });
    const since = ev.mark();
    const cid = await startChat(ui, ev);
    try {
      await ev.waitFor(isEventType(cid, 'result'), 10_000, since);
      const before = (await api(ui, 'GET', `/api/chat/controls?chat=${cid}`)).json.permissionMode;
      const m = ev.mark();
      assert.equal((await setControls({ chat: cid, permissionMode: 'plan' })).json.applied, 'now');
      const busy = await api(ui, 'POST', `/api/chats/${cid}/message`, { body: { text: 'hi' } });
      assert.equal(busy.status, 409);
      assert.equal(busy.json.error.code, 'busy');
      const e = await ev.waitFor(isControls(cid, (d) => d.error), 15_000, m);
      assert.match(e.data.error, /^Couldn't change mode: No answer from Claude within 10 seconds/);
      assert.equal(e.data.controls.permissionMode, before);
    } finally {
      await stopChat(ui, ev, cid);
    }
  });

  test('POST /api/chat/controls without a chat updates the repo defaults only; bad values are 400 bad-control', async () => {
    const r = await setControls({ effort: 'medium' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.applied, 'next-start');
    assert.equal(r.json.controls.effort, 'medium');
    assert.equal(JSON.parse(readFileSync(controlsFile(), 'utf8')).effort, 'medium');
    for (const body of [
      { model: 'opus; rm -rf /' },
      { model: '$(whoami)' },
      { effort: 'extreme' },
      { permissionMode: 'bypassPermissions' },
      { permissionMode: 'dontAsk' },
      { permissionMode: 'default' },
      {},
    ]) {
      const x = await setControls(body);
      assert.equal(x.status, 400, JSON.stringify(body));
      assert.equal(x.json.error.code, 'bad-control');
    }
    const unknown = await setControls({ chat: '00000000-0000-4000-8000-00000000cafe', effort: 'low' });
    assert.equal(unknown.status, 404);
  });
});
