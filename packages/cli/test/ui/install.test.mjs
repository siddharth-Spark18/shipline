// Setup wizard plan, C, E and F: `shipline ui` in a folder without Shipline serves the install wizard ("install
// mode"), which writes nothing to the repo or the store until POST /api/install, and then switches the same
// server (port, cookie) to the normal UI. The real server runs in-process on temp repos. Node 20+.
import { test, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInit as runInitInProcess } from '../../src/init.mjs';
import { homeFor, makeRepo, removeDir, runInit, storeOf, tmpDir } from '../helpers.mjs';
import { api, openEvents, startUi } from './helpers.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const AGENT = (n) => `.claude/agents/${n}.md`;

const dirs = [];
const servers = [];
// Each test closes its servers: one in repo mode keeps a task watch, which (all servers sharing this process's
// SHIPLINE_HOME) would otherwise create its store in the next test's home.
afterEach(async () => {
  for (const u of servers.splice(0)) await u.close();
});
after(() => dirs.forEach(removeDir));

// A git repo with one commit and no Shipline (README.md, src/a.js), plus optional team files { rel: text }.
function cleanRepo(files = {}) {
  const dir = makeRepo({ init: false });
  dirs.push(dir);
  write(dir, files);
  return dir;
}

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

async function start(dir) {
  const u = await startUi(dir);
  servers.push(u);
  return u;
}

// { relative posix path: sha256 } of every file under dir (skipping .git); null when dir doesn't exist.
function tree(dir) {
  if (!existsSync(dir)) return null;
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' && d === dir) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = lstatSync(full).isFile() ? sha(readFileSync(full)) : 'other';
    }
  };
  walk(dir);
  return out;
}

