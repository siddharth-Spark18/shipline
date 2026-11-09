// Setup wizard plan, A, B and F: src/install.mjs, the selection and planning code `init` and the browser wizard
// share. planInstall reads and writes nothing; applyInstall writes all or nothing, and with a base re-checks the
// repo first. The last part checks the plan's key promise: the same selection gives byte-identical files through
// interactive `init` (questions stubbed), `init --yes` and applyInstall. Node 18+.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BRANCH_PATTERN, GUARDRAILS_OFF_NOTE, applyInstall, baseHashes, checkSelection, defaultAgents, defaultSelection,
  fillSelection, installInfo, installState, missingStageAgents, nextSteps, planInstall,
} from '../src/install.mjs';
import { RAIL_IDS, branchPatternError } from '../src/setup-schema.mjs';
import { runInit as runInitInProcess } from '../src/init.mjs';
import { RAIL_IDS as HOOK_RAIL_IDS, loadConfig, parseYaml } from '../templates/shipline/bin/lib.mjs';
import { CLI_ROOT, TEMPLATES, homeFor, removeDir, runInit, storeOf, tmpDir } from './helpers.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const AGENT = (n) => `.claude/agents/${n}.md`;
const ALL_WORKFLOWS = ['bugfix', 'feature', 'hotfix', 'small'];
const ALL_AGENTS = ['planner', 'builder', 'reviewer', 'qa-bug-hunter', 'wireframe-proposer', 'researcher'];
const wfTemplate = (id) => readFileSync(path.join(TEMPLATES, 'workflows', `${id}.yml`), 'utf8');

const dirs = [];
after(() => dirs.forEach(removeDir));

// A temp folder (no git needed) with optional team files { rel: text }. Its SHIPLINE_HOME is used in-process.
function repo(files = {}) {
  const dir = tmpDir();
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  process.env.SHIPLINE_HOME = homeFor(dir);
  return dir;
}

