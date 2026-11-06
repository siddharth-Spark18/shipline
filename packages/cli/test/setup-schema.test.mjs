// Plan item 15: one failing case per check in the schema table, plus a passing case for each template.
// Phase 1: artifact_root and folder_pattern are no longer known fields; when present (interface-2 repos)
// they are kept as unknown keys and not validated.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { KNOWN_FIELDS, configLayout, headerFor, validateConfig, validateWorkflow } from '../src/setup-schema.mjs';
import { parseYaml } from '../templates/shipline/bin/lib.mjs';
import { CLI_ROOT, TEMPLATES } from './helpers.mjs';
import { emitConfig, emitWorkflow } from '../src/yaml-emit.mjs';

const AGENTS = readdirSync(path.join(CLI_ROOT, 'templates', 'claude', 'agents')).map((f) => f.replace(/\.md$/, ''));
const WORKFLOW_IDS = readdirSync(path.join(TEMPLATES, 'workflows')).map((f) => f.replace(/\.yml$/, ''));
const template = (id) => parseYaml(readFileSync(path.join(TEMPLATES, 'workflows', `${id}.yml`), 'utf8'));
const baseConfig = () => parseYaml(readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));

const errorsOnly = (issues) => issues.filter((i) => i.severity !== 'warning');
const paths = (issues) => issues.map((i) => i.path);

function wf(stages, extra = {}) {
  return { id: 'w', name: 'W', stages, ...extra };
}
const stage = (extra = {}) => ({ id: 's', name: 'S', enforcement: 'guide', ...extra });

describe('templates pass', () => {
  test('config.yml', () => {
    assert.deepEqual(validateConfig(baseConfig()), []);
  });
  for (const id of WORKFLOW_IDS) {
    test(`workflows/${id}.yml`, () => {
      const model = template(id);
      assert.deepEqual(validateWorkflow(model, { id, agents: AGENTS, existingStageIds: model.stages.map((s) => s.id) }), []);
    });
  }
});