const info = async (u) => {
  const r = await api(u, 'GET', '/api/install/info');
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const preview = (u, selection) => api(u, 'POST', '/api/install/preview', { body: { selection } });
const install = (u, selection, base) => api(u, 'POST', '/api/install', { body: { selection, base } });

// Everything Install could touch: the repo's files and the repo's SHIPLINE_HOME.
const snapshot = (dir) => ({ files: tree(dir), home: tree(homeFor(dir)) });

// runInit in this process with the questions answered by `selection` (console output dropped).
async function initWith(dir, selection, extra = {}) {
  process.env.SHIPLINE_HOME = homeFor(dir);
  const log = console.log;
  const error = console.error;
  const err = [];
  console.log = () => {};
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await runInitInProcess({ target: dir, prompts: async () => selection, ...extra });
    assert.equal(code, 0, err.join('\n'));
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('install mode', () => {
  test('starts in a clean repo, from a subfolder too: status mode install with the git root; nothing written', async () => {
    const dir = cleanRepo();
    const before = snapshot(dir);
    const u = await start(path.join(dir, 'src'));
    const s = await api(u, 'GET', '/api/status');
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(s.json, { mode: 'install', root: dir, state: 'clean', uiVersion: s.json.uiVersion });
    assert.match(s.json.uiVersion, /^\d+\.\d+\.\d+$/);
    assert.equal((await info(u)).isGit, true);
    assert.deepEqual(snapshot(dir), before, 'starting install mode writes nothing (no store, no UI log)');
    assert.deepEqual(before.home, {}, 'the repo\'s SHIPLINE_HOME is empty');
  });

  test('a folder outside git installs at the folder itself, with isGit false', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const u = await start(dir);
    assert.equal((await api(u, 'GET', '/api/status')).json.root, dir);
    const i = await info(u);
    assert.equal(i.isGit, false);
    assert.equal(i.root, dir);
    const p = await preview(u, i.defaults);
    assert.equal(p.status, 200, p.text);
    const r = await install(u, i.defaults, p.json.base);
    assert.equal(r.status, 200, r.text);
    assert.ok(existsSync(path.join(dir, '.shipline', 'config.yml')));
    assert.equal((await api(u, 'GET', '/api/status')).json.mode, 'repo');
  });

  test('every other API route gives 409 not-installed; static files and the auth checks are as in normal mode', async () => {
    const dir = cleanRepo();
    const u = await start(dir);
    for (const [method, p] of [
      ['GET', '/api/setup'],
      ['GET', '/api/tasks'],
      ['GET', '/api/diagnostics'],
      ['GET', '/api/events'],
      ['GET', '/api/nope'],
      ['POST', '/api/setup/save'],
      ['POST', '/api/setup/add-workflow'],
      ['GET', '/api/install'],
    ]) {
      const r = await api(u, method, p, method === 'POST' ? { body: {} } : {});
      assert.equal(r.status, 409, `${method} ${p}: ${r.text}`);
      assert.equal(r.json.error.code, 'not-installed', `${method} ${p}`);
    }
    const page = await api(u, 'GET', '/');
    assert.notEqual(page.status, 409);
    assert.ok(!page.json, 'the app (or the "not built" text), not an API error');
    // The same cookie, Origin and Host checks as in normal mode.
    assert.equal((await api(u, 'GET', '/api/install/info', { cookie: null })).status, 401);
    assert.equal((await api(u, 'GET', '/api/status', { cookie: 'shipline_ui_1=nope' })).status, 401);
    assert.equal((await api(u, 'POST', '/api/install/preview', { body: {}, origin: 'http://evil.example' })).status, 403);
    assert.equal((await api(u, 'POST', '/api/install/preview', { body: {}, origin: null })).status, 403);
  });
});

describe('GET /api/install/info and POST /api/install/preview', () => {
  test('info: workflows with stages, agents with descriptions and usedBy, the repo\'s own, detection and defaults; no file contents', async () => {
    const dir = cleanRepo({ [AGENT('mine')]: '# mine\n', '.claude/skills/deploy/SKILL.md': '# Deploy\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { vue: '3' } }) });
    const u = await start(dir);
    const i = await info(u);
    assert.equal(i.root, dir);
    assert.equal(i.state, 'clean');
    assert.deepEqual(i.found, []);
    assert.deepEqual(i.workflows.map((w) => w.id), ['bugfix', 'feature', 'hotfix', 'small']);
    for (const w of i.workflows) {
      assert.deepEqual(Object.keys(w).sort(), ['description', 'id', 'name', 'stages']);
      for (const st of w.stages) assert.deepEqual(Object.keys(st).sort(), ['agent', 'condition', 'id', 'name']);
    }
    assert.deepEqual(i.agents.map((a) => a.name), ['planner', 'builder', 'reviewer', 'qa-bug-hunter', 'wireframe-proposer', 'researcher']);
    for (const a of i.agents) {
      assert.deepEqual(Object.keys(a).sort(), ['description', 'name', 'usedBy']);
      assert.ok(a.description.length > 10, a.name);
    }
    assert.deepEqual(i.agents.find((a) => a.name === 'reviewer').usedBy, []);
    assert.deepEqual(i.agents.find((a) => a.name === 'wireframe-proposer').usedBy, ['feature.wireframes']);
    assert.deepEqual(i.repoAgents, ['mine']);
    assert.deepEqual(i.repoSkills, ['deploy']);
    assert.equal(i.uiDetected, true);
    assert.equal(i.detected.test, 'npm test');
    assert.equal(i.defaults.ui, true);
    assert.ok(!i.defaults.agents.includes('reviewer'));
    assert.ok(JSON.stringify(i).length < 20000, 'no template texts');
  });

  test('preview: files to create with their text, merge diffs for settings.json and CLAUDE.md, excluded, base; nothing written', async () => {
    const dir = cleanRepo({ 'CLAUDE.md': '# Team\n\nBe kind.\n', '.claude/settings.json': '{\n  "env": { "A": "1" }\n}\n' });
    const before = snapshot(dir);
    const u = await start(dir);
    const i = await info(u);
    const sel = { ...i.defaults, workflows: ['bugfix'], ui: false, agents: ['builder', 'qa-bug-hunter', 'researcher'] };
    const p = await preview(u, sel);
    assert.equal(p.status, 200, p.text);
    const byPath = Object.fromEntries(p.json.files.map((f) => [f.path, f]));
    assert.equal(byPath['.shipline/workflows/bugfix.yml'].action, 'create');
    assert.match(byPath['.shipline/workflows/bugfix.yml'].text, /^id: bugfix$/m);
    assert.ok(!byPath['.shipline/workflows/feature.yml']);
    assert.ok(!byPath['.shipline/rules/wireframes.md'] && !byPath['.shipline/rules/plan.md']);
    for (const n of ['planner', 'reviewer', 'wireframe-proposer']) assert.ok(!byPath[AGENT(n)], n);
    assert.equal(byPath[AGENT('builder')].action, 'create');
    assert.deepEqual(byPath['.shipline/bin/VERSION'], { path: '.shipline/bin/VERSION', action: 'create' });
    for (const rel of ['.claude/settings.json', 'CLAUDE.md']) {
      const f = byPath[rel];
      assert.equal(f.action, 'merge', rel);
      assert.equal(f.text, undefined);
      const lines = f.diff.flatMap((h) => h.lines);
      assert.ok(lines.some((l) => l.type === 'add'), rel);
    }
    assert.ok(byPath['CLAUDE.md'].diff.flatMap((h) => h.lines).some((l) => l.type === 'add' && l.text === '<!-- shipline:start -->'));
    assert.deepEqual(p.json.excluded, ['planner', 'reviewer', 'wireframe-proposer'].map(AGENT));
    assert.deepEqual(p.json.collisions, []);
    assert.deepEqual(p.json.base, { settings: sha('{\n  "env": { "A": "1" }\n}\n'), claudeMd: sha('# Team\n\nBe kind.\n') });
    assert.deepEqual(snapshot(dir), before, 'info and preview write nothing to the repo or the store');
  });

  test('preview: missing merge targets are created (with text) and their base is null; collisions are listed', async () => {
    const dir = cleanRepo({ '.claude/skills/shipline-setup/SKILL.md': 'mine\n' });
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, { ...i.defaults, ci: true });
    assert.equal(p.status, 200, p.text);
    const byPath = Object.fromEntries(p.json.files.map((f) => [f.path, f]));
    assert.equal(byPath['CLAUDE.md'].action, 'create');
    assert.match(byPath['CLAUDE.md'].text, /<!-- shipline:start -->/);
    assert.equal(byPath['.claude/settings.json'].action, 'create');
    assert.ok(byPath['.github/workflows/shipline.yml']);
    assert.deepEqual(p.json.base, { settings: null, claudeMd: null });
    assert.deepEqual(p.json.collisions, ['.claude/skills/shipline-setup/SKILL.md']);
    // Install refuses while there is a collision.
    const r = await install(u, { ...i.defaults, ci: true }, p.json.base);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'collision');
  });

  test('"use ours" on a clash is an overwrite', async () => {
    const dir = cleanRepo({ [AGENT('builder')]: '# our builder\n' });
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, { ...i.defaults, clashes: { builder: 'ours' } });
    assert.equal(p.status, 200, p.text);
    const f = p.json.files.find((x) => x.path === AGENT('builder'));
    assert.equal(f.action, 'overwrite');
    assert.match(f.text, /^---/);
  });

  test('a selection with a missing or wrong-typed field gives 400 invalid with checkSelection\'s message', async () => {
    const dir = cleanRepo();
    const before = snapshot(dir);
    const u = await start(dir);
    const i = await info(u);
    const drop = (k) => {
      const s = { ...i.defaults };
      delete s[k];
      return s;
    };
    for (const [body, msg] of [
      [{ selection: drop('ui') }, /invalid selection: ui is required/],
      [{ selection: drop('commands') }, /commands is required/],
      [{ selection: { ...i.defaults, ci: 'yes' } }, /ci must be true or false/],
      [{ selection: { ...i.defaults, workflows: [] } }, /choose at least one workflow/],
      [{ selection: { ...i.defaults, commands: { test: '' } } }, /commands must have test, lint and build/],
      [{}, /invalid selection: not an object/],
      [[], /Expected \{ selection \}/],
    ]) {
      const r = await api(u, 'POST', '/api/install/preview', { body });
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      assert.equal(r.json.error.code, 'invalid');
      assert.match(r.json.error.message, msg);
    }
    for (const base of [undefined, null, {}, { settings: null }, { settings: '', claudeMd: null }, { settings: 1, claudeMd: null }]) {
      const r = await install(u, i.defaults, base);
      assert.equal(r.status, 400, `${JSON.stringify(base)}: ${r.text}`);
      assert.equal(r.json.error.code, 'invalid');
    }
    assert.deepEqual(snapshot(dir), before);
  });

  test('a .claude/settings.json that does not parse gives 400 bad-settings', async () => {
    const dir = cleanRepo({ '.claude/settings.json': '{ nope' });
    const u = await start(dir);
    const i = await info(u);
    const r = await preview(u, i.defaults);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.code, 'bad-settings');
  });
});