// { relative posix path: sha256 } of every file under dir (skipping .git).
function tree(dir) {
  const out = {};
  if (!existsSync(dir)) return null;
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

const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const versionOf = (dir) => JSON.parse(read(dir, '.shipline/bin/VERSION'));
const paths = (plan) => plan.writes.map((w) => w.to);

// A complete selection (every field, as the API requires).
const full = (info, patch = {}) => ({ ...defaultSelection(info), ...patch });

// runInit in this process, with the questions answered by `answer` and console output captured.
async function initWith(dir, answer, extra = {}) {
  process.env.SHIPLINE_HOME = homeFor(dir);
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await runInitInProcess({ target: dir, prompts: async (info) => (typeof answer === 'function' ? answer(info) : answer), confirm: async () => true, ...extra });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('installState and installInfo', () => {
  test('clean, installed (config.yml) and partial (the CLAUDE.md block and/or Shipline\'s hooks)', () => {
    const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .shipline/bin/guard.mjs' }] }] } });
    const block = '# T\n\n<!-- shipline:start -->\nx\n<!-- shipline:end -->\n';
    assert.deepEqual(installState(repo()), { state: 'clean', found: [] });
    assert.deepEqual(installState(repo({ 'CLAUDE.md': '# Team notes\n', '.claude/settings.json': '{"hooks":{}}' })), { state: 'clean', found: [] });
    assert.deepEqual(installState(repo({ '.shipline/config.yml': 'tracker: jira\n', 'CLAUDE.md': block })), { state: 'installed', found: [] });
    assert.deepEqual(installState(repo({ 'CLAUDE.md': block })), { state: 'partial', found: ['claude-md-block'] });
    assert.deepEqual(installState(repo({ '.claude/settings.json': hooks })), { state: 'partial', found: ['hooks'] });
    assert.deepEqual(installState(repo({ 'CLAUDE.md': block, '.claude/settings.json': hooks })), { state: 'partial', found: ['claude-md-block', 'hooks'] });
  });

  test('installInfo: what ships, what the repo has, which stages use each agent, and the detected UI', () => {
    const dir = repo({ [AGENT('mine')]: 'x\n', '.claude/skills/deploy/SKILL.md': 'x\n', 'web/index.html': 'x' });
    const info = installInfo(dir);
    assert.deepEqual(info.workflows.map((w) => w.id), ALL_WORKFLOWS);
    assert.deepEqual(info.workflows.find((w) => w.id === 'feature').stages.find((s) => s.id === 'wireframes'), {
      id: 'wireframes',
      name: 'Wireframes',
      agent: 'wireframe-proposer',
      condition: 'ui_only',
    });
    assert.deepEqual(info.agents, ALL_AGENTS);
    assert.deepEqual(info.repoAgents, ['mine']);
    assert.deepEqual(info.repoSkills, ['deploy']);
    assert.equal(info.uiDetected, true);
    assert.equal(info.state, 'clean');
    assert.deepEqual(info.agentUse.reviewer, [], 'reviewer is standalone');
    assert.deepEqual(info.agentUse['wireframe-proposer'], ['feature.wireframes']);
    assert.deepEqual(info.agentUse.planner, ['feature.plan']);
    assert.ok(info.agentUse.builder.includes('bugfix.fix') && info.agentUse.builder.includes('feature.implement'));
    assert.equal(installInfo(repo()).uiDetected, false);
  });
});

describe('defaultSelection, fillSelection and checkSelection', () => {
  test('defaults: every workflow, ui from detection, stage agents only, reviewer off, keep on every clash', () => {
    const noUi = defaultSelection(installInfo(repo({ [AGENT('planner')]: 'x\n', [AGENT('reviewer')]: 'x\n' })));
    assert.deepEqual(noUi, {
      workflows: ALL_WORKFLOWS,
      ui: false,
      agents: ['planner', 'builder', 'qa-bug-hunter', 'researcher'],
      clashes: { planner: 'keep' },
      stageAgents: {},
      skills: [],
      commands: { test: '', lint: '', build: '' },
      tracker: 'none',
      confirmations: 'standard',
      guardrails: 'on',
      branchPattern: '{type}/{key}-{slug}',
      ci: false,
    });
    const withUi = defaultSelection(installInfo(repo({ 'package.json': JSON.stringify({ dependencies: { svelte: '4' } }) })));
    assert.equal(withUi.ui, true);
    assert.deepEqual(withUi.agents, ['planner', 'builder', 'qa-bug-hunter', 'wireframe-proposer', 'researcher']);
  });

  test('stage agents follow the chosen workflows and the UI answer; fillSelection fills init\'s missing answers', () => {
    const info = installInfo(repo());
    assert.deepEqual(defaultAgents(info, ['hotfix'], false), ['builder', 'qa-bug-hunter']);
    assert.deepEqual(defaultAgents(info, ['bugfix'], false), ['builder', 'qa-bug-hunter', 'researcher']);
    assert.deepEqual(defaultAgents(info, ['feature'], false), ['planner', 'builder', 'qa-bug-hunter', 'researcher']);
    assert.deepEqual(defaultAgents(info, ['feature'], true), ['planner', 'builder', 'qa-bug-hunter', 'wireframe-proposer', 'researcher']);
    assert.deepEqual(fillSelection(info, { workflows: ['hotfix'], agents: [] }), {
      workflows: ['hotfix'],
      agents: [],
      ui: false,
      clashes: {},
      stageAgents: {},
      skills: [],
      commands: { test: '', lint: '', build: '' },
      tracker: 'none',
      confirmations: 'standard',
      guardrails: 'on',
      branchPattern: '{type}/{key}-{slug}',
      ci: false,
    });
  });

  test('the API form needs every field, with the right types', () => {
    const info = installInfo(repo());
    const ok = full(info);
    assert.doesNotThrow(() => checkSelection(info, ok));
    for (const key of ['ui', 'clashes', 'stageAgents', 'skills', 'commands', 'tracker', 'ci']) {
      const sel = { ...ok };
      delete sel[key];
      assert.throws(() => checkSelection(info, sel), new RegExp(`invalid selection: ${key} is required`), key);
      assert.doesNotThrow(() => checkSelection(info, sel, { partial: true }), `${key} may be missing from init's answers`);
    }
    for (const bad of [
      { workflows: [] },
      { workflows: ['nope'] },
      { agents: ['ghost'] },
      { agents: 'planner' },
      { ui: 'no' },
      { clashes: { planner: 'maybe' } },
      { stageAgents: { 'feature.plan': '../x' } },
      { skills: ['../x'] },
      { commands: { test: 'a', lint: 'b' } },
      { commands: { deploy: 'x', test: '', lint: '', build: '' } },
      { tracker: 'linear' },
      { ci: 'yes' },
      { confirmations: 'lite' },
      { guardrails: true },
      { branchPattern: '{type}/{key}' },
    ]) {
      assert.throws(() => checkSelection(info, { ...ok, ...bad }), /invalid selection/, JSON.stringify(bad));
    }
    assert.throws(() => checkSelection(info, null), /invalid selection: not an object/);
  });
});

describe('planInstall', () => {
  test('Bugfix only with no UI: no Feature workflow, no wireframes rules, no wireframe-proposer, planner or reviewer', () => {
    const dir = repo();
    const info = installInfo(dir);
    const before = tree(dir);
    const plan = planInstall(dir, info, full(info, { workflows: ['bugfix'], agents: ['builder', 'qa-bug-hunter', 'researcher'] }));
    assert.deepEqual(tree(dir), before, 'planInstall writes nothing');
    assert.ok(!existsSync(storeOf(dir)), 'nor the store');
    const p = paths(plan);
    assert.deepEqual(p.filter((t) => t.startsWith('.shipline/workflows/')), ['.shipline/workflows/bugfix.yml']);
    assert.deepEqual(p.filter((t) => t.startsWith('.shipline/rules/')).sort(), ['fix', 'pr', 'reproduce', 'root_cause', 'ticket', 'verify'].map((r) => `.shipline/rules/${r}.md`));
    assert.deepEqual(p.filter((t) => t.startsWith('.claude/agents/')).sort(), ['builder', 'qa-bug-hunter', 'researcher'].map(AGENT));
    assert.ok(!p.includes('.github/workflows/shipline.yml'));
    assert.deepEqual(plan.excluded, ['planner', 'reviewer', 'wireframe-proposer'].map(AGENT));
    assert.deepEqual(plan.collisions, []);
    assert.equal(plan.settings.before, null);
    assert.equal(plan.claudeMd.before, null);
    assert.match(plan.claudeMd.after, /<!-- shipline:start -->/);
    assert.ok(JSON.parse(plan.settings.after).hooks.PreToolUse);
  });

  test('ui: false removes the ui_only stage blocks from the workflow text, keeping everything else', () => {
    const dir = repo();
    const info = installInfo(dir);
    const text = (ui) => planInstall(dir, info, full(info, { ui, agents: [...ALL_AGENTS] })).writes.find((w) => w.to === '.shipline/workflows/feature.yml').data.toString('utf8');
    assert.equal(text(true), wfTemplate('feature'));
    const noUi = text(false);
    const tpl = wfTemplate('feature').split('\n');
    const start = tpl.indexOf('  - id: wireframes');
    const end = tpl.indexOf('  - id: implement');
    assert.ok(start > 0 && end > start);
    assert.equal(noUi, [...tpl.slice(0, start), ...tpl.slice(end)].join('\n'), 'exactly the wireframes block is gone');
    assert.match(noUi, /^# Feature workflow\. Stage fields:/, 'the header comments stay');
    assert.deepEqual(parseYaml(noUi).stages.map((s) => s.id), ['ticket', 'feasibility', 'questions', 'plan', 'implement', 'verify', 'pr']);
    // The rules file follows the stages that remain.
    assert.ok(!paths(planInstall(dir, info, full(info, { ui: false }))).includes('.shipline/rules/wireframes.md'));
    assert.ok(paths(planInstall(dir, info, full(info, { ui: true }))).includes('.shipline/rules/wireframes.md'));
    // A stage the answer removes is never asked about as "missing an agent".
    const sel = full(info, { workflows: ['feature'], ui: false, agents: [] });
    assert.ok(!missingStageAgents(info.workflows, sel).some((m) => m.stage === 'wireframes'));
    assert.ok(missingStageAgents(info.workflows, { ...sel, ui: true }).some((m) => m.stage === 'wireframes'));
  });

  test('reviewer only when picked; picked, it is written and not excluded', () => {
    const dir = repo();
    const info = installInfo(dir);
    assert.ok(!paths(planInstall(dir, info, full(info))).includes(AGENT('reviewer')));
    const plan = planInstall(dir, info, full(info, { agents: [...defaultSelection(info).agents, 'reviewer'] }));
    assert.ok(paths(plan).includes(AGENT('reviewer')));
    assert.ok(!plan.excluded.includes(AGENT('reviewer')));
  });

  test('the CI check only with ci: true; merges and collisions are reported', () => {
    const dir = repo({ 'CLAUDE.md': '# Team\n', '.claude/settings.json': '{"env":{"A":"1"}}\n', '.claude/skills/shipline-workflow/SKILL.md': 'mine\n' });
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info, { ci: true }));
    assert.ok(paths(plan).includes('.github/workflows/shipline.yml'));
    assert.equal(plan.ci, true);
    assert.equal(plan.claudeMd.before, '# Team\n');
    assert.ok(plan.claudeMd.after.startsWith('# Team\n\n<!-- shipline:start -->'));
    assert.deepEqual(JSON.parse(plan.settings.after).env, { A: '1' });
    assert.deepEqual(plan.collisions, ['.claude/skills/shipline-workflow/SKILL.md']);
  });

  test('clashes: keep writes nothing and excludes, ours overwrites, skip excludes', () => {
    const dir = repo({ [AGENT('planner')]: 'p\n', [AGENT('builder')]: 'b\n', [AGENT('researcher')]: 'r\n' });
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info, { clashes: { planner: 'keep', builder: 'ours', researcher: 'skip' } }));
    assert.ok(!paths(plan).includes(AGENT('planner')));
    assert.deepEqual(plan.writes.find((w) => w.to === AGENT('builder')).overwrite, true);
    assert.ok(!paths(plan).includes(AGENT('researcher')));
    assert.deepEqual(plan.excluded, ['planner', 'researcher', 'reviewer', 'wireframe-proposer'].map(AGENT));
    assert.deepEqual(plan.collisions, [], 'an overwrite is not a collision');
  });
});