describe('config.yml checks', () => {
  const bad = (patch, p, re) => {
    const issues = validateConfig({ ...baseConfig(), ...patch });
    assert.ok(issues.some((i) => i.path === p && re.test(i.message)), `${JSON.stringify(patch)} -> ${JSON.stringify(issues)}`);
  };
  test('artifact_root and folder_pattern are no longer checked: an interface-2 config keeps them as unknown keys', () => {
    for (const patch of [{ artifact_root: 'docs/../../etc' }, { artifact_root: '/tmp/tasks' }, { artifact_root: '' }, { folder_pattern: '{key}' }, { folder_pattern: '{slug}-{date}' }]) {
      assert.deepEqual(validateConfig({ ...baseConfig(), ...patch }), [], JSON.stringify(patch));
    }
  });
  test('the shipped config.yml has neither key', () => {
    assert.ok(!('artifact_root' in baseConfig()));
    assert.ok(!('folder_pattern' in baseConfig()));
  });
  test('branch_pattern without {slug} is rejected', () => bad({ branch_pattern: 'feat/{key}' }, 'branch_pattern', /\{slug\}/));
  test('a pattern with an unknown variable is rejected', () => bad({ branch_pattern: '{slug}-{date}' }, 'branch_pattern', /\{date\} is not allowed/));
  test('commands must be a map', () => bad({ commands: 'pnpm test' }, 'commands', /map/));
  test('a line break in a command is rejected', () => bad({ commands: { test: 'a\nb' } }, 'commands.test', /line breaks are not allowed here/));
  // Trust plan, Config: ci.missing_block is an enum, ci.skip_label non-empty and at most 50 characters; ci is optional.
  test('the shipped config.yml has the ci section with its defaults', () => {
    assert.deepEqual(baseConfig().ci, { missing_block: 'fail-unless-label', skip_label: 'shipline:skip', stale_checks: 'warn' });
  });
  test('ci is optional, and each mode and a 50-character label are accepted', () => {
    const { ci: _ci, ...noCi } = baseConfig();
    assert.deepEqual(validateConfig(noCi), []);
    assert.deepEqual(validateConfig({ ...baseConfig(), ci: null }), []);
    for (const m of ['fail-unless-label', 'warn', 'fail']) {
      assert.deepEqual(validateConfig({ ...baseConfig(), ci: { missing_block: m, skip_label: 'x'.repeat(50) } }), [], m);
    }
  });
  test('ci must be a map', () => bad({ ci: 'warn' }, 'ci', /map/));
  test('an unknown ci.missing_block is rejected', () => bad({ ci: { missing_block: 'ignore' } }, 'ci.missing_block', /fail-unless-label, warn, fail/));
  test('an empty ci.skip_label is rejected', () => bad({ ci: { skip_label: '  ' } }, 'ci.skip_label', /non-empty/));
  test('a ci.skip_label over 50 characters is rejected', () => bad({ ci: { skip_label: 'x'.repeat(51) } }, 'ci.skip_label', /at most 50/));
  test('unknown keys are allowed (kept)', () => {
    assert.deepEqual(validateConfig({ ...baseConfig(), team_owner: 'x', commands: { test: '', typecheck: 'tsc' } }), []);
  });

  // Prepublish plan: `skills` names the repo's own .claude/skills/<name> folders.
  describe('skills', () => {
    test('the shipped config.yml has skills: []', () => {
      assert.deepEqual(baseConfig().skills, []);
    });
    test('a list of names passes; absent or null passes', () => {
      assert.deepEqual(validateConfig({ ...baseConfig(), skills: ['deploy', 'db_migrate'] }), []);
      const { skills, ...noSkills } = baseConfig();
      assert.deepEqual(validateConfig(noSkills), []);
      assert.deepEqual(validateConfig({ ...baseConfig(), skills: null }), []);
    });
    test('skills must be a list', () => bad({ skills: 'deploy' }, 'skills', /list of skill names/));
    test('a name with a path or space in it is rejected', () => {
      for (const n of ['../x', 'a b', 'x/y', '', 3]) bad({ skills: ['ok', n] }, 'skills[1]', /letters, digits/);
    });
    test('a name with no .claude/skills/<name>/ folder is a warning, not an error (only when the folder list is given)', () => {
      const issues = validateConfig({ ...baseConfig(), skills: ['deploy', 'gone'] }, { skills: ['deploy'] });
      assert.deepEqual(issues.map((i) => [i.path, i.severity]), [['skills[1]', 'warning']]);
      assert.match(issues[0].message, /\.claude\/skills\/gone\//);
      assert.deepEqual(errorsOnly(issues), []);
      assert.deepEqual(validateConfig({ ...baseConfig(), skills: ['gone'] }), [], 'no folder list: no warning');
    });
    test('a config with skills round-trips through the writer', () => {
      const raw = readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');
      const model = { ...baseConfig(), skills: ['deploy', 'db_migrate'] };
      const out = emitConfig(model, { layout: configLayout(), raw });
      assert.deepEqual(parseYaml(out).skills, ['deploy', 'db_migrate']);
      assert.equal(emitConfig(baseConfig(), { layout: configLayout(), raw }), raw, 'skills: [] is written back unchanged');
    });
  });
});

describe('the small.yml template (Small change workflow)', () => {
  test('is shipped with the expected stages, agents and verify block', () => {
    assert.ok(WORKFLOW_IDS.includes('small'));
    const m = template('small');
    assert.equal(m.id, 'small');
    assert.equal(m.name, 'Small change');
    assert.deepEqual(m.stages.map((s) => s.id), ['ticket', 'implement', 'verify', 'pr']); // `jira` before 0.10.0
    assert.deepEqual(m.stages.map((s) => s.agent ?? null), [null, 'builder', 'qa-bug-hunter', 'builder']);
    const verify = m.stages.find((s) => s.id === 'verify');
    assert.equal(verify.enforcement, 'block');
    assert.equal(verify.confirm_to_advance, true);
    assert.deepEqual(verify.blocks, [{ actions: ['commit', 'pr'] }]); // Teams Phase 3, D: was the commit/PR regex
    for (const s of m.stages) assert.ok(AGENTS.includes(s.agent ?? 'builder'), s.id);
  });

  test('round-trips: a no-edit emit gives the exact bytes, and the re-parsed model is equal', () => {
    const text = readFileSync(path.join(TEMPLATES, 'workflows', 'small.yml'), 'utf8');
    const model = parseYaml(text);
    const out = emitWorkflow(model, { header: headerFor('small'), raw: text });
    assert.equal(out, text);
    assert.deepEqual(parseYaml(out), model);
    assert.ok(text.startsWith(headerFor('small')));
  });
});

describe('workflow checks', () => {
  test('enforcement must be guide, warn or block', () => {
    for (const enforcement of ['bogus', undefined, null, 'Block']) {
      const issues = validateWorkflow(wf([stage({ enforcement })]), { id: 'w' });
      assert.deepEqual(paths(errorsOnly(issues)), ['stages[0].enforcement'], String(enforcement));
    }
  });

  test('a duplicate stage id is rejected', () => {
    const issues = validateWorkflow(wf([stage({ id: 'a' }), stage({ id: 'a' })]), { id: 'w' });
    assert.ok(issues.some((i) => i.path === 'stages[1].id' && /duplicate/.test(i.message)));
  });

  test('an invalid new stage id is rejected', () => {
    const issues = validateWorkflow(wf([stage({ id: 'has space' })]), { id: 'w' });
    assert.deepEqual(paths(issues), ['stages[0].id']);
  });

  test('an existing stage id is read-only, so the format check skips it', () => {
    assert.deepEqual(validateWorkflow(wf([stage({ id: 'old.id' })]), { id: 'w', existingStageIds: ['old.id'] }), []);
  });

  test('a missing stage id is rejected', () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage({ id: undefined })]), { id: 'w' })), ['stages[0].id']);
  });

  test("an id that doesn't match the file name is rejected", () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage()], { id: 'other' }), { id: 'w' })), ['id']);
  });

  test('a workflow needs at least one stage', () => {
    assert.deepEqual(paths(validateWorkflow(wf([]), { id: 'w' })), ['stages']);
  });

  test('/ in an artifact is rejected', () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage({ artifact: 'sub/plan.md' })]), { id: 'w' })), ['stages[0].artifact']);
  });

  test('branch_type must match ^[A-Za-z0-9_-]*$', () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage()], { branch_type: 'feat/x' }), { id: 'w' })), ['branch_type']);
    assert.deepEqual(validateWorkflow(wf([stage()], { branch_type: '' }), { id: 'w' }), []);
  });

  test('optional and confirm_to_advance must be booleans', () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage({ optional: 'yes', confirm_to_advance: 1 })]), { id: 'w' })), [
      'stages[0].optional',
      'stages[0].confirm_to_advance',
    ]);
  });

  test('condition must be empty or ui_only', () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage({ condition: 'always' })]), { id: 'w' })), ['stages[0].condition']);
    assert.deepEqual(validateWorkflow(wf([stage({ condition: 'ui_only' })]), { id: 'w' }), []);
  });

  test("a tools regex that doesn't compile is rejected", () => {
    const issues = validateWorkflow(wf([stage({ enforcement: 'block', blocks: [{ tools: 'Edit|(', allow_paths: [] }] })]), { id: 'w' });
    assert.deepEqual(paths(issues), ['stages[0].blocks[0].tools']);
  });

  test("a bash regex that doesn't compile is rejected", () => {
    const issues = validateWorkflow(wf([stage({ enforcement: 'block', blocks: [{ bash: '[unclosed' }] })]), { id: 'w' });
    assert.deepEqual(paths(issues), ['stages[0].blocks[0].bash']);
  });

  test('a block entry needs tools or bash', () => {
    assert.deepEqual(paths(validateWorkflow(wf([stage({ enforcement: 'block', blocks: [{ allow_paths: ['x'] }] })]), { id: 'w' })), [
      'stages[0].blocks[0]',
    ]);
  });

  test('blocks under guide give a "has no effect" warning, not an error', () => {
    const issues = validateWorkflow(wf([stage({ blocks: [{ bash: 'git' }] })]), { id: 'w' });
    assert.deepEqual(issues, [{ path: 'stages[0].blocks', message: 'has no effect under guide', severity: 'warning' }]);
  });

  test('an unknown agent gives a warning, not an error', () => {
    const issues = validateWorkflow(wf([stage({ agent: 'ghost' })]), { id: 'w', agents: AGENTS });
    assert.equal(errorsOnly(issues).length, 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'warning');
    assert.equal(issues[0].path, 'stages[0].agent');
    assert.deepEqual(validateWorkflow(wf([stage({ agent: 'planner' })]), { id: 'w', agents: AGENTS }), []);
  });

  test('a line break in any string is rejected, including unknown keys', () => {
    for (const [model, p] of [
      [wf([stage({ name: 'a\nb' })]), 'stages[0].name'],
      [wf([stage()], { description: 'x\r' }), 'description'],
      [wf([stage({ custom: 'a\nb' })]), 'stages[0].custom'],
      [wf([stage({ enforcement: 'block', blocks: [{ tools: 'Edit', allow_paths: ['a\nb'] }] })]), 'stages[0].blocks[0].allow_paths[0]'],
    ]) {
      const issues = validateWorkflow(model, { id: 'w' });
      assert.ok(issues.some((i) => i.path === p && i.message === 'line breaks are not allowed here'), `${p}: ${JSON.stringify(issues)}`);
    }
  });

  test('unknown keys (top level or in a stage) are allowed', () => {
    assert.deepEqual(validateWorkflow(wf([stage({ sla: 4 })], { owner: 'x' }), { id: 'w' }), []);
  });
});

