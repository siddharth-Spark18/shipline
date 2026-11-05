// Teams Phase 1, D: the ticket notice's data. ticketStatus(tracker, initInfo) gives Jira's status from the chat's
// system/init mcp_servers and GitHub's from `gh auth status` (ghStatus: 5 s timeout, cached 60 s per server), and
// GET /api/chats/<id> returns it as `ticket`. A fake `gh` on PATH stands in for the real one. Node 20+.
//
// Windows: `gh` is started without a shell (startSpec), and then only gh.exe / gh.com are found on PATH, so a script
// can't stand in for it there; the fake-gh cases are skipped on Windows and "missing" (no gh at all) still runs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo, removeDir, stage, storeOf, tmpDir } from '../helpers.mjs';
import { api, startUi } from './helpers.mjs';
import { GH_CACHE_MS, ghStatus, ticketStatus } from '../../src/ui/tracker.mjs';

const NO_FAKE_GH = process.platform === 'win32' && 'a script on PATH cannot stand in for gh.exe (no shell, so .cmd is not found)';

let scratch;
let bin; // holds the fake gh
let empty; // a PATH with no gh at all
let runsLog; // one line per fake gh run
const savedPath = process.env.PATH;

// The fake gh: `ok` exits 0, `auth` exits 1 (not signed in), `slow` outlives the 5 s timeout. Each run logs its args.
function fakeGh(mode) {
  const body = { ok: 'exit 0', auth: 'echo "You are not logged into any GitHub hosts." >&2\nexit 1', slow: 'exec sleep 30' }[mode];
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${runsLog}"\n${body}\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
}
const runs = () => (existsSync(runsLog) ? readFileSync(runsLog, 'utf8').split('\n').filter(Boolean) : []);
const useFakeGh = () => {
  process.env.PATH = [bin, savedPath].join(path.delimiter);
};
const useNoGh = () => {
  process.env.PATH = empty;
};

before(() => {
  scratch = tmpDir('shipline-gh-');
  bin = path.join(scratch, 'bin');
  empty = path.join(scratch, 'empty');
  mkdirSync(bin);
  mkdirSync(empty);
  runsLog = path.join(scratch, 'gh-runs.log');
});
after(() => {
  process.env.PATH = savedPath;
  removeDir(scratch);
});

describe('ghStatus and ticketStatus', () => {
  after(() => {
    process.env.PATH = savedPath;
  });

  test('gh exits 0: connected, after one `gh auth status`', { skip: NO_FAKE_GH }, async () => {
    fakeGh('ok');
    useFakeGh();
    rmSync(runsLog, { force: true });
    assert.equal(await ghStatus({}), 'connected');
    assert.deepEqual(runs(), ['auth status']);
  });

  test('gh exits 1: needs-auth', { skip: NO_FAKE_GH }, async () => {
    fakeGh('auth');
    useFakeGh();
    assert.equal(await ghStatus({}), 'needs-auth');
  });

  test('no gh on PATH: missing', async () => {
    useNoGh();
    assert.equal(await ghStatus({}), 'missing');
  });

  test('gh that does not answer within 5 s: failed', { skip: NO_FAKE_GH, timeout: 20_000 }, async () => {
    fakeGh('slow');
    useFakeGh();
    const start = Date.now();
    assert.equal(await ghStatus({}), 'failed');
    const took = Date.now() - start;
    assert.ok(took >= 4_500 && took < 15_000, `${took} ms`);
  });

  test('the result is cached for 60 s per cache object; calls while gh runs share one run', { skip: NO_FAKE_GH }, async () => {
    fakeGh('ok');
    useFakeGh();
    rmSync(runsLog, { force: true });
    let t = 1_000_000;
    const now = () => t;
    const cache = {};
    const [a, b] = await Promise.all([ghStatus(cache, now), ghStatus(cache, now)]);
    assert.deepEqual([a, b], ['connected', 'connected']);
    assert.equal(runs().length, 1, 'one run for two concurrent calls');
    fakeGh('auth');
    t += GH_CACHE_MS - 1;
    assert.equal(await ghStatus(cache, now), 'connected', 'still cached');
    assert.equal(runs().length, 1);
    t += 1;
    assert.equal(await ghStatus(cache, now), 'needs-auth', 'after 60 s gh runs again');
    assert.equal(runs().length, 2);
    assert.equal(await ghStatus({}, now), 'needs-auth', 'another cache (another server) runs its own');
    assert.equal(runs().length, 3);
  });

  test('ticketStatus: jira from mcp_servers (null before system/init), github only at the ticket stage, others null', { skip: NO_FAKE_GH }, async () => {
    fakeGh('ok');
    useFakeGh();
    rmSync(runsLog, { force: true });
    const atl = (status) => ({ mcpServers: [{ name: 'claude.ai Atlassian', status }] });
    assert.equal(await ticketStatus('jira', null), null);
    assert.deepEqual(await ticketStatus('jira', atl('needs-auth')), { tracker: 'jira', status: 'needs-auth' });
    assert.deepEqual(await ticketStatus('jira', { mcpServers: [] }), { tracker: 'jira', status: 'missing' });
    assert.equal(await ticketStatus('github', atl('connected'), { atTicketStage: false, ghCache: {} }), null);
    assert.deepEqual(runs(), [], 'gh is not started away from the ticket stage');
    assert.deepEqual(await ticketStatus('github', null, { atTicketStage: true, ghCache: {} }), { tracker: 'github', status: 'connected' });
    assert.equal(runs().length, 1);
    assert.equal(await ticketStatus('linear', atl('connected'), { atTicketStage: true, ghCache: {} }), null);
    assert.equal(runs().length, 1);
  });
});