describe('applyInstall', () => {
  test('writes the plan, the store and VERSION (with excluded); returns the written paths', () => {
    const dir = repo();
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info));
    const r = applyInstall(dir, plan);
    assert.deepEqual(r.written.sort(), paths(plan).sort());
    assert.ok(existsSync(storeOf(dir)));
    const v = versionOf(dir);
    assert.deepEqual(v.excluded, ['reviewer', 'wireframe-proposer'].map(AGENT));
    assert.equal(v.files[AGENT('planner')], sha(readFileSync(path.join(CLI_ROOT, 'templates', 'claude', 'agents', 'planner.md'))));
    assert.equal(installState(dir).state, 'installed');
  });

  describe('the re-check against a base (nothing is written on a mismatch)', () => {
    function reviewed(files) {
      const dir = repo(files);
      const info = installInfo(dir);
      const plan = planInstall(dir, info, full(info));
      return { dir, plan, base: baseHashes(dir) };
    }
    const rejects = (dir, plan, base, code) => {
      const before = tree(dir);
      assert.throws(() => applyInstall(dir, plan, { base }), (e) => e.code === code, code);
      assert.deepEqual(tree(dir), before, `${code}: nothing written`);
      assert.ok(!existsSync(storeOf(dir)), `${code}: no store`);
    };

    test('base hashes: sha256 of the merge targets, or null', () => {
      const dir = repo({ 'CLAUDE.md': '# Team\n' });
      assert.deepEqual(baseHashes(dir), { settings: null, claudeMd: sha('# Team\n') });
    });

    test('changed: a merge target was created, edited or deleted since the review', () => {
      let x = reviewed({ 'CLAUDE.md': '# Team\n' });
      writeFileSync(path.join(x.dir, 'CLAUDE.md'), '# Team, edited\n');
      rejects(x.dir, x.plan, x.base, 'changed');
      x = reviewed({});
      mkdirSync(path.join(x.dir, '.claude'));
      writeFileSync(path.join(x.dir, '.claude', 'settings.json'), '{}\n');
      assert.throws(() => applyInstall(x.dir, x.plan, { base: x.base }), (e) => e.code === 'changed' && e.details.paths[0] === '.claude/settings.json');
    });

    test('collision: a path to create now exists', () => {
      const x = reviewed({});
      mkdirSync(path.join(x.dir, '.shipline', 'rules'), { recursive: true });
      writeFileSync(path.join(x.dir, '.shipline', 'rules', 'plan.md'), 'mine\n');
      assert.throws(() => applyInstall(x.dir, x.plan, { base: x.base }), (e) => e.code === 'collision' && e.details.paths.includes('.shipline/rules/plan.md'));
      rejects(x.dir, x.plan, x.base, 'collision');
    });

    test('installed: something installed in the meantime', () => {
      const x = reviewed({});
      mkdirSync(path.join(x.dir, '.shipline'));
      writeFileSync(path.join(x.dir, '.shipline', 'config.yml'), 'tracker: jira\n');
      rejects(x.dir, x.plan, x.base, 'installed');
    });

    test('an unchanged repo installs', () => {
      const x = reviewed({ 'CLAUDE.md': '# Team\n' });
      applyInstall(x.dir, x.plan, { base: x.base });
      assert.equal(installState(x.dir).state, 'installed');
    });
  });

  test('a store that is not writable: code "store", and nothing is written', () => {
    const dir = repo();
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info));
    const block = path.join(homeFor(dir), 'a-file');
    writeFileSync(block, 'x');
    const before = tree(dir);
    const saved = process.env.SHIPLINE_HOME;
    process.env.SHIPLINE_HOME = path.join(block, 'home');
    try {
      assert.throws(() => applyInstall(dir, plan), (e) => e.code === 'store' && /Shipline can't write its task store/.test(e.message));
    } finally {
      process.env.SHIPLINE_HOME = saved;
    }
    assert.deepEqual(tree(dir), before);
  });

  test('a failing write rolls everything back: created files removed, overwritten and merged files restored', () => {
    const team = { 'CLAUDE.md': '# Team\n', '.claude/settings.json': '{"env":{"A":"1"}}\n', [AGENT('builder')]: '# our builder\n' };
    const dir = repo(team);
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info, { clashes: { builder: 'ours' } }));
    // VERSION is written last, with wx: a file there now makes the very last write fail.
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'x\n');
    const before = tree(dir);
    assert.throws(() => applyInstall(dir, plan), (e) => e.code === 'write-failed');
    assert.deepEqual(tree(dir), before);
    for (const [rel, text] of Object.entries(team)) assert.equal(read(dir, rel), text, rel);
  });

  test('a write failing part-way (a folder that is a file) also leaves nothing behind', () => {
    const dir = repo();
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info));
    mkdirSync(path.join(dir, '.shipline'));
    writeFileSync(path.join(dir, '.shipline', 'rules'), 'not a folder\n');
    const before = tree(dir);
    assert.throws(() => applyInstall(dir, plan), (e) => e.code === 'write-failed');
    assert.deepEqual(tree(dir), before);
    assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')) && !existsSync(path.join(dir, '.claude', 'settings.json')));
  });
});