describe('tracker and setup (Teams Phase 1, D and E)', () => {
  test('jira, github, or no tracker at all pass with no issue', () => {
    for (const tracker of ['jira', 'github']) assert.deepEqual(validateConfig({ ...baseConfig(), tracker }), [], tracker);
    const none = baseConfig();
    delete none.tracker;
    assert.deepEqual(validateConfig(none), []);
  });

  test('any other tracker is a warning, not an error: "not supported; the ticket stage will be skipped"', () => {
    for (const tracker of ['linear', 'Jira', 'GitHub']) {
      const issues = validateConfig({ ...baseConfig(), tracker });
      assert.deepEqual(issues, [{ path: 'tracker', message: 'not supported; the ticket stage will be skipped', severity: 'warning' }], tracker);
      assert.deepEqual(errorsOnly(issues), []);
    }
  });

  test('setup: done is accepted as a top-level key', () => {
    assert.deepEqual(validateConfig({ ...baseConfig(), setup: 'done' }), []);
  });

  test('setup: done survives a write in the layout', () => {
    const raw = readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');
    const out = emitConfig({ ...baseConfig(), setup: 'done' }, { layout: configLayout(), raw });
    assert.equal(parseYaml(out).setup, 'done');
    assert.match(out, /^setup: done$/m);
  });
});

