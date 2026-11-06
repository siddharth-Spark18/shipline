// Chat input plan (docs/plans/shipline-chat-input.md), Tests: shell.test.mjs. The `!` runner: output streaming,
// exit codes, the 1 MB cap, Stop (POSIX process group / Windows taskkill tree), stopping with the chat and on
// server shutdown, and the /shell routes. Commands are node one-liners so the same tests run under $SHELL -c and
// cmd.exe. The UI server runs in-process against test/fixtures/fake-claude.mjs; never the real claude.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { IS_WIN, livePids, makeRepo, removeDir, tasklist, tmpDir } from '../helpers.mjs';
import { api, openEvents, sleep, startUi } from './helpers.mjs';
import { groupPids, readUiLog, startChat, stopChat, useFakeClaude, waitUntil } from './chat-helpers.mjs';
import { OUTPUT_CAP_BYTES, startShell, stopAll, stopEverything, stopRun } from '../../src/ui/shell.mjs';

const NODE = `"${process.execPath}"`;
// node -e with single quotes only inside, so it survives both sh -c and cmd.exe /s /c "...".
const nodeE = (code) => `${NODE} -e "${code}"`;
// Prints "<its pid> <grandchild pid>" and then runs until killed, with a long-lived grandchild.
const TREE = nodeE(
  "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e5)'],{stdio:'ignore'});console.log(process.pid+' '+c.pid);setInterval(()=>{},1e5)",
);

let cwd;
const leftovers = new Set(); // pids a failed test may have left running

before(() => {
  cwd = tmpDir('shipline-shell-');
});

