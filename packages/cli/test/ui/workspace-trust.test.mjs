// Chat reliability plan (docs/plans/shipline-chat-reliability.md), D. Workspace trust: trust.mjs sets
// projects["<repo path>"].hasTrustDialogAccepted = true in Claude Code's ~/.claude.json and nothing else.
// (Named workspace-trust.test.mjs because test/trust.test.mjs covers the Trust plan.)
// Every test uses a temp home (opts.home, or HOME / USERPROFILE / CLAUDE_CONFIG_DIR pointed at a temp folder for
// the route), never the real ~/.claude.json.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeFor, makeRepo, removeDir, storeOf, tmpDir } from '../helpers.mjs';
import { api, startUi } from './helpers.mjs';
import { claudeConfigFile, trustRepo } from '../../src/ui/trust.mjs';
import { initLog } from '../../src/ui/log.mjs';

const IS_WIN = process.platform === 'win32';
const POSIX_ONLY = IS_WIN && 'Windows has no POSIX file modes (chmod only toggles read-only)';
const dirs = [];
after(() => {
  for (const d of dirs) removeDir(d);
});

// { root, home, file } with root a repo-like folder and home a fake home holding .claude.json (when `config` is set).
function scratch(config) {
  const base = tmpDir('shipline-trust-');
  dirs.push(base);
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const file = path.join(home, '.claude.json');
  if (config !== undefined) writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return { base, root, home, file };
}

const opts = (home) => ({ home, env: {} }); // env: {} so a CLAUDE_CONFIG_DIR in the test's own environment is ignored
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const leftovers = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const throwsHttp = (fn, status, code) =>
  assert.throws(fn, (e) => {
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });

