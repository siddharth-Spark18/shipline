// Prepublish plan, section C and Tests: interactive `init`. The questions (src/init-prompts.mjs, which loads
// @inquirer/prompts) are replaced in-process by a stub passed as runInit({ prompts }), so this file never loads
// that dependency and runs on Node 18 (test:hooks). The bin is used for --yes and the no-terminal refusal.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInit as runInitInProcess } from '../src/init.mjs';
import { DEFAULT_BRANCH_PATTERN, GUARDRAILS_OFF_NOTE, nextSteps } from '../src/install.mjs';
import { RAIL_IDS } from '../src/setup-schema.mjs';
import { RAIL_IDS as HOOK_RAIL_IDS, loadConfig, parseYaml } from '../templates/shipline/bin/lib.mjs';
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

// runInit in this process with a stubbed prompts function. The review's Install question is answered Yes unless
// extra.confirm says otherwise. Returns { code, stdout, stderr, calls, reviews }.
async function initWith(dir, answer, extra = {}) {
  const calls = [];
  const reviews = [];
  const confirm = async (text) => {
    reviews.push(text);
    return extra.confirm ? extra.confirm(text) : true;
  };
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
    code = await runInitInProcess({ target: dir, ...(prompts ? { prompts } : {}), ...extra, confirm });
  } finally {
    console.log = log;
    console.error = error;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls, reviews };
}

const selection = (patch = {}) => ({ workflows: [...ALL_WORKFLOWS], agents: [...ALL_AGENTS], clashes: {}, stageAgents: {}, skills: [], ...patch });

// Runs fn with process.stdin looking like a terminal (the wizard and the questions need one).
async function withTty(fn) {
  const had = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(process.stdin, 'isTTY', had);
    else delete process.stdin.isTTY;
  }
}
const mustNotStart = async () => {
  throw new Error('the wizard must not start');
};

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
    assert.match(stage(dir, ['status', '--verbose'], 'sk1').stdout, /^Repo skills you can use: deploy, lint$/m);
  });

  test('no skills chosen: config.yml is the template and stage.mjs prints no skills line', async () => {
    const dir = repo({ '.claude/skills/deploy/SKILL.md': '# Deploy\n' });
    const r = await initWith(dir, selection());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(dir, '.shipline/config.yml'), readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'Fix typo'], 'sk2').code, 0);
    assert.ok(!/Repo skills you can use/.test(stage(dir, ['status', '--verbose'], 'sk2').stdout));
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

  test('--yes writes the detected commands and tracker: none, keeping the template\'s comments', () => {
    const dir = repo(NODE_REPO);
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    const cfg = config(dir);
    assert.deepEqual(cfg.commands, { test: 'pnpm test', lint: 'pnpm run lint', build: 'pnpm run typecheck' });
    assert.equal(cfg.tracker, 'none');
    const text = read(dir, '.shipline/config.yml');
    assert.match(text, /^# Optional\. The verify stage runs only the commands you set here\./m);
    assert.match(text, /^commands:\n {2}test: pnpm test\n {2}lint: pnpm run lint\n {2}build: pnpm run typecheck\n/m);
    assert.match(r.stdout, /Commands for the verify stage:\n {2}test: pnpm test \(from package\.json\)\n {2}lint: pnpm run lint \(from package\.json\)\n {2}build: pnpm run typecheck \(from package\.json\)/);
    assert.match(r.stdout, /Tracker: none, so the ticket stage is skipped\. Change it in \.shipline\/config\.yml\./);
  });

  test('--yes keeps none even when origin is on github.com', () => {
    const dir = withOrigin(repo(), 'git@github.com:acme/app.git');
    assert.equal(runInit(dir).code, 0);
    assert.equal(config(dir).tracker, 'none');
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
    const j = await initWith(repo(), selection({ tracker: 'jira' }));
    assert.equal(j.code, 0, j.stderr);
    assert.match(j.stdout, /Tracker: Jira \(read through the Atlassian MCP\)\. Change it/);

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

  // 1.0 plan, item 19: the default is none; a GitHub remote no longer picks it.
  test('the tracker default: none, whatever the remote (also with no git at all)', async () => {
    const cases = [
      [withOrigin(repo(), 'https://github.com/acme/app.git'), 'none'],
      [withOrigin(repo(), 'git@github.com:acme/app.git'), 'none'],
      [withOrigin(repo(), 'https://gitlab.com/acme/app.git'), 'none'],
      [(() => {
        const d = repo();
        git(d, 'init', '-q');
        return d;
      })(), 'none'],
      [repo(), 'none'],
    ];
    for (const [dir, want] of cases) {
      const r = await initWith(dir, selection());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.calls[0].trackerDefault, want, dir);
    }
  });

  test('the final message ends with the next-steps checklist (tailoring the rules is step 4)', async () => {
    const r = await initWith(repo(), selection());
    assert.ok(r.stdout.includes(`\n${nextSteps({}).join('\n')}`), r.stdout);
    assert.match(r.stdout, /^ {2}4\. Tailor the rules to this repo: run \/shipline-setup in Claude Code/m);
    assert.ok(!/^Next: /m.test(r.stdout));
  });
});