// GET /api/chats/<id> in a repo with tracker: github. The chats are recorded in sessions.json (ended), each bound to a
// task made by stage.mjs, so no claude is needed: GitHub's status doesn't depend on the chat's system/init.
describe('GET /api/chats/<id> ticket, tracker: github', () => {
  const CHAT_TICKET = '11111111-1111-4111-8111-000000000001'; // task at the ticket stage
  const CHAT_LATER = '11111111-1111-4111-8111-000000000002'; // task past it
  const CHAT_OLD_ID = '11111111-1111-4111-8111-000000000003'; // a 0.9.0 manifest: stage `jira`
  let dir;
  const servers = [];

  before(() => {
    dir = makeRepo({ commitInit: true });
    const cfg = path.join(dir, '.shipline', 'config.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('tracker: jira', 'tracker: github'));
    const tasks = path.join(storeOf(dir), 'tasks');
    assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'At ticket', '--ticket', '7'], 'sa').code, 0);
    assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'Past ticket', '--ticket', '8'], 'sb').code, 0);
    assert.equal(stage(dir, ['skip', '--reason', 'GitHub not connected'], 'sb').code, 0);
    assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'Old id'], 'sc').code, 0);
    const old = path.join(tasks, 'old-id', 'manifest.json');
    const m = JSON.parse(readFileSync(old, 'utf8'));
    m.stages[0].id = 'jira';
    writeFileSync(old, JSON.stringify(m, null, 2));
    const now = new Date().toISOString();
    const entry = (id, folder) => ({ id, title: folder, created: now, last_active: now, task_dir: path.join(tasks, folder), status: 'ended' });
    const ui = path.join(storeOf(dir), 'ui');
    mkdirSync(ui, { recursive: true });
    writeFileSync(
      path.join(ui, 'sessions.json'),
      JSON.stringify([entry(CHAT_TICKET, 'issue-7-at-ticket'), entry(CHAT_LATER, 'issue-8-past-ticket'), entry(CHAT_OLD_ID, 'old-id')]),
    );
  });
  after(async () => {
    for (const s of servers) await s.close();
    process.env.PATH = savedPath;
    removeDir(dir);
  });
  // A new server each time: the 60 s cache belongs to the server.
  const server = async () => {
    const s = await startUi(dir);
    servers.push(s);
    return s;
  };
  const ticketOf = async (ui, id) => {
    const r = await api(ui, 'GET', `/api/chats/${id}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(!('jira' in r.json));
    return r.json.ticket;
  };

  test('at the ticket stage: connected, then cached (gh signing out shows only after 60 s)', { skip: NO_FAKE_GH }, async () => {
    fakeGh('ok');
    useFakeGh();
    rmSync(runsLog, { force: true });
    const ui = await server();
    assert.deepEqual(await ticketOf(ui, CHAT_TICKET), { tracker: 'github', status: 'connected' });
    fakeGh('auth');
    assert.deepEqual(await ticketOf(ui, CHAT_TICKET), { tracker: 'github', status: 'connected' });
    assert.equal(runs().length, 1, 'the second request used the cache');
  });

  test('needs-auth and missing', { skip: NO_FAKE_GH }, async () => {
    process.env.PATH = savedPath;
    fakeGh('auth');
    useFakeGh();
    assert.deepEqual(await ticketOf(await server(), CHAT_TICKET), { tracker: 'github', status: 'needs-auth' });
    const ui = await server(); // started with the normal PATH (it may run git)
    useNoGh();
    assert.deepEqual(await ticketOf(ui, CHAT_TICKET), { tracker: 'github', status: 'missing' });
  });

  test('missing (no gh on PATH)', { skip: !NO_FAKE_GH && 'covered with the fake gh above' }, async () => {
    process.env.PATH = savedPath;
    const ui = await server();
    useNoGh();
    assert.deepEqual(await ticketOf(ui, CHAT_TICKET), { tracker: 'github', status: 'missing' });
  });

  test('a task whose stage id is still `jira` counts as at the ticket stage', { skip: NO_FAKE_GH }, async () => {
    fakeGh('ok');
    useFakeGh();
    assert.deepEqual(await ticketOf(await server(), CHAT_OLD_ID), { tracker: 'github', status: 'connected' });
  });

  test('a task past the ticket stage: null, and gh is never started', { skip: NO_FAKE_GH }, async () => {
    fakeGh('ok');
    useFakeGh();
    rmSync(runsLog, { force: true });
    assert.equal(await ticketOf(await server(), CHAT_LATER), null);
    assert.deepEqual(runs(), []);
  });
});