describe('trustRepo', () => {
  test('sets only projects[path].hasTrustDialogAccepted; every other key survives as parsed JSON', () => {
    const original = {
      numStartups: 42,
      oauthAccount: { emailAddress: 'dev@example.com', organizationUuid: 'org-1' },
      tipsHistory: { 'shift-tab': 3 },
      nested: { list: [1, 'two', { three: null }], flag: false },
      projects: {
        '/some/other/repo': { allowedTools: ['Bash'], hasTrustDialogAccepted: false },
      },
    };
    const { root, home, file } = scratch(original);
    original.projects[root] = { allowedTools: [], history: [{ display: 'hi' }], hasTrustDialogAccepted: false };
    writeFileSync(file, JSON.stringify(original));

    const r = trustRepo(root, root, opts(home));
    assert.deepEqual(r, { trusted: true, takesEffect: 'next chat' });

    const expected = structuredClone(original);
    expected.projects[root].hasTrustDialogAccepted = true;
    assert.deepEqual(read(file), expected);
    assert.deepEqual(leftovers(home), [], 'no temp file left behind');
  });

  test('creates projects and the entry when missing (and replaces a projects value that is not an object)', () => {
    const { root, home, file } = scratch({ numStartups: 1 });
    trustRepo(root, root, opts(home));
    assert.deepEqual(read(file), { numStartups: 1, projects: { [root]: { hasTrustDialogAccepted: true } } });

    writeFileSync(file, JSON.stringify({ projects: ['odd'] }));
    trustRepo(root, root, opts(home));
    assert.deepEqual(read(file), { projects: { [root]: { hasTrustDialogAccepted: true } } });
  });

  test('a path that is not this repo gives 400 bad-path and the file is untouched', () => {
    const { base, root, home, file } = scratch({ projects: {} });
    const other = path.join(base, 'other');
    mkdirSync(other);
    const before = readFileSync(file, 'utf8');
    for (const p of [other, path.join(base, 'missing'), 'repo', '', undefined, null, 42, { path: root }])
      throwsHttp(() => trustRepo(root, p, opts(home)), 400, 'bad-path');
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  test('a path given through a symlink to the repo is accepted and used exactly as given', { skip: IS_WIN && 'creating symlinks on Windows needs Developer Mode or admin rights' }, () => {
    const { base, root, home, file } = scratch({});
    const link = path.join(base, 'link');
    symlinkSync(root, link, 'dir');
    trustRepo(root, link, opts(home));
    assert.deepEqual(read(file), { projects: { [link]: { hasTrustDialogAccepted: true } } });
  });

  test('an unparsable file gives 500 claude-config-unreadable and nothing is written', () => {
    for (const text of ['{ not json', '[1, 2]', 'null', '"text"', '']) {
      const { root, home, file } = scratch(text);
      throwsHttp(() => trustRepo(root, root, opts(home)), 500, 'claude-config-unreadable');
      assert.equal(readFileSync(file, 'utf8'), text);
      assert.deepEqual(leftovers(home), []);
    }
  });

  test('a missing file gives 409 claude-config-missing ("open Claude Code once") and creates nothing', () => {
    const { root, home, file } = scratch();
    assert.throws(
      () => trustRepo(root, root, opts(home)),
      (e) => e.status === 409 && e.code === 'claude-config-missing' && /open Claude Code once/.test(e.message),
    );
    assert.ok(!existsSync(file));
    assert.deepEqual(readdirSync(home), []);
  });

  test('the write is a rename of a same-folder temp file that keeps the original mode, whatever the umask', { skip: POSIX_ONLY }, () => {
    for (const mode of [0o600, 0o644, 0o640]) {
      const { root, home, file } = scratch({ projects: {} });
      chmodSync(file, mode);
      const inode = statSync(file).ino;
      const old = process.umask(0o077);
      try {
        trustRepo(root, root, opts(home));
      } finally {
        process.umask(old);
      }
      assert.equal(statSync(file).mode & 0o777, mode, `mode ${mode.toString(8)} kept`);
      assert.notEqual(statSync(file).ino, inode, 'replaced by a rename, not written in place');
      assert.deepEqual(leftovers(home), []);
    }
  });

  test('a write failure leaves the original file and no temp file (500 claude-config-unwritable)', { skip: POSIX_ONLY || (process.getuid && process.getuid() === 0 && 'root ignores folder permissions') }, () => {
    const { root, home, file } = scratch({ projects: {} });
    const before = readFileSync(file, 'utf8');
    chmodSync(home, 0o500); // no new files in the folder
    try {
      throwsHttp(() => trustRepo(root, root, opts(home)), 500, 'claude-config-unwritable');
    } finally {
      chmodSync(home, 0o700);
    }
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(leftovers(home), []);
  });

  test('logs only the path and the outcome, never the file\'s contents', () => {
    const repo = makeRepo();
    dirs.push(repo);
    process.env.SHIPLINE_HOME = homeFor(repo); // initLog puts ui.log in the repo's store under SHIPLINE_HOME
    initLog(repo);
    const { home, file } = scratch({ oauthAccount: { emailAddress: 'secret-person@example.com' } });
    trustRepo(repo, repo, opts(home));
    throwsHttp(() => trustRepo(repo, path.join(home), opts(home)), 400, 'bad-path');
    writeFileSync(file, '{ broken secret-person@example.com');
    throwsHttp(() => trustRepo(repo, repo, opts(home)), 500, 'claude-config-unreadable');
    const lines = readFileSync(path.join(storeOf(repo), 'ui', 'ui.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'trust');
    assert.deepEqual(lines.map((l) => l.outcome), ['trusted', 'bad-path', 'config-unreadable']);
    for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['event', 'outcome', 'path', 'ts']);
    assert.ok(!readFileSync(path.join(storeOf(repo), 'ui', 'ui.log'), 'utf8').includes('secret-person'));
  });
});

describe('claudeConfigFile', () => {
  test('~/.claude.json by default; with CLAUDE_CONFIG_DIR, its own .claude.json or its parent\'s, whichever exists', () => {
    const { base, home } = scratch();
    const cfg = path.join(base, 'cfg', '.claude');
    mkdirSync(cfg, { recursive: true });
    assert.equal(claudeConfigFile({ home, env: {} }), path.join(home, '.claude.json'));
    assert.equal(claudeConfigFile({ home, env: { CLAUDE_CONFIG_DIR: cfg } }), path.join(home, '.claude.json'), 'neither exists: the home file');
    writeFileSync(path.join(base, 'cfg', '.claude.json'), '{}');
    assert.equal(claudeConfigFile({ home, env: { CLAUDE_CONFIG_DIR: cfg } }), path.join(base, 'cfg', '.claude.json'));
    writeFileSync(path.join(cfg, '.claude.json'), '{}');
    assert.equal(claudeConfigFile({ home, env: { CLAUDE_CONFIG_DIR: cfg } }), path.join(cfg, '.claude.json'));
  });
});

describe('POST /api/trust', () => {
  let repo;
  let ui;
  let fakeHome;
  const saved = {};
  const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'];

  before(async () => {
    repo = makeRepo(); // before HOME moves, so git sees the real global config
    dirs.push(repo);
    // Every place trust.mjs could look is a temp folder: HOME / USERPROFILE (os.homedir()) and CLAUDE_CONFIG_DIR.
    fakeHome = tmpDir('shipline-trust-home-');
    dirs.push(fakeHome);
    mkdirSync(path.join(fakeHome, '.claude'));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, '.claude');
    assert.equal(os.homedir(), fakeHome, 'os.homedir() follows the temp home');
    assert.equal(claudeConfigFile(), path.join(fakeHome, '.claude.json'));
    ui = await startUi(repo);
  });

  after(async () => {
    if (ui) await ui.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const file = () => path.join(fakeHome, '.claude.json');

  test('a missing ~/.claude.json gives 409 claude-config-missing', async () => {
    const r = await api(ui, 'POST', '/api/trust', { body: { path: repo } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'claude-config-missing');
    assert.ok(!existsSync(file()));
  });

  test('the repo path is trusted: { trusted: true, takesEffect: "next chat" }', async () => {
    writeFileSync(file(), JSON.stringify({ keep: 'me', projects: {} }));
    const r = await api(ui, 'POST', '/api/trust', { body: { path: repo } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { trusted: true, takesEffect: 'next chat' });
    assert.deepEqual(read(file()), { keep: 'me', projects: { [repo]: { hasTrustDialogAccepted: true } } });
  });

  test('another path gives 400 bad-path', async () => {
    const before = readFileSync(file(), 'utf8');
    for (const body of [{ path: fakeHome }, { path: 'relative' }, {}]) {
      const r = await api(ui, 'POST', '/api/trust', { body });
      assert.equal(r.status, 400, r.text);
      assert.equal(r.json.error.code, 'bad-path');
    }
    assert.equal(readFileSync(file(), 'utf8'), before);
  });

  test('an unparsable file gives 500 claude-config-unreadable and is left as it was', async () => {
    writeFileSync(file(), '{ nope');
    const r = await api(ui, 'POST', '/api/trust', { body: { path: repo } });
    assert.equal(r.status, 500, r.text);
    assert.equal(r.json.error.code, 'claude-config-unreadable');
    assert.equal(readFileSync(file(), 'utf8'), '{ nope');
    assert.ok(!r.text.includes('nope'), 'the contents are never returned');
  });
});