describe('POST /api/install', () => {
  test('installs, then the same port and cookie serve the normal UI: status mode repo, the full routes, events, ui.log', async () => {
    const dir = cleanRepo();
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, i.defaults);
    assert.equal(p.status, 200, p.text);
    const created = p.json.files.filter((f) => f.action === 'create').map((f) => f.path).sort();
    const r = await install(u, i.defaults, p.json.base);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { installed: true });
    // Exactly the files Review listed.
    const files = Object.keys(tree(dir)).filter((f) => !['README.md', 'src/a.js'].includes(f)).sort();
    assert.deepEqual(files, created);
    for (const n of ['wireframe-proposer', 'reviewer']) assert.ok(!existsSync(path.join(dir, AGENT(n))), n);

    const s = await api(u, 'GET', '/api/status');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.mode, 'repo');
    assert.equal(s.json.root, dir);
    assert.equal(s.json.storeDir, storeOf(dir));
    assert.equal(s.json.versionState, 'same');
    const setup = await api(u, 'GET', '/api/setup');
    assert.equal(setup.status, 200, setup.text);
    assert.deepEqual(setup.json.workflows.map((w) => w.id), ['bugfix', 'feature', 'hotfix', 'small']);
    assert.equal((await api(u, 'GET', '/api/tasks')).status, 200);
    assert.equal((await api(u, 'GET', '/api/diagnostics')).json.port, u.port);
    const ev = await openEvents(u);
    ev.close();
    // The UI log is in the new store, with the start and the install.
    const log = readFileSync(path.join(storeOf(dir), 'ui', 'ui.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(log.some((e) => e.event === 'start' && e.root === dir));
    assert.ok(log.some((e) => e.event === 'installed' && e.root === dir && e.ui === false));
    // A second tab pressing Install, or a wizard reloading late: 409 installed (the wizard then reloads).
    for (const [method, pth, body] of [
      ['POST', '/api/install', { selection: i.defaults, base: p.json.base }],
      ['POST', '/api/install/preview', { selection: i.defaults }],
      ['GET', '/api/install/info'],
    ]) {
      const again = await api(u, method, pth, body ? { body } : {});
      assert.equal(again.status, 409, `${pth}: ${again.text}`);
      assert.equal(again.json.error.code, 'installed');
    }
  });

  test('409 changed: a merge target changed since Review; nothing is written', async () => {
    const dir = cleanRepo({ 'CLAUDE.md': '# Team\n' });
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, i.defaults);
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Team, edited\n');
    const before = snapshot(dir);
    const r = await install(u, i.defaults, p.json.base);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'changed');
    assert.deepEqual(r.json.error.details, { paths: ['CLAUDE.md'] });
    assert.deepEqual(snapshot(dir), before);
    assert.equal((await api(u, 'GET', '/api/status')).json.mode, 'install');
    // Review again: a fresh base installs.
    const p2 = await preview(u, i.defaults);
    assert.equal((await install(u, i.defaults, p2.json.base)).status, 200);
  });

  test('409 collision: a path to create now exists; nothing is written', async () => {
    const dir = cleanRepo();
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, i.defaults);
    write(dir, { '.shipline/rules/plan.md': 'ours\n' });
    const before = snapshot(dir);
    const r = await install(u, i.defaults, p.json.base);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'collision');
    assert.deepEqual(r.json.error.details, { paths: ['.shipline/rules/plan.md'] });
    assert.deepEqual(snapshot(dir), before);
  });

  test('409 installed: a terminal `init` ran while the wizard was open; the server then serves the repo', async () => {
    const dir = cleanRepo();
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, i.defaults);
    assert.equal(runInit(dir).code, 0);
    const before = snapshot(dir);
    const r = await install(u, i.defaults, p.json.base);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'installed');
    assert.deepEqual(snapshot(dir).files, before.files, 'the install wrote nothing over init\'s files');
    // The wizard reloads: the same server now serves the normal UI.
    const s = await api(u, 'GET', '/api/status');
    assert.equal(s.json.mode, 'repo');
    assert.equal((await api(u, 'GET', '/api/setup')).status, 200);
  });

  test('a partial install: state partial with what was found; preview and Install give 409 installed and write nothing', async () => {
    const dir = cleanRepo({
      'CLAUDE.md': '# T\n\n<!-- shipline:start -->\nold\n<!-- shipline:end -->\n',
      '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .shipline/bin/guard.mjs' }] }] } }),
    });
    const before = snapshot(dir);
    const u = await start(dir);
    assert.equal((await api(u, 'GET', '/api/status')).json.state, 'partial');
    const i = await info(u);
    assert.equal(i.state, 'partial');
    assert.deepEqual(i.found, ['claude-md-block', 'hooks']);
    const p = await preview(u, i.defaults);
    assert.equal(p.status, 409, p.text);
    assert.equal(p.json.error.code, 'installed');
    assert.deepEqual(p.json.error.details, { state: 'partial', found: ['claude-md-block', 'hooks'] });
    const r = await install(u, i.defaults, { settings: null, claudeMd: null });
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(snapshot(dir), before);
    assert.equal((await api(u, 'GET', '/api/status')).json.mode, 'install');
  });

  test('a store that cannot be written: 500 install-failed with the store error, and nothing is written', async () => {
    const dir = cleanRepo();
    const u = await start(dir);
    const i = await info(u);
    const p = await preview(u, i.defaults);
    writeFileSync(path.join(homeFor(dir), 'projects'), 'not a folder\n');
    const before = tree(dir);
    const err = console.error;
    console.error = () => {};
    let r;
    try {
      r = await install(u, i.defaults, p.json.base);
    } finally {
      console.error = err;
    }
    assert.equal(r.status, 500, r.text);
    assert.equal(r.json.error.code, 'install-failed');
    assert.match(r.json.error.message, /Shipline can't write its task store/);
    assert.deepEqual(tree(dir), before);
    assert.equal((await api(u, 'GET', '/api/status')).json.mode, 'install');
  });
});

