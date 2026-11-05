// Prepublish plan, section C and Tests: interactive `init`. The questions (src/init-prompts.mjs, which loads
// @inquirer/prompts) are replaced in-process by a stub passed as runInit({ prompts }), so this file never loads
// that dependency and runs on Node 18 (test:hooks). The bin is used for --yes and the no-terminal refusal.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInit as runInitInProcess } from '../src/init.mjs';
import { parseYaml } from '../templates/shipline/bin/lib.mjs';
import { CLI_ROOT, TEMPLATES, git, homeFor, removeDir, runInit, stage, tmpDir } from './helpers.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const ALL_AGENTS = ['planner', 'builder', 'reviewer', 'qa-bug-hunter', 'wireframe-proposer', 'researcher'];
const ALL_WORKFLOWS = ['bugfix', 'feature', 'hotfix', 'small'];
const AGENT = (n) => `.claude/agents/${n}.md`;
const agentTemplate = (n) => readFileSync(path.join(CLI_ROOT, 'templates', 'claude', 'agents', `${n}.md`), 'utf8');
const wfTemplate = (id) => readFileSync(path.join(TEMPLATES, 'workflows', `${id}.yml`), 'utf8');

const dirs = [];
after(() => dirs.forEach(removeDir));

// A temp folder (no git needed) with optional team files { rel: text }.
function repo(files = {}) {
  const dir = tmpDir();
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => existsSync(path.join(dir, rel));
const versionOf = (dir) => JSON.parse(read(dir, '.shipline/bin/VERSION'));
const list = (dir, rel) => (exists(dir, rel) ? readdirSync(path.join(dir, rel)).sort() : []);

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = lstatSync(full).isFile() ? sha(readFileSync(full)) : 'other';
    }
  };
  walk(dir);
  return out;
}

// runInit in this process with a stubbed prompts function. Returns { code, stdout, stderr, calls, infos }.
async function initWith(dir, answer, extra = {}) {
  const calls = [];
  const prompts =
    answer === undefined
      ? undefined
      : async (info) => {
          calls.push(info);
          return typeof answer === 'function' ? answer(info) : answer;
        };
  process.env.SHIPLINE_HOME = homeFor(dir);
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = await runInitInProcess({ target: dir, ...(prompts ? { prompts } : {}), ...extra });
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls };
}

const selection = (patch = {}) => ({ workflows: [...ALL_WORKFLOWS], agents: [...ALL_AGENTS], clashes: {}, stageAgents: {}, skills: [], ...patch });