after(async () => {
  await stopEverything();
  for (const pid of livePids([...leftovers])) {
    try {
      if (IS_WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  removeDir(cwd);
});

// Runs `command` and collects its events. `done` resolves with all events once 'exit' arrives.
function run(command, chatId = 'chat-a') {
  const events = [];
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const waiters = new Set();
  const handle = startShell({
    chatId,
    root: cwd,
    command,
    onEvent: (e) => {
      events.push(e);
      for (const w of waiters) w();
      if (e.kind === 'exit') resolve(events);
    },
  });
  const output = (stream) =>
    events
      .filter((e) => e.kind === 'output' && (!stream || e.stream === stream))
      .map((e) => e.data)
      .join('');
  // Resolves once the stdout so far matches `re`.
  const waitOutput = (re, ms = 10_000) =>
    new Promise((res, rej) => {
      const check = () => {
        const m = re.exec(output('stdout'));
        if (m) {
          waiters.delete(check);
          clearTimeout(t);
          res(m);
          return true;
        }
        return false;
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        rej(new Error(`no output matching ${re} within ${ms} ms; got ${JSON.stringify(output())}`));
      }, ms);
      if (!check()) waiters.add(check);
    });
  return { ...handle, events, done, output, waitOutput };
}

const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what}: not within ${ms} ms`)), ms)))]).finally(() =>
    clearTimeout(t),
  );
};

// How long a process check polls before it fails (1.0 plan, item 8: Windows CI is slow to tear a tree down).
const GONE_MS = 10_000;

// Windows: the pids of `pids` still in tasklist under the image name they had at start (a freed pid that Windows has
// already handed to another process is not a leftover). null when tasklist itself failed, so the caller asks again.
function leftInTasklist(pids, images) {
  let procs;
  try {
    procs = tasklist();
  } catch {
    return null;
  }
  return pids.filter((pid) => procs.has(pid) && (!images || !images.get(pid) || procs.get(pid) === images.get(pid)));
}

// Windows: { pid: image name } of `pids` now, so a pid Windows reuses later is not taken for a leftover. null elsewhere.
function imagesOf(pids) {
  if (!IS_WIN) return null;
  const procs = tasklist();
  return new Map(pids.map((pid) => [pid, procs.get(pid)]));
}

// Starts TREE and returns { r, pids: [node, grandchild], pgid, images } once both are running.
async function startTree(chatId) {
  const r = run(TREE, chatId);
  const m = await r.waitOutput(/(\d+) (\d+)/);
  const pids = [Number(m[1]), Number(m[2])];
  for (const p of pids) leftovers.add(p);
  await waitUntil(() => livePids(pids).length === pids.length, GONE_MS).catch(() => {});
  assert.deepEqual(livePids(pids).sort(), [...pids].sort(), 'command and grandchild are running');
  let pgid = null;
  const images = imagesOf(pids);
  if (!IS_WIN) {
    pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pids[0])], { encoding: 'utf8' }).trim());
    assert.ok(groupPids(pgid).includes(pids[1]), 'the grandchild is in the command\'s process group');
  }
  return { r, pids, pgid, images };
}

// The tree is gone: POSIX, nothing left in the group; Windows, neither pid in tasklist. Both poll for up to 10 s:
// Windows retries tasklist (which can itself fail under load) until the tree is gone or the time is up.
async function assertTreeGone({ pids, pgid, images = null }) {
  if (IS_WIN) {
    const deadline = Date.now() + GONE_MS;
    let left = pids;
    for (;;) {
      const now = leftInTasklist(pids, images);
      if (now) left = now;
      if ((now && now.length === 0) || Date.now() > deadline) break;
      await sleep(100);
    }
    assert.deepEqual(left, [], 'no process of the tree is left in tasklist');
  } else {
    await waitUntil(() => groupPids(pgid).length === 0 && livePids(pids).length === 0, GONE_MS).catch(() => {});
    assert.deepEqual(groupPids(pgid), [], 'no process of the group is left');
    assert.deepEqual(livePids(pids), []);
  }
}

describe('startShell', () => {
  test('`echo` streams its output and exits 0; start comes first, exit last', async () => {
    const r = run('echo hello shipline');
    const events = await withTimeout(r.done, 10_000, 'exit');
    assert.equal(events[0].kind, 'start');
    assert.equal(events[0].command, 'echo hello shipline');
    assert.equal(events[0].chatId, 'chat-a');
    assert.equal(events[0].runId, r.runId);
    assert.ok(!Number.isNaN(Date.parse(events[0].startedAt)));
    assert.equal(r.output('stdout').trim(), 'hello shipline');
    const exit = events.at(-1);
    assert.equal(exit.kind, 'exit');
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(typeof exit.durationMs, 'number');
    assert.ok(events.every((e) => e.runId === r.runId && e.chatId === 'chat-a'));
  });

  test('runs in the repo root', async () => {
    const r = run(nodeE('process.stdout.write(process.cwd())'));
    await withTimeout(r.done, 10_000, 'exit');
    assert.equal(r.output('stdout'), cwd);
  });

  test('stderr is captured as its own stream', async () => {
    const r = run(nodeE("process.stdout.write('out');process.stderr.write('oops')"));
    await withTimeout(r.done, 10_000, 'exit');
    assert.equal(r.output('stdout'), 'out');
    assert.equal(r.output('stderr'), 'oops');
  });

  test('a non-zero exit code is reported', async () => {
    const r = run(nodeE('process.exit(3)'));
    const events = await withTimeout(r.done, 10_000, 'exit');
    assert.equal(events.at(-1).code, 3);
  });

  test('output over 1 MB is cut at exactly 1 MB with one truncated event; the run still exits', async () => {
    const r = run(nodeE("process.stdout.write('x'.repeat(3*1024*1024))"));
    const events = await withTimeout(r.done, 20_000, 'exit');
    assert.equal(OUTPUT_CAP_BYTES, 1024 * 1024);
    assert.equal(Buffer.byteLength(r.output()), OUTPUT_CAP_BYTES);
    assert.equal(events.filter((e) => e.kind === 'truncated').length, 1);
    const t = events.findIndex((e) => e.kind === 'truncated');
    assert.ok(events.slice(t + 1).every((e) => e.kind !== 'output'), 'nothing is sent after truncated');
    assert.equal(events.at(-1).kind, 'exit');
    assert.equal(events.at(-1).code, 0);
  });

  test('invalid UTF-8 becomes replacement characters, nothing crashes', async () => {
    const r = run(nodeE('process.stdout.write(Buffer.from([0x61,0xff,0xfe,0x62]))'));
    await withTimeout(r.done, 10_000, 'exit');
    assert.equal(r.output('stdout'), 'a��b');
  });

  test('Stop kills a long-running command and its child (POSIX group / Windows tree)', async () => {
    const tree = await startTree('chat-stop');
    assert.equal(stopRun('chat-stop', tree.r.runId), true);
    await withTimeout(tree.r.done, 12_000, 'exit after stop');
    await assertTreeGone(tree);
    assert.equal(stopRun('chat-stop', tree.r.runId), false, 'a finished run cannot be stopped');
    assert.equal(tree.r.stop(), false);
    assert.equal(stopRun('chat-stop', 'no-such-run'), false);
    assert.equal(stopRun('other-chat', tree.r.runId), false, 'a run is only found under its own chat');
  });

  test('stopAll(chat) stops every run of that chat and no other', async () => {
    const a1 = await startTree('chat-x');
    const a2 = await startTree('chat-x');
    const b = await startTree('chat-y');
    try {
      await withTimeout(stopAll('chat-x'), 12_000, 'stopAll');
      await assertTreeGone(a1);
      await assertTreeGone(a2);
      assert.equal(a1.r.events.at(-1).kind, 'exit');
      assert.equal(a2.r.events.at(-1).kind, 'exit');
      assert.deepEqual(livePids(b.pids).sort(), [...b.pids].sort(), 'the other chat\'s run keeps running');
    } finally {
      b.r.stop();
      await withTimeout(b.r.done, 12_000, 'exit');
    }
    await withTimeout(stopAll('chat-none'), 1000, 'stopAll with no runs resolves at once');
  });

  test('stopEverything stops the runs of every chat', async () => {
    const a = await startTree('chat-e1');
    const b = await startTree('chat-e2');
    await withTimeout(stopEverything(), 12_000, 'stopEverything');
    await assertTreeGone(a);
    await assertTreeGone(b);
    assert.equal(a.r.events.at(-1).kind, 'exit');
    assert.equal(b.r.events.at(-1).kind, 'exit');
  });
});

describe('/api/chats/<id>/shell routes', () => {
  let dir;
  let fake;
  let ui;
  let ev;

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

  const isShell = (runId, kind) => (e) => e.type === 'shell' && e.data.runId === runId && (!kind || e.data.kind === kind);
  const postShell = (id, command) => api(ui, 'POST', `/api/chats/${id}/shell`, { body: { command } });

  test('a command runs in the repo, streams over SSE as shell events, and is logged without its output', async () => {
    fake.script('normal-turn');
    const id = await startChat(ui, ev);
    try {
      const since = ev.mark();
      const r = await postShell(id, nodeE("process.stdout.write('secret-output-'+'xyz')"));
      assert.equal(r.status, 200, r.text);
      const { runId } = r.json;
      assert.ok(runId);
      const exit = await ev.waitFor(isShell(runId, 'exit'), 10_000, since);
      assert.equal(exit.data.chatId, id);
      assert.equal(exit.data.code, 0);
      const mine = ev.events.slice(since).filter(isShell(runId));
      assert.equal(mine[0].data.kind, 'start');
      assert.equal(mine.filter((e) => e.data.kind === 'output').map((e) => e.data.data).join(''), 'secret-output-xyz');

      // 404 when stopping a run that has finished, or one that never existed.
      const stop = await api(ui, 'POST', `/api/chats/${id}/shell/${runId}/stop`);
      assert.equal(stop.status, 404);
      assert.equal(stop.json.error.code, 'not-found');

      // The log has the command, exit code and duration, never the output.
      const logged = readUiLog(dir).filter((l) => l.runId === runId);
      assert.ok(logged.some((l) => l.event === 'shell-exit' && l.code === 0 && typeof l.durationMs === 'number'));
      assert.ok(!JSON.stringify(readUiLog(dir)).includes('secret-output-xyz'));
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('400 for an empty or whitespace command, 404 for an unknown chat', async () => {
    fake.script('normal-turn');
    const id = await startChat(ui, ev);
    try {
      for (const body of [{ command: '' }, { command: '   ' }, {}, { command: 5 }]) {
        const r = await api(ui, 'POST', `/api/chats/${id}/shell`, { body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json.error.code, 'bad-request');
      }
      const unknown = await postShell('11111111-1111-4111-8111-111111111111', 'echo hi');
      assert.equal(unknown.status, 404);
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('Stop through the API kills the command and its child', async () => {
    fake.script('normal-turn');
    const id = await startChat(ui, ev);
    try {
      const since = ev.mark();
      const r = await postShell(id, TREE);
      assert.equal(r.status, 200, r.text);
      const { runId } = r.json;
      const out = await ev.waitFor((e) => isShell(runId, 'output')(e) && /\d+ \d+/.test(e.data.data), 10_000, since);
      const [, p1, p2] = /(\d+) (\d+)/.exec(out.data.data);
      const pids = [Number(p1), Number(p2)];
      for (const p of pids) leftovers.add(p);
      const pgid = IS_WIN ? null : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pids[0])], { encoding: 'utf8' }).trim());
      const images = imagesOf(pids);
      const stop = await api(ui, 'POST', `/api/chats/${id}/shell/${runId}/stop`);
      assert.equal(stop.status, 200, stop.text);
      assert.deepEqual(stop.json, { stopped: true });
      await ev.waitFor(isShell(runId, 'exit'), 12_000, since);
      await assertTreeGone({ pids, pgid, images });
    } finally {
      await stopChat(ui, ev, id);
    }
  });

  test('stopping the chat stops its running commands; then the chat is ended: 409 chat-ended', async () => {
    fake.script('normal-turn');
    const id = await startChat(ui, ev);
    const since = ev.mark();
    const r = await postShell(id, TREE);
    assert.equal(r.status, 200, r.text);
    const { runId } = r.json;
    const out = await ev.waitFor((e) => isShell(runId, 'output')(e) && /\d+ \d+/.test(e.data.data), 10_000, since);
    const [, p1, p2] = /(\d+) (\d+)/.exec(out.data.data);
    const pids = [Number(p1), Number(p2)];
    for (const p of pids) leftovers.add(p);
    const pgid = IS_WIN ? null : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pids[0])], { encoding: 'utf8' }).trim());
    const images = imagesOf(pids);

    await stopChat(ui, ev, id);
    await ev.waitFor(isShell(runId, 'exit'), 12_000, since);
    await assertTreeGone({ pids, pgid, images });

    const ended = await postShell(id, 'echo hi');
    assert.equal(ended.status, 409);
    assert.equal(ended.json.error.code, 'chat-ended');
  });

  test('the server shutting down stops running commands', async () => {
    fake.script('normal-turn');
    const id = await startChat(ui, ev);
    const since = ev.mark();
    const r = await postShell(id, TREE);
    assert.equal(r.status, 200, r.text);
    const { runId } = r.json;
    const out = await ev.waitFor((e) => isShell(runId, 'output')(e) && /\d+ \d+/.test(e.data.data), 10_000, since);
    const [, p1, p2] = /(\d+) (\d+)/.exec(out.data.data);
    const pids = [Number(p1), Number(p2)];
    for (const p of pids) leftovers.add(p);
    const pgid = IS_WIN ? null : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pids[0])], { encoding: 'utf8' }).trim());
    const images = imagesOf(pids);
    ev.close();
    ev = null;
    assert.equal(await ui.close(), 0);
    await assertTreeGone({ pids, pgid, images });
  });
});
