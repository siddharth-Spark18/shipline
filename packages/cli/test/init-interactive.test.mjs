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
import { CLI_ROOT, TEMPLATES, homeFor, removeDir, runInit, stage, tmpDir } from './helpers.mjs';

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

describe('--yes', () => {
  test('defaults: every workflow and agent, no skills, stage agents as shipped, nothing excluded', () => {
    const dir = repo({ '.claude/skills/deploy/SKILL.md': '# Deploy\n' });
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(list(dir, '.shipline/workflows'), ALL_WORKFLOWS.map((w) => `${w}.yml`));
    for (const w of ALL_WORKFLOWS) assert.equal(read(dir, `.shipline/workflows/${w}.yml`), wfTemplate(w), w);
    assert.deepEqual(list(dir, '.claude/agents'), ALL_AGENTS.map((a) => `${a}.md`).sort());
    assert.deepEqual(parseYaml(read(dir, '.shipline/config.yml')).skills, []);
    assert.equal(read(dir, '.shipline/config.yml'), readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    assert.deepEqual(versionOf(dir).excluded, []);
    assert.ok(!/Kept your own agents/.test(r.stdout));
  });

  test('keeps the repo\'s own agent on every clash, lists them in the summary, and records them in excluded', () => {
    const dir = repo({ [AGENT('planner')]: '# our planner\n', [AGENT('reviewer')]: '# our reviewer\n' });
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Kept your own agents \(used where Shipline's would be\): planner, reviewer\. To use Shipline's instead: `shipline ui` -> Setup -> Agents & skills, or uninstall and re-run `init` interactively\./);
    assert.equal(read(dir, AGENT('planner')), '# our planner\n');
    assert.equal(read(dir, AGENT('reviewer')), '# our reviewer\n');
    const v = versionOf(dir);
    assert.deepEqual(v.excluded, [AGENT('planner'), AGENT('reviewer')]);
    assert.ok(!(AGENT('planner') in v.files));
    assert.equal(v.files[AGENT('builder')], sha(agentTemplate('builder')));
    // A kept clash counts as present: the stage keeps its agent.
    assert.equal(read(dir, '.shipline/workflows/feature.yml'), wfTemplate('feature'));
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
    assert.deepEqual(list(dir, '.shipline/rules'), ['fix.md', 'jira.md', 'pr.md', 'reproduce.md', 'root_cause.md', 'verify.md']);
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
      const sel = selection({ workflows: ['feature'], agents: ['builder', 'qa-bug-hunter', 'reviewer'] });
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

describe('the interactive path on old Node', () => {
  // Only below Node 20 is the import sure to fail (no node:util styleText); on 20.12-20.16 it may load and then
  // wait for a terminal, so those versions are skipped too.
  const old = Number(process.versions.node.split('.')[0]) < 20;
  test('src/init-prompts.mjs explains to use --yes when @inquirer/prompts cannot load', { skip: old ? false : 'needs Node < 20 (the CI test:hooks job)' }, async () => {
    const { askSelection } = await import('../src/init-prompts.mjs');
    await assert.rejects(() => askSelection({ workflows: [], agents: [], repoAgents: [], repoSkills: [], missingStageAgents: () => [] }), /Node 20\.17 or newer; on older Node, run `init --yes`/);
  });
});