describe('known fields, header and layout', () => {
  test('KNOWN_FIELDS lists the form fields from the schema table', () => {
    // `setup` is known (so not listed under "other fields") but the form doesn't edit it (Teams Phase 1, E).
    // Teams Phase 3, F: the Guardrails section edits rails, rails_commands, protected_paths and scope_check.
    assert.deepEqual(KNOWN_FIELDS.config.top, ['branch_pattern', 'tracker', 'commands', 'skills', 'ci', 'setup', 'rails', 'rails_commands', 'protected_paths', 'scope_check']);
    assert.deepEqual(KNOWN_FIELDS.config.rails, ['force_push_default', 'push_default', 'pipe_to_shell', 'print_credentials', 'read_credentials', 'deploy', 'migrate', 'agent_config']);
    assert.deepEqual(KNOWN_FIELDS.config.rails_commands, ['deploy', 'migrate']);
    assert.deepEqual(KNOWN_FIELDS.config.scope_check, ['enabled', 'sensitive_extra']);
    assert.deepEqual(KNOWN_FIELDS.workflow.block, ['tools', 'allow_paths', 'bash', 'actions']);
    assert.deepEqual(KNOWN_FIELDS.config.commands, ['test', 'lint', 'build']);
    assert.deepEqual(KNOWN_FIELDS.config.ci, ['missing_block', 'skip_label', 'stale_checks']);
    for (const f of ['id', 'name', 'description', 'branch_type', 'stages']) assert.ok(KNOWN_FIELDS.workflow.top.includes(f), f);
    for (const f of ['id', 'name', 'artifact', 'description', 'optional', 'confirm_to_advance', 'condition', 'agent', 'enforcement', 'blocks', 'checks', 'sections']) {
      assert.ok(KNOWN_FIELDS.workflow.stage.includes(f), f);
    }
  });

  test('headerFor returns the leading # lines plus one blank line', () => {
    assert.equal(headerFor('bugfix'), '# Bugfix workflow (a default; edit freely or via /shipline-setup). See feature.yml for field docs.\n');
    const feature = readFileSync(path.join(TEMPLATES, 'workflows', 'feature.yml'), 'utf8');
    assert.ok(feature.startsWith(headerFor('feature')));
    assert.ok(headerFor('feature').split('\n').slice(0, -1).every((l) => l.startsWith('#')));
  });

  test('a workflow with no template, or a bad id, gets feature.yml header', () => {
    assert.equal(headerFor('review'), headerFor('feature'));
    assert.equal(headerFor('../config'), headerFor('feature'));
  });

  test('configLayout is the shipped config.yml', () => {
    assert.equal(configLayout(), readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
  });
});

// Teams Phase 2, G: the stage fields `checks` (a boolean) and `sections` (a list of non-empty headings), and
// config.yml's ci.stale_checks (warn | fail).
describe('checks, sections and ci.stale_checks (Teams Phase 2)', () => {
  test('the shipped workflows set checks: true on verify and the default sections', () => {
    for (const id of ['feature', 'bugfix', 'hotfix', 'small']) {
      const v = template(id).stages.find((s) => s.id === 'verify');
      assert.equal(v.checks, true, id);
      assert.deepEqual(v.sections, ['Checklist'], id);
    }
    assert.deepEqual(template('feature').stages.find((s) => s.id === 'plan').sections, ['Scope', 'Files to touch', 'Verification']);
    assert.deepEqual(template('feature').stages.find((s) => s.id === 'feasibility').sections, ['Risks']);
    assert.deepEqual(template('bugfix').stages.find((s) => s.id === 'root_cause').sections, ['Cause', 'Evidence']);
  });

  test('checks must be a boolean; absent or null is fine', () => {
    for (const checks of [true, false, null, undefined]) assert.deepEqual(validateWorkflow(wf([stage({ checks })]), { id: 'w' }), [], String(checks));
    for (const checks of ['yes', 1, []]) {
      const issues = validateWorkflow(wf([stage({ checks })]), { id: 'w' });
      assert.deepEqual(paths(issues), ['stages[0].checks'], JSON.stringify(checks));
      assert.match(issues[0].message, /true or false/);
    }
  });

  test('sections must be a list of non-empty strings; an empty list is fine', () => {
    for (const sections of [[], ['Scope'], ['Scope', 'Files to touch'], null]) {
      assert.deepEqual(validateWorkflow(wf([stage({ sections })]), { id: 'w' }), [], JSON.stringify(sections));
    }
    assert.deepEqual(paths(validateWorkflow(wf([stage({ sections: 'Scope' })]), { id: 'w' })), ['stages[0].sections']);
    assert.deepEqual(paths(validateWorkflow(wf([stage({ sections: ['Scope', '  ', 3] })]), { id: 'w' })), ['stages[0].sections[1]', 'stages[0].sections[2]']);
  });

  test('ci.stale_checks is warn or fail; absent is fine', () => {
    for (const stale_checks of ['warn', 'fail', undefined, null]) {
      assert.deepEqual(validateConfig({ ...baseConfig(), ci: { ...baseConfig().ci, stale_checks } }), [], String(stale_checks));
    }
    const issues = validateConfig({ ...baseConfig(), ci: { stale_checks: 'ignore' } });
    assert.deepEqual(paths(issues), ['ci.stale_checks']);
    assert.match(issues[0].message, /warn, fail/);
  });

  test('both stage fields and stale_checks survive a write in the layout', () => {
    const raw = readFileSync(path.join(TEMPLATES, 'workflows', 'feature.yml'), 'utf8');
    const model = parseYaml(raw);
    const verify = model.stages.find((s) => s.id === 'verify');
    verify.checks = false;
    verify.sections = ['Checklist', 'Risks: accepted'];
    const out = parseYaml(emitWorkflow(model, { header: headerFor('feature'), raw }));
    assert.equal(out.stages.find((s) => s.id === 'verify').checks, false);
    assert.deepEqual(out.stages.find((s) => s.id === 'verify').sections, ['Checklist', 'Risks: accepted']);
    const cfg = { ...baseConfig(), ci: { ...baseConfig().ci, stale_checks: 'fail' } };
    assert.equal(parseYaml(emitConfig(cfg, { layout: configLayout() })).ci.stale_checks, 'fail');
  });
});

// Teams Phase 3, B, C, D, E and F: the guardrail keys in config.yml and the `actions` block type.
describe('guardrails (Teams Phase 3)', () => {
  const issuesOf = (patch) => validateConfig({ ...baseConfig(), ...patch });
  const errorPaths = (patch) => paths(errorsOnly(issuesOf(patch)));
  const warningPaths = (patch) => paths(issuesOf(patch).filter((i) => i.severity === 'warning'));

  test('the shipped config.yml has every rail at its default, the protected paths, rails_commands and scope_check', () => {
    const c = baseConfig();
    assert.deepEqual(c.rails, {
      force_push_default: 'deny',
      push_default: 'ask',
      pipe_to_shell: 'deny',
      print_credentials: 'deny',
      read_credentials: 'ask',
      deploy: 'ask',
      migrate: 'ask',
      agent_config: 'ask',
    });
    assert.deepEqual(c.rails_commands, { deploy: [], migrate: [] });
    assert.deepEqual(c.scope_check, { enabled: true, sensitive_extra: [] });
    assert.deepEqual(c.protected_paths, [
      'migrations/**', 'db/migrate/**', 'prisma/migrations/**', 'alembic/versions/**', 'infra/**', 'terraform/**', '**/*.tf', 'k8s/**', 'helm/**',
      '**/Dockerfile*', '**/docker-compose*', '.github/workflows/**', '.gitlab-ci.yml', '.circleci/**', 'Jenkinsfile', 'package-lock.json',
      'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'Cargo.lock', 'go.sum',
    ]);
  });

  test('every key is optional, and empty values pass', () => {
    const c = baseConfig();
    for (const k of ['rails', 'rails_commands', 'protected_paths', 'scope_check']) delete c[k];
    assert.deepEqual(validateConfig(c), []);
    assert.deepEqual(validateConfig({ ...c, rails: null, rails_commands: null, protected_paths: [], scope_check: null }), []);
    assert.deepEqual(validateConfig({ ...c, rails: { deploy: 'off' }, rails_commands: { deploy: ['make ship'] }, scope_check: { enabled: false } }), []);
  });

  test('rails: an unknown rail or level is a warning (the default is used); a non-map is an error', () => {
    assert.deepEqual(warningPaths({ rails: { deploy: 'maybe', nuke: 'deny', migrate: 'off' } }), ['rails.deploy', 'rails.nuke']);
    assert.deepEqual(errorPaths({ rails: { deploy: 'maybe', nuke: 'deny' } }), []);
    assert.deepEqual(errorPaths({ rails: ['deploy'] }), ['rails']);
    assert.deepEqual(errorPaths({ rails: 'deny' }), ['rails']);
  });

  test('rails_commands: lists of non-empty text; an unknown key warns', () => {
    assert.deepEqual(errorPaths({ rails_commands: 'make ship' }), ['rails_commands']);
    assert.deepEqual(errorPaths({ rails_commands: { deploy: 'make ship' } }), ['rails_commands.deploy']);
    assert.deepEqual(errorPaths({ rails_commands: { migrate: ['ok', ''] } }), ['rails_commands.migrate[1]']);
    assert.deepEqual(warningPaths({ rails_commands: { deploy: [], publish: [] } }), ['rails_commands.publish']);
  });

  test('protected_paths: a list of non-empty text', () => {
    assert.deepEqual(errorPaths({ protected_paths: 'infra/**' }), ['protected_paths']);
    assert.deepEqual(errorPaths({ protected_paths: ['infra/**', '  ', 3] }), ['protected_paths[1]', 'protected_paths[2]']);
  });

  test('scope_check: enabled is true or false, sensitive_extra a list', () => {
    assert.deepEqual(errorPaths({ scope_check: true }), ['scope_check']);
    assert.deepEqual(errorPaths({ scope_check: { enabled: 'yes' } }), ['scope_check.enabled']);
    assert.deepEqual(errorPaths({ scope_check: { enabled: true, sensitive_extra: 'x' } }), ['scope_check.sensitive_extra']);
  });

  test('a line break in a guardrail value is rejected', () => {
    assert.ok(errorPaths({ protected_paths: ['a\nb'] }).length > 0);
  });

  test('the new keys survive an emit in the layout, edits included, and the protected_paths block list stays a block list', () => {
    const raw = readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8');
    const model = baseConfig();
    model.rails.deploy = 'deny';
    model.rails.agent_config = 'off';
    model.rails_commands.deploy = ['make ship'];
    model.protected_paths.push('secrets/**');
    model.scope_check = { enabled: false, sensitive_extra: ['config/**'] };
    const out = emitConfig(model, { layout: configLayout(), raw });
    const back = parseYaml(out);
    assert.deepEqual(back.rails, model.rails);
    assert.deepEqual(back.rails_commands, model.rails_commands);
    assert.deepEqual(back.protected_paths, model.protected_paths);
    assert.deepEqual(back.scope_check, model.scope_check);
    assert.match(out, /^ {2}- '\*\*\/\*\.tf'$/m, 'unchanged items keep their quoting');
    assert.match(out, /^ {2}- go\.sum\n {2}- secrets\/\*\*\n\n# At Verify/m);
    assert.match(out, /^ {2}# Edits to \.claude[^\n]*\n {2}agent_config: off$/m, 'the comment above each rail is kept');
    assert.deepEqual(validateConfig(back), []);
  });
});

describe('the actions block type (Teams Phase 3, D)', () => {
  const blockIssues = (blocks) => validateWorkflow(wf([stage({ enforcement: 'block', blocks })]), { id: 'w', agents: AGENTS, existingStageIds: ['s'] });
  test('a block with only actions is valid, with every known action', () => {
    assert.deepEqual(blockIssues([{ actions: ['commit', 'push', 'pr', 'merge', 'release', 'deploy', 'migrate'] }]), []);
  });
  test('an unknown action is a warning (it never matches), not an error', () => {
    const issues = blockIssues([{ actions: ['commit', 'squash'] }]);
    assert.deepEqual(issues.map((i) => [i.path, i.severity]), [['stages[0].blocks[0].actions[1]', 'warning']]);
  });
  test('an empty or non-list actions is an error', () => {
    for (const actions of [[], 'commit', { commit: true }]) {
      assert.deepEqual(paths(errorsOnly(blockIssues([{ actions }]))), ['stages[0].blocks[0].actions'], JSON.stringify(actions));
    }
  });
  test('a block with none of tools, bash or actions is still an error that names all three', () => {
    const issues = errorsOnly(blockIssues([{ allow_paths: ['x'] }]));
    assert.ok(issues.some((i) => i.path === 'stages[0].blocks[0]' && /tools \(with allow_paths\), bash or actions/.test(i.message)), JSON.stringify(issues));
  });
  test('an actions block is written inline and reads back', () => {
    const model = wf([stage({ enforcement: 'block', blocks: [{ actions: ['commit', 'pr'] }, { bash: 'x' }] })]);
    const out = emitWorkflow(model, {});
    assert.match(out, /^ {6}- actions: \[commit, pr\]$/m);
    assert.deepEqual(parseYaml(out), model);
  });
});
