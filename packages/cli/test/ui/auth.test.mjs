// Plan item 45, Auth (Goal 7): Host, Origin and cookie checks, the token exchange, and port handling.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BIN, CLI_ROOT, cleanEnv, homeFor, makeRepo, removeDir, storeOf, tmpDir } from '../helpers.mjs';
import { api, rawRequest, startUi } from './helpers.mjs';
import { safeEqual } from '../../src/ui/auth.mjs';
import { redact } from '../../src/ui/log.mjs';
import { INTERFACE } from '../../src/interface.mjs';
import { parseUiArgs } from '../../src/ui/server.mjs';

let dir;
let ui;

before(async () => {
  dir = makeRepo();
  ui = await startUi(dir);
});

after(async () => {
  if (ui) await ui.close();
  removeDir(dir);
});

describe('token exchange', () => {
  test('with port 0, /?t= sets shipline_ui_<real port> and redirects to /', async () => {
    assert.notEqual(ui.port, 0);
    const r = await fetch(ui.url, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/');
    assert.equal(r.headers.get('set-cookie'), `shipline_ui_${ui.port}=${ui.token}; HttpOnly; SameSite=Strict; Path=/`);
    assert.match(ui.token, /^[0-9a-f]{64}$/); // 32 random bytes
  });

  test('a wrong token gives 403, including a wrong length', async () => {
    for (const t of ['0'.repeat(64), 'short', '']) {
      const r = await fetch(`${ui.base}/?t=${t}`, { redirect: 'manual' });
      assert.equal(r.status, 403, t);
      assert.equal((await r.json()).error.code, 'bad-token');
      assert.equal(r.headers.get('set-cookie'), null);
    }
  });

  test('the cookie gives access to the API', async () => {
    const r = await api(ui, 'GET', '/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.root, dir);
    assert.equal(r.json.versionState, 'same');
  });
});

describe('status and diagnostics', () => {
  test('GET /api/status and /api/diagnostics report versions, root and watch mode', async () => {
    const pkg = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;
    const status = await api(ui, 'GET', '/api/status');
    const files = JSON.parse(readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8')).files;
    assert.ok(files && Object.keys(files).length > 0);
    assert.deepEqual(status.json, {
      mode: 'repo',
      uiVersion: pkg,
      repoVersion: { package: pkg, interface: INTERFACE, files, excluded: [] },
      versionState: 'same',
      root: dir,
      storeDir: storeOf(dir),
      versionMessage: null,
    });
    const d = await api(ui, 'GET', '/api/diagnostics');
    assert.equal(d.status, 200);
    assert.equal(d.json.root, dir);
    assert.equal(d.json.uiInterface, 1);
    assert.equal(d.json.storeDir, storeOf(dir));
    assert.equal(d.json.versionMessage, null);
    assert.ok(!('needsUpgrade' in d.json), 'the pre-store flag is gone');
    assert.equal(d.json.port, ui.port);
    assert.ok(['watch', 'poll'].includes(d.json.watchMode));
    assert.ok(Array.isArray(d.json.logTail) && d.json.logTail.length > 0);
  });
});

describe('Host check', () => {
  test('a wrong Host gives 403 on every kind of route', async () => {
    for (const host of ['localhost:' + ui.port, 'evil.example', `127.0.0.1:${ui.port + 1}`, '127.0.0.1', `127.0.0.1:0`]) {
      for (const p of ['/api/status', '/', `/?t=${ui.token}`]) {
        const r = await rawRequest(ui.port, { path: p, headers: { host, cookie: ui.cookie } });
        assert.equal(r.status, 403, `${host} ${p}`);
        assert.equal(r.json.error.code, 'bad-host');
        assert.equal(r.headers['set-cookie'], undefined);
      }
    }
  });

  test('the right Host (the real port) is accepted', async () => {
    const r = await rawRequest(ui.port, { path: '/api/status', headers: { host: `127.0.0.1:${ui.port}`, cookie: ui.cookie } });
    assert.equal(r.status, 200);
  });
});

describe('cookie check', () => {
  test('no cookie gives 401', async () => {
    const r = await api(ui, 'GET', '/api/tasks', { cookie: null });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json.error.code, 'no-session');
  });

  test('a cookie of the wrong length gives 401, not 500', async () => {
    for (const v of ['abc', ui.token + '00', '', 'é'.repeat(32)]) {
      const r = await api(ui, 'GET', '/api/setup', { cookie: `shipline_ui_${ui.port}=${v}` });
      assert.equal(r.status, 401, JSON.stringify(v));
      assert.equal(r.json.error.code, 'no-session');
    }
  });

  test('a wrong cookie of the right length gives 401', async () => {
    const r = await api(ui, 'GET', '/api/setup', { cookie: `shipline_ui_${ui.port}=${'f'.repeat(64)}` });
    assert.equal(r.status, 401);
  });

  test('the right token under another port\'s cookie name gives 401', async () => {
    const r = await api(ui, 'GET', '/api/setup', { cookie: `shipline_ui_${ui.port + 1}=${ui.token}` });
    assert.equal(r.status, 401);
  });

  test('the cookie is found among other cookies', async () => {
    const r = await api(ui, 'GET', '/api/status', { cookie: `a=b; ${ui.cookie}; c=d` });
    assert.equal(r.status, 200);
  });

  test('the SSE stream needs the cookie too', async () => {
    const r = await api(ui, 'GET', '/api/events', { cookie: null });
    assert.equal(r.status, 401);
  });

  // ui-dist/ is build output (gitignored); CI runs the tests before build-ui.mjs, so both states are valid.
  const built = existsSync(path.join(CLI_ROOT, 'ui-dist', 'index.html'));

  test('static files need no cookie; index.html is no-store', async () => {
    const r = await api(ui, 'GET', '/', { cookie: null });
    const unknown = await api(ui, 'GET', '/setup/whatever', { cookie: null });
    if (built) {
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /^text\/html/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(unknown.status, 200);
      assert.equal(unknown.text, r.text, 'unknown non-/api paths get index.html');
    } else {
      assert.equal(r.status, 404);
      assert.match(r.text, /not built/);
      assert.equal(unknown.status, 404);
    }
  });

  test('static assets get their Content-Type', { skip: built ? false : 'ui-dist is not built' }, async () => {
    const assets = readdirSync(path.join(CLI_ROOT, 'ui-dist', 'assets'));
    for (const [ext, type] of [['.js', /^text\/javascript/], ['.css', /^text\/css/], ['.woff2', /^font\/woff2$/]]) {
      const name = assets.find((f) => f.endsWith(ext));
      if (!name) continue;
      const r = await fetch(`${ui.base}/assets/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers.get('content-type'), type, name);
      assert.equal(r.headers.get('cache-control'), null, name);
      await r.arrayBuffer();
    }
  });

  test('an unknown /api path is a JSON 404, not the app', async () => {
    const r = await api(ui, 'GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not-found');
  });

  test('static paths cannot escape ui-dist', async () => {
    for (const p of ['/..%2f..%2fpackage.json', '/../../package.json', '/%2e%2e/%2e%2e/package.json']) {
      const r = await rawRequest(ui.port, { path: p });
      assert.ok([200, 404].includes(r.status), `${p}: ${r.status}`);
      assert.doesNotMatch(r.text, /"name": "shipline"/, p);
    }
  });
});

describe('Origin check on POST', () => {
  const body = { files: [{ kind: 'rules', id: 'plan', text: 'x', baseHash: 'nope' }] };

  test('a POST with no Origin gives 403', async () => {
    for (const p of ['/api/setup/preview', '/api/setup/save', '/api/setup/workflows']) {
      const r = await api(ui, 'POST', p, { body, origin: null });
      assert.equal(r.status, 403, p);
      assert.equal(r.json.error.code, 'bad-origin');
    }
  });

  test('a POST with a foreign Origin gives 403', async () => {
    for (const origin of ['http://evil.example', `http://localhost:${ui.port}`, `http://127.0.0.1:${ui.port + 1}`, 'null']) {
      const r = await api(ui, 'POST', '/api/setup/preview', { body, origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.json.error.code, 'bad-origin');
    }
  });

  test('POST /api/relay with any Origin gives 403', async () => {
    const r = await api(ui, 'POST', '/api/relay', { body: {}, origin: ui.origin, cookie: null });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'bad-origin');
  });

  test('a POST with the server\'s own Origin passes the check', async () => {
    const r = await api(ui, 'POST', '/api/setup/preview', { body: { files: [{ kind: 'rules', id: 'plan', text: 'x', baseHash: null }] } });
    assert.equal(r.status, 200);
  });

  test('a request body over 1 MB gives 413', async () => {
    const big = JSON.stringify({ files: [{ kind: 'rules', id: 'plan', text: 'x'.repeat(1024 * 1024 + 10), baseHash: null }] });
    const r = await api(ui, 'POST', '/api/setup/preview', { body: big });
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'too-large');
  });

  test('a body that is not JSON gives 400, not 500', async () => {
    const r = await api(ui, 'POST', '/api/setup/preview', { body: '{nope' });
    assert.equal(r.status, 400);
  });
});

describe('two servers', () => {
  test('different ports keep separate cookies', async () => {
    const other = await startUi(dir);
    try {
      assert.notEqual(other.port, ui.port);
      assert.ok(other.cookie.startsWith(`shipline_ui_${other.port}=`));
      assert.ok(ui.cookie.startsWith(`shipline_ui_${ui.port}=`));
      assert.notEqual(other.token, ui.token);
      // A browser sends both cookies to both ports; each server reads only its own.
      const both = `${ui.cookie}; ${other.cookie}`;
      assert.equal((await api(ui, 'GET', '/api/status', { cookie: both })).status, 200);
      assert.equal((await api(other, 'GET', '/api/status', { cookie: both })).status, 200);
      // One server's cookie value under the other's name doesn't work.
      assert.equal((await api(other, 'GET', '/api/status', { cookie: `shipline_ui_${other.port}=${ui.token}` })).status, 401);
    } finally {
      await other.close();
    }
  });
});

describe('dev origin', () => {
  test('SHIPLINE_UI_DEV_ORIGIN is accepted as an Origin', async () => {
    const dev = await startUi(dir, { env: { SHIPLINE_UI_DEV_ORIGIN: 'http://localhost:5173' } });
    try {
      const body = { files: [{ kind: 'rules', id: 'plan', text: 'x', baseHash: null }] };
      assert.equal((await api(dev, 'POST', '/api/setup/preview', { body, origin: 'http://localhost:5173' })).status, 200);
      assert.equal((await api(dev, 'POST', '/api/setup/preview', { body, origin: 'http://localhost:5174' })).status, 403);
    } finally {
      await dev.close();
    }
  });
});

describe('logging', () => {
  test('the token never appears in ui.log', async () => {
    await fetch(ui.url, { redirect: 'manual' });
    await fetch(`${ui.base}/?t=wrong`, { redirect: 'manual' });
    await api(ui, 'GET', '/api/diagnostics');
    assert.ok(!existsSync(path.join(dir, '.shipline', '.state')), 'nothing is logged inside the repo');
    const text = readFileSync(path.join(storeOf(dir), 'ui', 'ui.log'), 'utf8');
    assert.ok(text.length > 0);
    assert.ok(!text.includes(ui.token));
    const diag = await api(ui, 'GET', '/api/diagnostics');
    assert.ok(!diag.text.includes(ui.token));
  });
});

describe('redact', () => {
  test('replaces any key containing secret, token or cookie, at any depth', () => {
    assert.deepEqual(redact({ token: 'a', Cookie: 'b', relaySecret: 'c', nested: [{ sessionToken: 'd', ok: 1 }], fine: 'x' }), {
      token: '[redacted]',
      Cookie: '[redacted]',
      relaySecret: '[redacted]',
      nested: [{ sessionToken: '[redacted]', ok: 1 }],
      fine: 'x',
    });
  });
});

describe('safeEqual', () => {
  test('different lengths are a mismatch, never a throw', () => {
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', 'a'), false);
    assert.equal(safeEqual('é', 'ee'), false); // same string length, different byte length
    assert.equal(safeEqual('abc', 'abc'), true);
  });
});

describe('command line', () => {
  const ui = (args, cwd) => spawnSync(process.execPath, [BIN, 'ui', ...args], { cwd, env: cleanEnv(), encoding: 'utf8', timeout: 20000 });

  test('--port with a used port exits 1 with "Port <n> is in use"', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;
    try {
      const r = ui(['--dir', dir, '--port', String(port), '--no-open']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`Port ${port} is in use`));
    } finally {
      blocker.close();
    }
  });

  test('prints the tokened URL, and SIGINT shuts down with exit 0', { skip: process.platform === 'win32' && 'Node cannot send SIGINT to a child on Windows (child.kill terminates it, so the exit code is never 0); no Windows test covers Ctrl+C on `shipline ui`' }, async () => {
    const child = spawn(process.execPath, [BIN, 'ui', '--dir', dir, '--no-open'], { env: cleanEnv({ SHIPLINE_HOME: homeFor(dir) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 10000;
      while (!/\/\?t=/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})\n/.exec(out);
      assert.ok(m, out);
      const r = await fetch(m[0].trim(), { redirect: 'manual' });
      assert.equal(r.status, 302);
      child.kill('SIGINT');
      const started = Date.now();
      const { code } = await exited;
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 7000);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('an invalid --port value is a usage error (exit 2)', () => {
    for (const args of [['--port'], ['--port', 'abc'], ['--port', '70000'], ['--port', '-1']]) {
      const r = ui(['--dir', dir, ...args, '--no-open']);
      assert.equal(r.status, 2, args.join(' '));
      assert.ok(r.stderr.length > 0);
    }
  });

  // Setup wizard plan, C: no setup here starts the install wizard (test/ui/install.test.mjs has the rest).
  test('a folder with no Shipline setup starts the install wizard instead of exiting, and writes nothing', async () => {
    const empty = tmpDir();
    const home = homeFor(empty);
    const child = spawn(process.execPath, [BIN, 'ui', '--dir', empty, '--no-open'], { env: cleanEnv({ SHIPLINE_HOME: home }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      const deadline = Date.now() + 10000;
      while (!/\/\?t=/.test(out) && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 50));
      assert.match(out, new RegExp(`Shipline setup for ${empty.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\r?\\n`));
      assert.match(out, /Nothing is written until you press Install in the browser\./);
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})/.exec(out);
      assert.ok(m, out);
      const r = await fetch(m[0], { redirect: 'manual' });
      assert.equal(r.status, 302);
      const cookie = r.headers.get('set-cookie').split(';')[0];
      const status = await (await fetch(`http://127.0.0.1:${m[1]}/api/status`, { headers: { cookie } })).json();
      assert.equal(status.mode, 'install');
      assert.equal(status.state, 'clean');
      assert.deepEqual(readdirSync(empty), []);
      assert.deepEqual(readdirSync(home), [], 'no store and no UI log in install mode');
    } finally {
      child.kill('SIGKILL');
      await exited;
      removeDir(empty);
    }
  });

  test('an unwritable SHIPLINE_HOME exits 1 with "Shipline can\'t write its task store"', () => {
    const blockDir = tmpDir();
    try {
      writeFileSync(path.join(blockDir, 'a-file'), 'x');
      const r = spawnSync(process.execPath, [BIN, 'ui', '--dir', dir, '--no-open'], {
        env: cleanEnv({ SHIPLINE_HOME: path.join(blockDir, 'a-file', 'home') }),
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Shipline can't write its task store at /);
    } finally {
      removeDir(blockDir);
    }
  });

  // 1.0 plan, item 4: the folder is given only with --dir; anything else is a usage error (exit 2). The errors exit the
  // process, so they run through the bin.
  test('parseUiArgs: --dir <path> or --dir=<path>; flags in any order', () => {
    assert.deepEqual(parseUiArgs(['--port', '4000', '--dir', 'repo', '--no-open']), { dir: path.resolve('repo'), port: 4000, open: false, remote: false });
    assert.deepEqual(parseUiArgs(['--dir=repo', '--port=0']), { dir: path.resolve('repo'), port: 0, open: true, remote: false });
    assert.deepEqual(parseUiArgs([]), { dir: process.cwd(), port: 0, open: true, remote: false });
    assert.deepEqual(parseUiArgs(['--remote']), { dir: process.cwd(), port: 0, open: true, remote: true });
  });

  test('ui: a bare folder, an unknown option or --dir without a path exits 2; --help and -h print the usage', () => {
    for (const [args, re] of [
      [['repo'], /^shipline: unexpected argument repo \(use --dir\)\n$/],
      [['--dir', dir, 'extra'], /^shipline: unexpected argument extra \(use --dir\)\n$/],
      [['--bogus'], /^shipline: unknown option --bogus \(see shipline ui --help\)\n$/],
      [['--dir'], /^shipline: --dir needs a path/],
    ]) {
      const r = ui(args, dir);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
    }
    for (const h of ['--help', '-h']) {
      const r = ui([h], dir);
      assert.equal(r.status, 0, h);
      assert.match(r.stdout, /^Usage: npx @forgeyard\/shipline ui \[--dir <path>\] \[--port <n>\] \[--no-open\]/, h);
    }
  });

  test('ui resolves the repo from a subfolder and ignores CLAUDE_PROJECT_DIR', async () => {
    const { startServer } = await import('../../src/ui/server.mjs');
    const other = tmpDir();
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = other;
    const log = console.log;
    console.log = () => {};
    let handle;
    try {
      handle = await startServer({ dir: path.join(dir, 'src'), port: 0, open: false });
    } finally {
      console.log = log;
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
    const exit = process.exit;
    process.exit = () => {};
    try {
      const r = await fetch(handle.url, { redirect: 'manual' });
      const cookie = r.headers.get('set-cookie').split(';')[0];
      const status = await (await fetch(`http://127.0.0.1:${handle.port}/api/status`, { headers: { cookie } })).json();
      assert.equal(status.root, dir);
    } finally {
      await handle.close();
      process.exit = exit;
      removeDir(other);
    }
  });
});
