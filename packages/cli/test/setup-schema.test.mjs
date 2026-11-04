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
  test('unknown keys are allowed (kept)', () => {
    assert.deepEqual(validateConfig({ ...baseConfig(), team_owner: 'x', commands: { test: '', typecheck: 'tsc' } }), []);
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

describe('known fields, header and layout', () => {
  test('KNOWN_FIELDS lists the form fields from the schema table', () => {
    assert.deepEqual(KNOWN_FIELDS.config.top, ['branch_pattern', 'tracker', 'commands']);
    assert.deepEqual(KNOWN_FIELDS.config.commands, ['test', 'lint', 'build']);
    for (const f of ['id', 'name', 'description', 'branch_type', 'stages']) assert.ok(KNOWN_FIELDS.workflow.top.includes(f), f);
    for (const f of ['id', 'name', 'artifact', 'description', 'optional', 'confirm_to_advance', 'condition', 'agent', 'enforcement', 'blocks']) {
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