describe('an existing install', () => {
  test('init --yes prints "already initialized" and writes nothing', () => {
    const dir = repo();
    assert.equal(runInit(dir).code, 0);
    const before = tree(dir);
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already initialized/);
    assert.match(r.stdout, /Setup, Agents & skills/);
    assert.match(r.stdout, /npx @forgeyard\/shipline upgrade/);
    assert.match(r.stdout, /npx @forgeyard\/shipline uninstall`, then `init` again/);
    assert.deepEqual(tree(dir), before);
  });

  test('without a terminal and without --yes, the check still runs first (exit 0, not the refusal)', () => {
    const dir = repo();
    assert.equal(runInit(dir).code, 0);
    const before = tree(dir);
    const r = runInit(dir, { yes: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already initialized/);
    assert.equal(r.stderr, '');
    assert.deepEqual(tree(dir), before);
  });

  test('interactive: no question is asked, and nothing is written', async () => {
    for (const marker of ['config', 'claude-md', 'hooks']) {
      const files =
        marker === 'config'
          ? { '.shipline/config.yml': 'tracker: jira\n' }
          : marker === 'claude-md'
            ? { 'CLAUDE.md': '# T\n\n<!-- shipline:start -->\nx\n<!-- shipline:end -->\n' }
            : { '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .shipline/bin/guard.mjs' }] }] } }) };
      const dir = repo(files);
      const before = tree(dir);
      const r = await initWith(dir, selection());
      assert.equal(r.code, 0, `${marker}: ${r.stderr}`);
      assert.match(r.stdout, /already initialized/, marker);
      assert.equal(r.calls.length, 0, `${marker}: prompts were called`);
      assert.deepEqual(tree(dir), before, marker);
    }
  });
});

// A workflow template's text with whole stage blocks removed (from `  - id: <stage>` to the next one).
function withoutStages(text, ids) {
  const out = [];
  let skip = false;
  for (const line of text.split('\n')) {
    const m = /^ {2}- id: (\S+)$/.exec(line);
    if (m) skip = ids.includes(m[1]);
    if (!skip) out.push(line);
  }
  return out.join('\n');
}

// Setup wizard plan, B: --yes installs only what the chosen (all) workflows use, with `ui` from detection.
describe('--yes', () => {
  const STAGE_AGENTS = ['planner', 'builder', 'qa-bug-hunter', 'researcher'];

  test('no UI detected: every workflow without the UI-only stages, only the agents their stages use, no skills', () => {
    const dir = repo({ '.claude/skills/deploy/SKILL.md': '# Deploy\n' });
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(list(dir, '.shipline/workflows'), ALL_WORKFLOWS.map((w) => `${w}.yml`));
    for (const w of ALL_WORKFLOWS) {
      const want = w === 'feature' ? withoutStages(wfTemplate(w), ['wireframes']) : wfTemplate(w);
      assert.equal(read(dir, `.shipline/workflows/${w}.yml`), want, w);
    }
    assert.ok(!exists(dir, '.shipline/rules/wireframes.md'), 'the UI-only stage has no rules file');
    assert.deepEqual(list(dir, '.claude/agents'), STAGE_AGENTS.map((a) => `${a}.md`).sort());
    assert.deepEqual(parseYaml(read(dir, '.shipline/config.yml')).skills, []);
    assert.equal(read(dir, '.shipline/config.yml'), readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    assert.deepEqual(versionOf(dir).excluded, [AGENT('reviewer'), AGENT('wireframe-proposer')]);
    assert.ok(!/Kept your own agents/.test(r.stdout));
    assert.match(
      r.stdout,
      /--yes installs only what the chosen workflows use\. Left out: agents not used by these workflows: reviewer, wireframe-proposer; UI-only stages \(no UI detected here\): feature\.wireframes\. Add them later in `npx @forgeyard\/shipline ui` -> Setup\./,
    );
  });

  test('a UI detected: the UI-only stages and wireframe-proposer are kept; the standalone reviewer is still left out', () => {
    for (const files of [
      { 'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }) },
      { 'web/index.html': '<!doctype html>\n' },
    ]) {
      const dir = repo(files);
      const r = runInit(dir);
      assert.equal(r.code, 0, r.stderr);
      for (const w of ALL_WORKFLOWS) assert.equal(read(dir, `.shipline/workflows/${w}.yml`), wfTemplate(w), w);
      assert.ok(exists(dir, '.shipline/rules/wireframes.md'));
      assert.deepEqual(list(dir, '.claude/agents'), ALL_AGENTS.filter((a) => a !== 'reviewer').map((a) => `${a}.md`).sort());
      assert.deepEqual(versionOf(dir).excluded, [AGENT('reviewer')]);
      assert.match(r.stdout, /Left out: agents not used by these workflows: reviewer\. Add them later/);
      assert.ok(!/UI-only stages/.test(r.stdout));
    }
  });

  test('keeps the repo\'s own agent on every clash, lists them in the summary, and records them in excluded', () => {
    const dir = repo({ [AGENT('planner')]: '# our planner\n', [AGENT('builder')]: '# our builder\n', [AGENT('reviewer')]: '# our reviewer\n' });
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Kept your own agents \(used where Shipline's would be\): planner, builder\. To use Shipline's instead: `npx @forgeyard\/shipline ui` -> Setup -> Agents & skills, or uninstall and re-run `init` interactively\./);
    assert.equal(read(dir, AGENT('planner')), '# our planner\n');
    assert.equal(read(dir, AGENT('builder')), '# our builder\n');
    // reviewer isn't installed by --yes, so the repo's own file is no clash: left alone, and excluded.
    assert.equal(read(dir, AGENT('reviewer')), '# our reviewer\n');
    const v = versionOf(dir);
    assert.deepEqual(v.excluded, [AGENT('builder'), AGENT('planner'), AGENT('reviewer'), AGENT('wireframe-proposer')]);
    assert.ok(!(AGENT('planner') in v.files));
    assert.equal(v.files[AGENT('qa-bug-hunter')], sha(agentTemplate('qa-bug-hunter')));
    // A kept clash counts as present: the stage keeps its agent.
    assert.equal(read(dir, '.shipline/workflows/feature.yml'), withoutStages(wfTemplate('feature'), ['wireframes']));
  });

  test('--dry-run lists the excluded paths and writes nothing', () => {
    const dir = repo({ [AGENT('planner')]: '# ours\n' });
    const before = tree(dir);
    const r = runInit(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /= \.claude\/agents\/planner\.md \(not installed; recorded as excluded\)/);
    assert.deepEqual(tree(dir), before);
  });
});

describe('refusing', () => {
  test('without a terminal and without --yes, init refuses and writes nothing', () => {
    const dir = repo();
    const r = runInit(dir, { yes: false });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /init asks questions, and this is not a terminal\. Run it in a terminal, or pass --yes/);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('a cancelled question (the prompts throw) writes nothing', async () => {
    const dir = repo();
    const r = await initWith(dir, () => {
      throw new Error('User force closed the prompt');
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /init cancelled, nothing was written\. User force closed the prompt/);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('an invalid selection (no workflow, unknown agent, bad clash, bad skill name) writes nothing', async () => {
    for (const bad of [
      selection({ workflows: [] }),
      selection({ workflows: ['nope'] }),
      selection({ agents: ['ghost'] }),
      selection({ clashes: { planner: 'maybe' } }),
      selection({ skills: ['../x'] }),
      selection({ ci: 'yes' }),
    ]) {
      const dir = repo();
      const r = await initWith(dir, bad);
      assert.equal(r.code, 1, JSON.stringify(bad));
      assert.match(r.stderr, /invalid selection/);
      assert.deepEqual(readdirSync(dir), [], JSON.stringify(bad));
    }
  });
});

describe('selection logic (prompts stubbed)', () => {
  test('info offers the shipped workflows and agents, and the repo\'s own agents and skills', async () => {
    const dir = repo({ [AGENT('planner')]: 'x\n', [AGENT('mine')]: 'x\n', '.claude/skills/deploy/SKILL.md': 'x\n', '.claude/skills/lint/SKILL.md': 'x\n' });
    const r = await initWith(dir, selection());
    assert.equal(r.code, 0, r.stderr);
    const [info] = r.calls;
    assert.deepEqual(info.workflows.map((w) => w.id), ALL_WORKFLOWS);
    assert.equal(info.workflows.find((w) => w.id === 'small').name, 'Small change');
    assert.deepEqual(info.agents, ALL_AGENTS);
    assert.deepEqual(info.repoAgents, ['mine', 'planner']);
    assert.deepEqual(info.repoSkills, ['deploy', 'lint']);
    assert.equal(typeof info.missingStageAgents, 'function');
  });

  test('only the chosen workflows (and their stages\' rules) and agents are installed; the rest is excluded', async () => {
    const dir = repo();
    const r = await initWith(dir, selection({ workflows: ['bugfix'], agents: ['builder', 'qa-bug-hunter', 'researcher'] }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(list(dir, '.shipline/workflows'), ['bugfix.yml']);
    assert.deepEqual(list(dir, '.shipline/rules'), ['fix.md', 'pr.md', 'reproduce.md', 'root_cause.md', 'ticket.md', 'verify.md']);
    assert.deepEqual(list(dir, '.claude/agents'), ['builder.md', 'qa-bug-hunter.md', 'researcher.md']);
    assert.deepEqual(list(dir, '.claude/skills'), ['shipline-setup', 'shipline-workflow']);
    const v = versionOf(dir);
    assert.deepEqual(v.excluded, [AGENT('planner'), AGENT('reviewer'), AGENT('wireframe-proposer')]);
    for (const n of ['planner', 'reviewer', 'wireframe-proposer']) assert.ok(!(AGENT(n) in v.files), n);
    for (const n of ['builder', 'qa-bug-hunter', 'researcher']) assert.equal(v.files[AGENT(n)], sha(agentTemplate(n)), n);
    // Every agent the bugfix stages name is installed, so the workflow file is the template as shipped.
    assert.equal(read(dir, '.shipline/workflows/bugfix.yml'), wfTemplate('bugfix'));
  });

  test('the three clash outcomes: keep yours, use ours, skip', async () => {
    const dir = repo({ [AGENT('planner')]: '# our planner\n', [AGENT('builder')]: '# our builder\n', [AGENT('researcher')]: '# our researcher\n' });
    let missing;
    const r = await initWith(dir, (info) => {
      const sel = selection({ clashes: { planner: 'keep', builder: 'ours', researcher: 'skip' } });
      missing = info.missingStageAgents(sel);
      return sel;
    });
    assert.equal(r.code, 0, r.stderr);
    // keep: the repo's file stays and is excluded.
    assert.equal(read(dir, AGENT('planner')), '# our planner\n');
    // ours: Shipline's file replaces it and is tracked.
    assert.equal(read(dir, AGENT('builder')), agentTemplate('builder'));
    // skip: nothing is installed for it (the repo's own file is not touched) and it is excluded.
    assert.equal(read(dir, AGENT('researcher')), '# our researcher\n');
    const v = versionOf(dir);
    assert.deepEqual(v.excluded, [AGENT('planner'), AGENT('researcher')]);
    assert.equal(v.files[AGENT('builder')], sha(agentTemplate('builder')));
    assert.ok(!(AGENT('planner') in v.files));
    assert.ok(!(AGENT('researcher') in v.files));
    // A skipped clash counts as missing, a kept one as present.
    assert.deepEqual(missing.map((m) => m.key).sort(), ['bugfix.root_cause', 'feature.feasibility']);
    assert.ok(missing.every((m) => m.agent === 'researcher'));
    // With no stageAgents answer, the missing agent's line is removed; the kept planner stays.
    const feature = parseYaml(read(dir, '.shipline/workflows/feature.yml'));
    assert.equal(feature.stages.find((s) => s.id === 'feasibility').agent, undefined);
    assert.equal(feature.stages.find((s) => s.id === 'plan').agent, 'planner');
    assert.match(r.stdout, /Kept your own agents \(used where Shipline's would be\): planner\./);
  });

  test('replacing a stage\'s agent: a Shipline agent, the repo\'s own agent, or none', async () => {
    const dir = repo({ [AGENT('mine')]: '# our agent\n' });
    let missing;
    const r = await initWith(dir, (info) => {
      const sel = selection({ workflows: ['feature'], ui: true, agents: ['builder', 'qa-bug-hunter', 'reviewer'] });
      missing = info.missingStageAgents(sel);
      sel.stageAgents = { 'feature.plan': 'reviewer', 'feature.feasibility': 'mine', 'feature.wireframes': null };
      return sel;
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(missing, [
      { key: 'feature.feasibility', workflow: 'feature', stage: 'feasibility', agent: 'researcher' },
      { key: 'feature.plan', workflow: 'feature', stage: 'plan', agent: 'planner' },
      { key: 'feature.wireframes', workflow: 'feature', stage: 'wireframes', agent: 'wireframe-proposer' },
    ]);
    const text = read(dir, '.shipline/workflows/feature.yml');
    const wf = parseYaml(text);
    const agentOf = (id) => wf.stages.find((s) => s.id === id).agent;
    assert.equal(agentOf('plan'), 'reviewer');
    assert.equal(agentOf('feasibility'), 'mine');
    assert.equal(agentOf('wireframes'), undefined);
    assert.equal(agentOf('implement'), 'builder');
    // Only the agent lines changed: comments and layout are kept.
    const a = wfTemplate('feature').split('\n');
    const b = text.split('\n');
    assert.equal(a.length - b.length, 1, 'one agent line removed');
    assert.ok(a.filter((l) => l.startsWith('#')).every((l) => b.includes(l)), 'header comments kept');
    assert.ok(a.filter((l) => !/^ {4}agent:/.test(l)).every((l) => b.includes(l)));
    // The hooks still read it.
    assert.match(stage(dir, ['workflows']).stdout, /^feature: /m);
  });

  test('skills: the chosen repo skills are written to config.yml and printed by stage.mjs', async () => {
    const dir = repo({ '.claude/skills/deploy/SKILL.md': '# Deploy\n', '.claude/skills/lint/SKILL.md': '# Lint\n' });
    const r = await initWith(dir, selection({ skills: ['deploy', 'lint'] }));
    assert.equal(r.code, 0, r.stderr);
    const cfgText = read(dir, '.shipline/config.yml');
    assert.deepEqual(parseYaml(cfgText).skills, ['deploy', 'lint']);
    assert.ok(cfgText.includes("# Optional. Names of this repo's own skills"), 'the template comments are kept');
    assert.ok(!('.shipline/config.yml' in versionOf(dir).files), 'config.yml stays team-owned');
    const st = stage(dir, ['start', '--workflow', 'small', '--title', 'Fix typo'], 'sk1');
    assert.equal(st.code, 0, st.stderr);
    assert.match(stage(dir, ['status'], 'sk1').stdout, /^Repo skills you can use: deploy, lint$/m);
  });

  test('no skills chosen: config.yml is the template and stage.mjs prints no skills line', async () => {
    const dir = repo({ '.claude/skills/deploy/SKILL.md': '# Deploy\n' });
    const r = await initWith(dir, selection());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(dir, '.shipline/config.yml'), readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'Fix typo'], 'sk2').code, 0);
    assert.ok(!/Repo skills you can use/.test(stage(dir, ['status'], 'sk2').stdout));
  });

  test('deselecting every agent is allowed; every suggested agent then counts as missing', async () => {
    const dir = repo();
    let missing;
    const r = await initWith(dir, (info) => {
      const sel = selection({ workflows: ['hotfix'], agents: [] });
      missing = info.missingStageAgents(sel);
      return sel;
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(missing.map((m) => m.key), ['hotfix.fix', 'hotfix.verify', 'hotfix.pr']);
    assert.ok(!exists(dir, '.claude/agents'));
    assert.deepEqual(versionOf(dir).excluded, ALL_AGENTS.map(AGENT).sort());
    assert.ok(parseYaml(read(dir, '.shipline/workflows/hotfix.yml')).stages.every((s) => s.agent === undefined));
  });

  test('a collision on a non-agent path still aborts with nothing written', async () => {
    const dir = repo({ '.claude/skills/shipline-workflow/SKILL.md': '# mine\n', [AGENT('planner')]: '# ours\n' });
    const before = tree(dir);
    const r = await initWith(dir, selection());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^ {2}- \.claude\/skills\/shipline-workflow\/SKILL\.md$/m);
    assert.ok(!/agents\/planner/.test(r.stderr));
    assert.deepEqual(tree(dir), before);
  });
});

// Trust plan, C: the opt-in CI check. "Add a Shipline CI check for pull requests?" (default No; --yes leaves it out).
describe('the CI check opt-in', () => {
  const CI = '.github/workflows/shipline.yml';
  const ciTemplate = () => readFileSync(path.join(CLI_ROOT, 'templates', 'github', 'shipline.yml'));

  test('yes: writes .github/workflows/shipline.yml from the template and records its hash in VERSION.files', async () => {
    const dir = repo();
    const r = await initWith(dir, selection({ ci: true }));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(readFileSync(path.join(dir, CI)).equals(ciTemplate()));
    assert.equal(versionOf(dir).files[CI], sha(ciTemplate()));
    assert.match(r.stdout, /Added the pull-request check \.github\/workflows\/shipline\.yml \(paste `node \.shipline\/bin\/stage\.mjs pr-summary` into PR descriptions\)\./);
    // The workflow is not counted among the files "under .shipline/ and .claude/".
    const count = (out) => Number(/created (\d+) files under \.shipline\/ and \.claude\//.exec(out)[1]);
    assert.equal(count(r.stdout), count((await initWith(repo(), selection())).stdout));
  });

  test('no (or no answer in the selection): nothing under .github/, and VERSION.files has no entry', async () => {
    for (const sel of [selection({ ci: false }), selection()]) {
      const dir = repo();
      const r = await initWith(dir, sel);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!exists(dir, '.github'), JSON.stringify(sel));
      assert.ok(!(CI in versionOf(dir).files));
      assert.ok(!/Added the pull-request check/.test(r.stdout));
    }
  });

  test('--yes leaves it out', () => {
    const dir = repo();
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!exists(dir, '.github'));
    assert.ok(!(CI in versionOf(dir).files));
  });

  test('a repo that already has its own .github/workflows/shipline.yml: init refuses (a collision) and writes nothing', async () => {
    const dir = repo({ [CI]: 'name: ours\n' });
    const before = tree(dir);
    const r = await initWith(dir, selection({ ci: true }));
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(tree(dir), before);
  });
});

describe('the interactive path on old Node', () => {
  // Only below Node 20 is the import sure to fail (no node:util styleText); on 20.12-20.16 it may load and then
  // wait for a terminal, so those versions are skipped too.
  const old = Number(process.versions.node.split('.')[0]) < 20;
  test('src/init-prompts.mjs explains to use --yes when @inquirer/prompts cannot load', { skip: old ? false : 'needs Node < 20 (the CI test:hooks job)' }, async () => {
    const { askSelection } = await import('../src/init-prompts.mjs');
    await assert.rejects(() => askSelection({ workflows: [], agents: [], repoAgents: [], repoSkills: [], missingStageAgents: () => [] }), /Node 20\.17 or newer; on older Node, run `init --yes`/);
  });
});

// Teams Phase 1, B and D: init fills the test, lint and build commands from the repo's files, and asks for the
// tracker (GitHub Issues pre-selected when `origin` is on github.com). The questions themselves are stubbed here
// (as above), so these check what they are given (the pre-filled values) and that whatever they answer is written.
describe('commands and tracker (Teams Phase 1)', () => {
  const NODE_REPO = {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
    'pnpm-lock.yaml': '',
  };
  const config = (dir) => parseYaml(read(dir, '.shipline/config.yml'));
  const withOrigin = (dir, url) => {
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', url);
    return dir;
  };

  test('--yes writes the detected commands and tracker: jira, keeping the template\'s comments', () => {
    const dir = repo(NODE_REPO);
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    const cfg = config(dir);
    assert.deepEqual(cfg.commands, { test: 'pnpm test', lint: 'pnpm run lint', build: 'pnpm run typecheck' });
    assert.equal(cfg.tracker, 'jira');
    const text = read(dir, '.shipline/config.yml');
    assert.match(text, /^# Optional\. The verify stage runs only the commands you set here\./m);
    assert.match(text, /^commands:\n {2}test: pnpm test\n {2}lint: pnpm run lint\n {2}build: pnpm run typecheck\n/m);
    assert.match(r.stdout, /Commands for the verify stage:\n {2}test: pnpm test \(from package\.json\)\n {2}lint: pnpm run lint \(from package\.json\)\n {2}build: pnpm run typecheck \(from package\.json\)/);
    assert.match(r.stdout, /Tracker: Jira/);
  });

  test('--yes keeps jira even when origin is on github.com', () => {
    const dir = withOrigin(repo(), 'git@github.com:acme/app.git');
    assert.equal(runInit(dir).code, 0);
    assert.equal(config(dir).tracker, 'jira');
  });

  test('--yes with nothing detected writes the template unchanged', () => {
    const dir = repo();
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(dir, '.shipline/config.yml'), readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    assert.match(r.stdout, /No test, lint or build commands set; add them under commands: in \.shipline\/config\.yml\./);
  });

  test('the questions get the detected commands (with their sources) to pre-fill', async () => {
    const r = await initWith(repo(NODE_REPO), selection());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0].detected, {
      test: 'pnpm test',
      lint: 'pnpm run lint',
      build: 'pnpm run typecheck',
      sources: { test: 'package.json', lint: 'package.json', build: 'package.json' },
    });
    const empty = await initWith(repo(), selection());
    assert.deepEqual(empty.calls[0].detected, { test: '', lint: '', build: '', sources: {} }, 'nothing detected: the prompts start empty');
  });

  test('edited and cleared answers are written as given; an answer that is not one of the commands is refused', async () => {
    const dir = repo(NODE_REPO);
    const r = await initWith(dir, selection({ commands: { test: 'pnpm test -- --run', lint: '', build: 'pnpm run typecheck' }, tracker: 'github' }));
    assert.equal(r.code, 0, r.stderr);
    const cfg = config(dir);
    assert.deepEqual(cfg.commands, { test: 'pnpm test -- --run', lint: '', build: 'pnpm run typecheck' });
    assert.equal(cfg.tracker, 'github');
    assert.match(r.stdout, /^ {2}test: pnpm test -- --run$/m, 'an edited command has no "(from …)"');
    assert.match(r.stdout, /^ {2}build: pnpm run typecheck \(from package\.json\)$/m);
    assert.ok(!/^ {2}lint:/m.test(r.stdout), 'a cleared command is not listed');
    assert.match(r.stdout, /Tracker: GitHub Issues/);

    for (const bad of [{ commands: { deploy: 'x' } }, { commands: { test: 1 } }, { commands: ['pnpm test'] }, { tracker: 'linear' }]) {
      const d = repo();
      const b = await initWith(d, selection(bad));
      assert.equal(b.code, 1, JSON.stringify(bad));
      assert.match(b.stderr, /invalid selection/);
      assert.deepEqual(readdirSync(d), [], JSON.stringify(bad));
    }
  });

  test('every command cleared in a repo with detected ones: the commands stay empty', async () => {
    const dir = repo(NODE_REPO);
    const r = await initWith(dir, selection({ commands: { test: '', lint: '', build: '' } }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(config(dir).commands, { test: '', lint: '', build: '' });
  });

  test('the tracker default: github when origin is on github.com, otherwise jira (also with no git at all)', async () => {
    const cases = [
      [withOrigin(repo(), 'https://github.com/acme/app.git'), 'github'],
      [withOrigin(repo(), 'git@github.com:acme/app.git'), 'github'],
      [withOrigin(repo(), 'https://gitlab.com/acme/app.git'), 'jira'],
      [(() => {
        const d = repo();
        git(d, 'init', '-q');
        return d;
      })(), 'jira'],
      [repo(), 'jira'],
    ];
    for (const [dir, want] of cases) {
      const r = await initWith(dir, selection());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.calls[0].trackerDefault, want, dir);
    }
  });

  test('the final message nudges to tailor the rules', async () => {
    const r = await initWith(repo(), selection());
    assert.match(r.stdout, /Next: tailor the rules to this repo\. Run `\/shipline-setup` in Claude Code, or open `npx @forgeyard\/shipline ui` and use Setup -> Set up with Claude\./);
  });
});

// Setup wizard plan, B and C: the questions init adds (the UI question and the standalone agents get what they
// need through info), the browser-or-terminal question (Node 20+, interactive runs only), and the dry run.
describe('setup wizard: the new questions', () => {
  const NODE20 = Number(process.versions.node.split('.')[0]) >= 20;

  test('info carries the detected UI, which stages use each agent, and the default agents for an answer', async () => {
    const dir = repo({ 'web/app.tsx': 'x' });
    const r = await initWith(dir, selection({ ui: true }));
    assert.equal(r.code, 0, r.stderr);
    const [info] = r.calls;
    assert.equal(info.uiDetected, true);
    assert.deepEqual(info.agentUse.reviewer, [], 'reviewer is the standalone agent');
    assert.deepEqual(info.agentUse['wireframe-proposer'], ['feature.wireframes']);
    assert.deepEqual(info.defaultAgents(['feature'], false), ['planner', 'builder', 'qa-bug-hunter', 'researcher']);
    assert.deepEqual(info.defaultAgents(['feature'], true), ['planner', 'builder', 'qa-bug-hunter', 'wireframe-proposer', 'researcher']);
    assert.deepEqual(info.defaultAgents(['hotfix'], true), ['builder', 'qa-bug-hunter']);
    assert.equal(info.state, 'clean');
  });

  test('the UI answer decides the UI-only stages; with no answer, detection decides', async () => {
    const no = repo();
    assert.equal((await initWith(no, selection({ ui: false }))).code, 0);
    assert.ok(!parseYaml(read(no, '.shipline/workflows/feature.yml')).stages.some((s) => s.id === 'wireframes'));
    assert.ok(!exists(no, '.shipline/rules/wireframes.md'));
    const yes = repo();
    assert.equal((await initWith(yes, selection({ ui: true }))).code, 0);
    assert.equal(read(yes, '.shipline/workflows/feature.yml'), wfTemplate('feature'));
    assert.ok(exists(yes, '.shipline/rules/wireframes.md'));
    const detected = repo({ 'index.html': 'x' });
    assert.equal((await initWith(detected, selection())).code, 0);
    assert.equal(read(detected, '.shipline/workflows/feature.yml'), wfTemplate('feature'));
    const notDetected = repo();
    assert.equal((await initWith(notDetected, selection())).code, 0);
    assert.ok(!exists(notDetected, '.shipline/rules/wireframes.md'));
  });

  test('"Browser" starts the UI on the folder instead of asking, and writes nothing itself', { skip: NODE20 ? false : 'the browser option needs Node 20' }, async () => {
    const dir = repo();
    const started = [];
    let asked = 0;
    const r = await initWith(dir, selection(), {
      where: async () => {
        asked++;
        return 'browser';
      },
      startUi: async (root) => started.push(root),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(asked, 1);
    assert.deepEqual(started, [dir]);
    assert.equal(r.calls.length, 0, 'the terminal questions are not asked');
    assert.deepEqual(readdirSync(dir), []);
  });

  test('"Terminal" goes on to the questions', { skip: NODE20 ? false : 'the browser option needs Node 20' }, async () => {
    const dir = repo();
    let started = 0;
    const r = await initWith(dir, selection(), { where: async () => 'terminal', startUi: async () => started++ });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.equal(started, 0);
    assert.ok(exists(dir, '.shipline/config.yml'));
  });

  test('a cancelled browser-or-terminal question writes nothing', { skip: NODE20 ? false : 'the browser option needs Node 20' }, async () => {
    const dir = repo();
    const r = await initWith(dir, selection(), {
      where: async () => {
        throw new Error('User force closed the prompt');
      },
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /init cancelled, nothing was written\. User force closed the prompt/);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('the question is offered only on interactive runs on Node 20+: never with --yes, --dry-run, below Node 20, or on an existing install', async () => {
    let asked = 0;
    const where = async () => {
      asked++;
      return 'browser';
    };
    const startUi = async () => {
      throw new Error('must not start');
    };
    assert.equal((await initWith(repo(), selection(), { yes: true, where, startUi })).code, 0);
    assert.equal((await initWith(repo(), selection(), { dryRun: true, where, startUi })).code, 0);
    assert.equal((await initWith(repo({ '.shipline/config.yml': 'tracker: jira\n' }), selection(), { where, startUi })).code, 0);
    assert.equal(asked, 0);
    if (!NODE20) {
      // The CI hooks job (Node 18): the UI can't run, so the question is skipped silently.
      const r = await initWith(repo(), selection(), { where, startUi });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(asked, 0);
    }
  });

  test('the --dry-run format is unchanged: + created, ~ overwritten or merged, = excluded', async () => {
    const dir = repo({ 'CLAUDE.md': '# Team\n', [AGENT('builder')]: '# ours\n' });
    const before = tree(dir);
    const r = await initWith(dir, selection({ ui: false, agents: ['builder', 'qa-bug-hunter'], clashes: { builder: 'ours' }, workflows: ['hotfix'] }), { dryRun: true });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(tree(dir), before);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'Dry run, nothing written. Would create:');
    assert.ok(lines.includes('  + .shipline/workflows/hotfix.yml'));
    assert.ok(lines.includes('  ~ .claude/agents/builder.md'));
    assert.ok(lines.includes('  + .shipline/bin/VERSION'));
    assert.ok(lines.includes('  + .claude/settings.json (hooks and allow rules merged)'));
    assert.ok(lines.includes('  ~ CLAUDE.md (marked block appended)'));
    for (const n of ['planner', 'researcher', 'reviewer', 'wireframe-proposer']) assert.ok(lines.includes(`  = ${AGENT(n)} (not installed; recorded as excluded)`), n);
    assert.ok(lines.every((l, i) => i === 0 || /^ {2}[+~=] \S/.test(l)), r.stdout);
  });
});