// Done-when 3: the same answers give byte-identical files whichever way they are given.
describe('the same selection gives byte-identical files through init, init --yes and applyInstall', () => {
  const TEAM = { 'README.md': '# app\n', 'CLAUDE.md': '# Team\r\n\r\nNotes.\r\n', [AGENT('planner')]: '# our planner\n' };

  async function threeWays(files, selectionFor, { viaYes = false } = {}) {
    const a = repo(files);
    const b = repo(files);
    const c = repo(files);
    const sel = selectionFor(installInfo(a));
    if (viaYes) {
      const r = runInit(a);
      assert.equal(r.code, 0, r.stderr);
    } else {
      const r = await initWith(a, sel);
      assert.equal(r.code, 0, r.stderr);
    }
    const r = await initWith(b, sel);
    assert.equal(r.code, 0, r.stderr);
    process.env.SHIPLINE_HOME = homeFor(c);
    applyInstall(c, planInstall(c, installInfo(c), sel));
    const ta = tree(a);
    assert.ok(Object.keys(ta).length > 20);
    assert.deepEqual(tree(b), ta);
    assert.deepEqual(tree(c), ta);
    return a;
  }

  test('the --yes defaults, no UI: --yes, init answering them, and applyInstall', async () => {
    const a = await threeWays(TEAM, (info) => defaultSelection(info), { viaYes: true });
    assert.ok(!existsSync(path.join(a, '.shipline', 'rules', 'wireframes.md')));
  });

  test('the --yes defaults, with a detected UI', async () => {
    const files = { ...TEAM, 'package.json': JSON.stringify({ devDependencies: { react: '18' }, scripts: { test: 'vitest' } }) };
    const a = await threeWays(files, (info) => defaultSelection(info), { viaYes: true });
    assert.ok(existsSync(path.join(a, AGENT('wireframe-proposer'))));
  });

  test('a custom selection: Bugfix and Small, a replaced stage agent, reviewer, skills, commands, tracker and the CI check', async () => {
    const files = { ...TEAM, '.claude/skills/deploy/SKILL.md': '# Deploy\n' };
    await threeWays(files, (info) =>
      full(info, {
        workflows: ['bugfix', 'small'],
        agents: ['builder', 'reviewer', 'qa-bug-hunter'],
        stageAgents: { 'bugfix.root_cause': 'reviewer' },
        skills: ['deploy'],
        commands: { test: 'npm test', lint: '', build: 'npm run build' },
        tracker: 'github',
        ci: true,
      }),
    );
  });
});