// Setup wizard plan, B and C: the questions init adds (the UI question and the standalone agents get what they
// need through info), the browser-or-terminal question (Node 20+, interactive runs only), and the dry run.
describe('setup wizard: the new questions', () => {
  
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

  // Setup polish plan, item 1: an interactive run opens the browser wizard by default (start function injected).
  test('a terminal run with no flags starts the wizard on the folder, asks nothing and writes nothing itself', async () => {
    const dir = repo();
    const started = [];
    const r = await withTty(() => initWith(dir, undefined, { nodeMajor: 20, startUi: async (root) => started.push(root) }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(started, [dir]);
    assert.equal(r.reviews.length, 0);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('--terminal asks the questions here (the wizard is not started), then reviews and installs', async () => {
    const dir = repo();
    let started = 0;
    const r = await withTty(() => initWith(dir, selection(), { terminal: true, nodeMajor: 24, startUi: async () => started++ }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.equal(started, 0);
    assert.equal(r.reviews.length, 1);
    assert.ok(!/The setup wizard needs Node 20/.test(r.stdout));
    assert.ok(exists(dir, '.shipline/config.yml'));
  });

  test('injected prompts never start the wizard (as `where` behaved before)', async () => {
    const r = await withTty(() => initWith(repo(), selection(), { nodeMajor: 24, startUi: mustNotStart }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
  });

  test('the wizard never starts with --yes, --dry-run or on an existing install', async () => {
    for (const extra of [{ yes: true }, { dryRun: true }, { yes: true, terminal: true }]) {
      const r = await withTty(() => initWith(repo(), extra.yes ? undefined : selection(), { ...extra, nodeMajor: 24, startUi: mustNotStart }));
      assert.equal(r.code, 0, `${JSON.stringify(extra)}: ${r.stderr}`);
      assert.equal(r.reviews.length, 0, `${JSON.stringify(extra)}: no review`);
    }
    const r = await withTty(() => initWith(repo({ '.shipline/config.yml': 'tracker: jira\n' }), undefined, { nodeMajor: 24, startUi: mustNotStart }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already initialized/);
  });

  test('Node below 20: asks here instead, after the note; --terminal, --yes and --dry-run print no note', async () => {
    const dir = repo();
    const r = await withTty(() => initWith(dir, selection(), { nodeMajor: 18, startUi: mustNotStart }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[0], 'The setup wizard needs Node 20+; asking here instead.');
    assert.equal(r.calls.length, 1);
    assert.ok(exists(dir, '.shipline/config.yml'));
    for (const extra of [{ terminal: true }, { yes: true }, { dryRun: true }]) {
      const o = await withTty(() => initWith(repo(), selection(), { ...extra, nodeMajor: 18, startUi: mustNotStart }));
      assert.equal(o.code, 0, o.stderr);
      assert.ok(!/The setup wizard needs Node 20/.test(o.stdout), JSON.stringify(extra));
    }
  });

  test('init --terminal without a terminal is refused like any interactive run; --terminal --yes installs the defaults', () => {
    const dir = repo();
    const r = runInit(dir, { yes: false }, '--terminal');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /init asks questions, and this is not a terminal\. Run it in a terminal, or pass --yes/);
    assert.deepEqual(readdirSync(dir), []);
    const y = repo();
    const ry = runInit(y, '--terminal');
    assert.equal(ry.code, 0, ry.stderr);
    const plain = repo();
    assert.equal(runInit(plain).code, 0);
    assert.deepEqual(tree(y), tree(plain), '--terminal --yes is --yes');
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

// Setup polish plan, item 4: the terminal review before writing. --yes skips it.
describe('the review before writing', () => {
  test('shows every setting and the file list in the --dry-run format, then asks', async () => {
    const dir = repo({ 'CLAUDE.md': '# Team\n' });
    const r = await initWith(dir, selection({ workflows: ['hotfix'], agents: ['builder'], tracker: 'jira', confirmations: 'light', guardrails: 'off', branchPattern: 'feat/{slug}', ci: true }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.reviews.length, 1);
    const lines = r.reviews[0].split('\n');
    assert.equal(lines[0], 'Review');
    for (const want of [
      /^ {2}Workflows: +hotfix \(no UI: UI-only stages left out\)$/,
      /^ {2}Commands: +test: none; lint: none; build: none$/,
      /^ {2}Tracker: +jira$/,
      /^ {2}Confirmations: +light \(asks only at plan approval\)$/,
      /^ {2}Guardrails: +off \(every rail off, no protected paths\)$/,
      /^ {2}Branch pattern: feat\/\{slug\}$/,
      /^ {2}Agents: +builder$/,
      /^ {2}Skills: +none$/,
      /^ {2}CI check: +yes \(\.github\/workflows\/shipline\.yml\)$/,
    ]) {
      assert.ok(lines.some((l) => want.test(l)), `${want}\n${r.reviews[0]}`);
    }
    const files = lines.slice(lines.indexOf('Files:') + 1);
    assert.ok(files.length > 10);
    assert.ok(files.every((l) => /^ {2}[+~=] \S/.test(l)), r.reviews[0]);
    for (const l of ['  + .shipline/workflows/hotfix.yml', '  + .shipline/bin/VERSION', '  + .claude/settings.json (hooks and allow rules merged)', '  ~ CLAUDE.md (marked block appended)', '  + .github/workflows/shipline.yml', '  = .claude/agents/planner.md (not installed; recorded as excluded)']) {
      assert.ok(files.includes(l), l);
    }
    // It is printed too, before the question.
    assert.ok(r.stdout.includes(r.reviews[0]));
  });

  test('No: "Cancelled, nothing was written.", exit 1, and nothing is written', async () => {
    const dir = repo();
    const r = await initWith(dir, selection(), { confirm: () => false });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'Cancelled, nothing was written.');
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!existsSync(homeFor(dir)) || readdirSync(homeFor(dir)).length === 0, 'no task store either');
  });

  test('Yes installs; a cancelled question (Ctrl+C) writes nothing', async () => {
    const dir = repo();
    const r = await initWith(dir, selection(), { confirm: () => true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(exists(dir, '.shipline/bin/VERSION'));
    const c = repo();
    const rc = await initWith(c, selection(), {
      confirm: () => {
        throw new Error('User force closed the prompt');
      },
    });
    assert.equal(rc.code, 1);
    assert.match(rc.stderr, /init cancelled, nothing was written\. User force closed the prompt/);
    assert.deepEqual(readdirSync(c), []);
  });

  test('--yes and --dry-run show no review', async () => {
    assert.equal((await initWith(repo(), undefined, { yes: true })).reviews.length, 0);
    const d = await initWith(repo(), selection(), { dryRun: true });
    assert.equal(d.code, 0, d.stderr);
    assert.equal(d.reviews.length, 0);
  });
});

// Setup polish plan, item 2: guardrails and the branch pattern in config.yml.
describe('guardrails and the branch pattern', () => {
  const configText = (dir) => read(dir, '.shipline/config.yml');
  const template = () => readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');

  test('guardrails off: every rail off, protected_paths: [], and the note right above rails:; the hooks read it back', async () => {
    const dir = repo();
    const r = await initWith(dir, selection({ guardrails: 'off' }));
    assert.equal(r.code, 0, r.stderr);
    const text = configText(dir);
    const cfg = parseYaml(text);
    assert.deepEqual(cfg.rails, Object.fromEntries(RAIL_IDS.map((id) => [id, 'off'])));
    assert.deepEqual(cfg.protected_paths, []);
    const lines = text.split('\n');
    const at = lines.indexOf('rails:');
    assert.ok(at > 0);
    assert.equal(lines[at - 1], GUARDRAILS_OFF_NOTE);
    assert.equal(GUARDRAILS_OFF_NOTE, '# Guardrails are off (chosen at setup). Turn them on here or in Setup → Guardrails.');
    assert.equal(lines.filter((l) => l === GUARDRAILS_OFF_NOTE).length, 1);
    assert.ok(!text.includes('\r'));
    // The rest of the template's comments are kept.
    assert.ok(template().split('\n').filter((l) => l.startsWith('# ')).every((l) => lines.includes(l)));
    // The hook library reads every rail as off and protects nothing.
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.rails, Object.fromEntries(HOOK_RAIL_IDS.map((id) => [id, 'off'])));
    assert.deepEqual(loaded.protected_paths, []);
    // The next steps don't change.
    assert.ok(r.stdout.includes(nextSteps({}).join('\n')));
  });

  test('guardrails on (or left out): config.yml is the template', async () => {
    for (const sel of [selection({ guardrails: 'on' }), selection()]) {
      const dir = repo();
      assert.equal((await initWith(dir, sel)).code, 0);
      assert.equal(configText(dir), template());
    }
  });

  test('a custom branch pattern is written trimmed; the default (or none) leaves the template', async () => {
    const dir = repo();
    const r = await initWith(dir, selection({ branchPattern: '  {type}/{slug}  ' }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseYaml(configText(dir)).branch_pattern, '{type}/{slug}');
    assert.equal(configText(dir).split('\n').length, template().split('\n').length, 'only the one line changed');
    for (const sel of [selection({ branchPattern: DEFAULT_BRANCH_PATTERN }), selection()]) {
      const d = repo();
      assert.equal((await initWith(d, sel)).code, 0);
      assert.equal(configText(d), template());
    }
  });

  test('an invalid branch pattern or guardrails value is refused with nothing written', async () => {
    for (const [bad, msg] of [
      [{ branchPattern: '{type}/{key}' }, /branchPattern must contain \{slug\}/],
      [{ branchPattern: '{slug}-{user}' }, /branchPattern \{user\} is not allowed here; use \{key\}, \{slug\} or \{type\}/],
      [{ branchPattern: 7 }, /branchPattern must be text/],
      [{ guardrails: 'maybe' }, /guardrails must be on or off/],
      [{ confirmations: 'lite' }, /confirmations must be standard or light/],
    ]) {
      const d = repo();
      const b = await initWith(d, selection(bad));
      assert.equal(b.code, 1, JSON.stringify(bad));
      assert.match(b.stderr, msg);
      assert.deepEqual(readdirSync(d), [], JSON.stringify(bad));
    }
  });
});