// Done-when 3: the same answers give byte-identical files from the wizard, interactive init and init --yes.
describe('the API install matches init byte for byte', () => {
  const TEAM = { 'CLAUDE.md': '# Team\r\n\r\nNotes.\r\n', [AGENT('planner')]: '# our planner\n', '.claude/skills/deploy/SKILL.md': '# Deploy\n' };

  async function viaApi(files, pick) {
    const dir = cleanRepo(files);
    const u = await start(dir);
    const i = await info(u);
    const sel = pick(i);
    const p = await preview(u, sel);
    assert.equal(p.status, 200, p.text);
    const r = await install(u, sel, p.json.base);
    assert.equal(r.status, 200, r.text);
    return { dir, sel };
  }

  test('the defaults: the wizard, init --yes and init answering the same', async () => {
    const files = { ...TEAM, 'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }) };
    const a = await viaApi(files, (i) => i.defaults);
    const b = cleanRepo(files);
    assert.equal(runInit(b).code, 0);
    const c = cleanRepo(files);
    await initWith(c, a.sel);
    const want = tree(a.dir);
    assert.ok(Object.keys(want).length > 20);
    assert.deepEqual(tree(b), want, 'init --yes');
    assert.deepEqual(tree(c), want, 'interactive init');
  });

  test('a custom selection with a UI: the wizard and interactive init', async () => {
    const files = { ...TEAM, 'web/index.html': '<p>\n' };
    const a = await viaApi(files, (i) => ({
      ...i.defaults,
      workflows: ['feature', 'small'],
      ui: true,
      agents: ['planner', 'builder', 'reviewer', 'wireframe-proposer'],
      clashes: { planner: 'ours' },
      stageAgents: { 'feature.feasibility': 'reviewer', 'feature.verify': null },
      skills: ['deploy'],
      commands: { test: 'npm test', lint: '', build: 'npm run build' },
      tracker: 'github',
      ci: true,
    }));
    const c = cleanRepo(files);
    await initWith(c, a.sel);
    assert.deepEqual(tree(c), tree(a.dir));
    assert.ok(existsSync(path.join(a.dir, '.github', 'workflows', 'shipline.yml')));
    assert.equal(readFileSync(path.join(a.dir, AGENT('planner')), 'utf8').startsWith('---'), true, 'ours replaced the team planner');
  });
});

// Teams Phase 4: the wizard's Standard/Light radio. Light goes through the API into config.yml; the defaults
// (no confirmations in the selection) and an unknown value install the template's standard with no error.
describe('the confirmations choice (Teams Phase 4)', () => {
  const confirmationsOf = (dir) => /^confirmations: (.*)$/m.exec(readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8'))[1];

  test("selection.confirmations 'light': the preview shows it and Install writes confirmations: light", async () => {
    const dir = cleanRepo();
    const u = await start(dir);
    const i = await info(u);
    assert.ok(!('confirmations' in i.defaults), 'the wizard preselects Standard (nothing sent means standard)');
    const sel = { ...i.defaults, confirmations: 'light' };
    const p = await preview(u, sel);
    assert.equal(p.status, 200, p.text);
    assert.match(p.json.files.find((f) => f.path === '.shipline/config.yml').text, /^confirmations: light$/m);
    const r = await install(u, sel, p.json.base);
    assert.equal(r.status, 200, r.text);
    assert.equal(confirmationsOf(dir), 'light');
    const setup = await api(u, 'GET', '/api/setup');
    assert.equal(setup.json.config.model.confirmations, 'light');
  });

  for (const confirmations of [undefined, 'standard', 'lite']) {
    test(`selection.confirmations ${confirmations === undefined ? 'missing' : `'${confirmations}'`}: standard, no error`, async () => {
      const dir = cleanRepo();
      const u = await start(dir);
      const i = await info(u);
      const sel = confirmations === undefined ? i.defaults : { ...i.defaults, confirmations };
      const p = await preview(u, sel);
      assert.equal(p.status, 200, p.text);
      const r = await install(u, sel, p.json.base);
      assert.equal(r.status, 200, r.text);
      assert.equal(confirmationsOf(dir), 'standard');
    });
  }
});