// Teams Phase 4: the wizard's Standard/Light choice. selection.confirmations 'light' writes it to config.yml; a
// missing or unknown value leaves the template's standard, with no error (checkSelection doesn't require it).
describe('selection.confirmations (Teams Phase 4)', () => {
  const configOf = (plan) => plan.writes.find((w) => w.to === '.shipline/config.yml').data.toString('utf8');
  const TEMPLATE_CONFIG = readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');

  test("'light' writes confirmations: light, keeping the rest of the template (comments included)", () => {
    const dir = repo();
    const info = installInfo(dir);
    const text = configOf(planInstall(dir, info, full(info, { confirmations: 'light' })));
    assert.equal(parseYaml(text).confirmations, 'light');
    assert.equal(text, TEMPLATE_CONFIG.replace(/^confirmations: standard$/m, 'confirmations: light'));
  });

  // Setup polish plan: confirmations is now checked like the other fields; missing still means standard.
  test("missing or 'standard': the template's standard, byte for byte; an unknown value is refused", () => {
    const dir = repo();
    const info = installInfo(dir);
    for (const confirmations of [undefined, 'standard']) {
      const sel = full(info);
      if (confirmations === undefined) delete sel.confirmations;
      else sel.confirmations = confirmations;
      assert.doesNotThrow(() => checkSelection(info, sel), String(confirmations));
      assert.equal(configOf(planInstall(dir, info, sel)), TEMPLATE_CONFIG, String(confirmations));
    }
    for (const confirmations of ['lite', 'Light', null, 1]) {
      assert.throws(() => checkSelection(info, full(info, { confirmations })), /invalid selection: confirmations must be standard or light/, String(confirmations));
    }
    assert.equal(defaultSelection(info).confirmations, 'standard');
  });

  test("'light' together with the other config answers (tracker, commands, skills)", () => {
    const dir = repo({ '.claude/skills/deploy/SKILL.md': '# Deploy\n' });
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info, { confirmations: 'light', tracker: 'github', skills: ['deploy'], commands: { test: 'npm test', lint: '', build: '' } }));
    const cfg = parseYaml(configOf(plan));
    assert.equal(cfg.confirmations, 'light');
    assert.equal(cfg.tracker, 'github');
    assert.deepEqual(cfg.skills, ['deploy']);
    assert.equal(cfg.commands.test, 'npm test');
    applyInstall(dir, plan);
    assert.equal(parseYaml(read(dir, '.shipline/config.yml')).confirmations, 'light');
  });
});

