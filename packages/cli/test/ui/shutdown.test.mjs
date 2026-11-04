// Plan item 58, Shutdown (plan "Stopping a chat"): stopping the UI server stops claude's whole process group and
// releases the lock. The server runs as a real `shipline ui` child process for the signal cases, and in-process
// for close(). claude is test/fixtures/fake-claude.mjs, which starts a grandchild in its process group.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BIN, cleanEnv, homeFor, makeRepo, removeDir } from '../helpers.mjs';
import { openEvents, startUi } from './helpers.mjs';
import { groupPids, lockPath, pidAlive, readSessions, startChat, useFakeClaude, waitUntil } from './chat-helpers.mjs';

let dir;
let fake;

before(() => {
  fake = useFakeClaude();
  dir = makeRepo({ commitInit: true });
});

after(() => {
  // A failed test must not leave a server (and its claude) running.
  for (const c of servers) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const rec of fake ? fake.records() : []) {
    for (const pid of [rec.pid, rec.child]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  removeDir(dir);
  if (fake) fake.cleanup();
});

// `shipline ui` as its own process, with the fake replaying `script` (the server passes its environment, fixed
// at spawn, on to claude). Resolves once it has printed its URL.
const servers = [];
async function startUiProcess(script) {
  fake.script(script);
  const child = spawn(process.execPath, [BIN, 'ui', dir, '--no-open', '--port', '0'], {
    env: cleanEnv({ SHIPLINE_HOME: homeFor(dir) }), // the repo's own store (lock.json, sessions.json)
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL printed: ${out} ${err}`)), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on('exit', () => reject(new Error(`server exited: ${err}`)));
  });
  const base = new URL(url).origin;
  const r = await fetch(url, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { child, exited, base, cookie, stderr: () => err };
}

// Starts a chat through the API and waits until the fake has recorded its pid and its grandchild's.
async function startHangingChat(server) {
  const r = await fetch(`${server.base}/api/chats`, {
    method: 'POST',
    headers: { cookie: server.cookie, origin: server.base, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hang around' }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const { id } = await r.json();
  const recs = await waitUntil(() => {
    const all = fake.records();
    return all.find((x) => x.argv) && all.find((x) => x.child) ? all : null;
  }, 10_000);
  const pid = recs.find((x) => x.argv).pid;
  const grandchild = recs.find((x) => x.child).child;
  assert.deepEqual(groupPids(pid).sort(), [pid, grandchild].sort(), 'claude leads its own process group');
  assert.ok(existsSync(lockPath(dir)));
  return { id, pid, grandchild };
}

function assertAllGone({ id, pid, grandchild }) {
  assert.deepEqual(groupPids(pid), [], 'no process from claude\'s group is left');
  assert.equal(pidAlive(pid), false);
  assert.equal(pidAlive(grandchild), false);
  assert.equal(existsSync(lockPath(dir)), false, 'no lock.json');
  assert.equal(readSessions(dir).find((c) => c.id === id).status, 'ended');
}

describe('shipline ui as a process', () => {
  test('SIGINT stops claude\'s whole process group and removes lock.json', { skip: process.platform === 'win32' && 'Node cannot send SIGINT/SIGTERM to a child on Windows (child.kill terminates it outright, no handler runs) and there are no process groups; the Windows tree stop is covered by windows.test.mjs "Stop leaves no fake-claude or child process in tasklist"' }, async () => {
    const server = await startUiProcess('hang');
    const chat = await startHangingChat(server);
    server.child.kill('SIGINT');
    const { code } = await server.exited;
    assert.equal(code, 0, server.stderr());
    await waitUntil(() => groupPids(chat.pid).length === 0, 3000).catch(() => {});
    assertAllGone(chat);
  });

  test('SIGINT with a claude that ignores SIGTERM: SIGKILL follows and nothing is left', { skip: process.platform === 'win32' && 'Node cannot send SIGINT/SIGTERM to a child on Windows (child.kill terminates it outright, no handler runs) and there are no process groups; the Windows tree stop is covered by windows.test.mjs "Stop leaves no fake-claude or child process in tasklist"' }, async () => {
    const server = await startUiProcess('hang-ignore-sigterm');
    const chat = await startHangingChat(server);
    const t0 = Date.now();
    server.child.kill('SIGINT');
    const { code } = await server.exited;
    assert.equal(code, 0, server.stderr());
    assert.ok(Date.now() - t0 >= 4500, 'waited for the 5 s SIGKILL');
    await waitUntil(() => groupPids(chat.pid).length === 0, 3000).catch(() => {});
    assertAllGone(chat);
  });

  test('SIGTERM does the same', { skip: process.platform === 'win32' && 'Node cannot send SIGINT/SIGTERM to a child on Windows (child.kill terminates it outright, no handler runs) and there are no process groups; the Windows tree stop is covered by windows.test.mjs "Stop leaves no fake-claude or child process in tasklist"' }, async () => {
    const server = await startUiProcess('hang');
    const chat = await startHangingChat(server);
    server.child.kill('SIGTERM');
    const { code } = await server.exited;
    assert.equal(code, 0, server.stderr());
    await waitUntil(() => groupPids(chat.pid).length === 0, 3000).catch(() => {});
    assertAllGone(chat);
  });
});

describe('in-process close()', () => {
  test('close() stops the process group and releases the lock', { skip: process.platform === 'win32' && 'checks the POSIX process group with ps; covered by windows.test.mjs "close() stops the chat\'s process tree and releases the lock"' }, async () => {
    const ui = await startUi(dir);
    const ev = await openEvents(ui);
    fake.script('hang');
    const id = await startChat(ui, ev);
    const recs = await waitUntil(() => (fake.records().find((x) => x.child) ? fake.records() : null), 10_000);
    const chat = { id, pid: recs.find((x) => x.argv).pid, grandchild: recs.find((x) => x.child).child };
    ev.close();
    assert.equal(await ui.close(), 0);
    await waitUntil(() => groupPids(chat.pid).length === 0, 3000).catch(() => {});
    assertAllGone(chat);
  });
});