// Setup polish plan, items 2 and 5: guardrails, the branch pattern, and the next-steps checklist.
describe('selection.guardrails and selection.branchPattern (Setup polish)', () => {
  const configOf = (plan) => plan.writes.find((w) => w.to === '.shipline/config.yml').data.toString('utf8');
  const TEMPLATE_CONFIG = readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');

  test("guardrails 'off': every rail (from RAIL_IDS) off, protected_paths: [], the note above rails:; 'on' or missing: the template", () => {
    const dir = repo();
    const info = installInfo(dir);
    const text = configOf(planInstall(dir, info, full(info, { guardrails: 'off' })));
    const cfg = parseYaml(text);
    assert.deepEqual(Object.keys(cfg.rails), RAIL_IDS);
    assert.ok(Object.values(cfg.rails).every((v) => v === 'off'));
    assert.deepEqual(cfg.protected_paths, []);
    assert.match(text, new RegExp(`\\n${GUARDRAILS_OFF_NOTE.replace(/[.()]/g, '\\$&')}\\nrails:\\n`));
    assert.match(text, /^protected_paths: \[\]$/m);
    for (const sel of [full(info, { guardrails: 'on' }), (() => {
      const s = full(info);
      delete s.guardrails;
      return s;
    })()]) {
      assert.doesNotThrow(() => checkSelection(info, sel));
      assert.equal(configOf(planInstall(dir, info, sel)), TEMPLATE_CONFIG);
    }
  });

  test('branchPattern: a custom one is written trimmed; the default, a missing one or the default with spaces leaves the template', () => {
    const dir = repo();
    const info = installInfo(dir);
    const text = configOf(planInstall(dir, info, full(info, { branchPattern: ' {key}/{slug} ' })));
    // Only that line changes (the emitter quotes a value only when Shipline's parser would read it differently).
    assert.equal(text, TEMPLATE_CONFIG.replace(/^branch_pattern: .*$/m, 'branch_pattern: "{key}/{slug}"'));
    assert.equal(parseYaml(text).branch_pattern, '{key}/{slug}');
    const missing = full(info);
    delete missing.branchPattern;
    for (const sel of [full(info, { branchPattern: DEFAULT_BRANCH_PATTERN }), full(info, { branchPattern: ` ${DEFAULT_BRANCH_PATTERN}\t` }), missing]) {
      assert.doesNotThrow(() => checkSelection(info, sel));
      assert.equal(configOf(planInstall(dir, info, sel)), TEMPLATE_CONFIG);
    }
  });

  test('checkSelection refuses a bad guardrails or branchPattern with branchPatternError\'s message', () => {
    const info = installInfo(repo());
    for (const [patch, msg] of [
      [{ guardrails: 'maybe' }, /invalid selection: guardrails must be on or off$/],
      [{ guardrails: null }, /guardrails must be on or off/],
      [{ branchPattern: 1 }, /invalid selection: branchPattern must be text$/],
      [{ branchPattern: '{type}/{key}' }, new RegExp(`invalid selection: branchPattern ${branchPatternError('{type}/{key}').replace(/[{}]/g, '\\$&')}$`)],
      [{ branchPattern: '{slug}-{user}' }, /branchPattern \{user\} is not allowed here; use \{key\}, \{slug\} or \{type\}/],
      [{ branchPattern: '   ' }, /branchPattern must contain \{slug\}/],
    ]) {
      assert.throws(() => checkSelection(info, full(info, patch)), msg, JSON.stringify(patch));
      assert.throws(() => checkSelection(info, full(info, patch), { partial: true }), msg, `partial ${JSON.stringify(patch)}`);
    }
  });

  test('guardrails off, a branch pattern and light together; applyInstall writes it and the hooks read it back', () => {
    const dir = repo();
    const info = installInfo(dir);
    const plan = planInstall(dir, info, full(info, { guardrails: 'off', branchPattern: 'work/{slug}', confirmations: 'light' }));
    applyInstall(dir, plan);
    const cfg = loadConfig(dir);
    assert.equal(cfg.branch_pattern, 'work/{slug}');
    assert.equal(cfg.confirmations, 'light');
    assert.deepEqual(cfg.rails, Object.fromEntries(HOOK_RAIL_IDS.map((id) => [id, 'off'])));
    assert.deepEqual(cfg.protected_paths, []);
  });
});

describe('branchPatternError', () => {
  test('null for a good pattern; the first message otherwise', () => {
    for (const ok of ['{type}/{key}-{slug}', '{slug}', 'feat/{slug}', '{key}_{slug}_{type}']) assert.equal(branchPatternError(ok), null, ok);
    assert.equal(branchPatternError('{type}/{key}'), 'must contain {slug}');
    assert.equal(branchPatternError(''), 'must contain {slug}');
    assert.equal(branchPatternError('{slug}/{user}'), '{user} is not allowed here; use {key}, {slug} or {type}');
    assert.equal(branchPatternError('{user}'), 'must contain {slug}', 'the first of several errors');
    assert.equal(branchPatternError(5), 'must be text');
    assert.equal(branchPatternError(null), null, 'nothing to check (checkSelection checks the type itself)');
  });
});

describe('nextSteps', () => {
  const COMMON = [
    '  2. Open Claude Code in this folder (`claude`) and trust it when asked, so the hooks run.',
    '  3. Try it: ask Claude for a small change, e.g. "fix the typo in README". It picks a workflow and shows the stages.',
    '  4. Tailor the rules to this repo: run /shipline-setup in Claude Code (or `npx @forgeyard/shipline ui` → Setup).',
  ];

  test('without the CI check: four steps, no line about the workflow file', () => {
    const want = ['Next steps', '  1. Commit the setup:  git add .shipline .claude CLAUDE.md && git commit -m "Add Shipline"', ...COMMON];
    assert.deepEqual(nextSteps({ ci: false }), want);
    assert.deepEqual(nextSteps({}), want);
    assert.deepEqual(nextSteps(), want);
    assert.deepEqual(nextSteps({ guardrails: 'off', branchPattern: 'x/{slug}' }), want, 'guardrails and the pattern change nothing');
  });

  test('with the CI check: the workflow file in step 1 and step 5', () => {
    assert.deepEqual(nextSteps({ ci: true }), [
      'Next steps',
      '  1. Commit the setup:  git add .shipline .claude CLAUDE.md .github/workflows/shipline.yml && git commit -m "Add Shipline"',
      ...COMMON,
      '  5. Make the CI check count: on GitHub, protect your main branch and require the "Shipline check", and add',
      '     CODEOWNERS for .shipline/ and .github/ (see the README, "The pull-request check").',
    ]);
  });
});

describe('init-prompts: commandAnswer (the commands questions)', () => {
  test('trims; `none` in any case means empty; anything else is kept', async () => {
    const { commandAnswer } = await import('../src/init-prompts.mjs');
    for (const [answer, want] of [['none', ''], ['NONE', ''], [' None ', ''], ['', ''], ['  pnpm test ', 'pnpm test'], ['none-such', 'none-such'], ['echo none', 'echo none']]) {
      assert.equal(commandAnswer(answer), want, JSON.stringify(answer));
    }
  });
});
