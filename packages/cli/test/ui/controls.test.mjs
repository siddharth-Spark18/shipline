// Chat reliability plan (docs/plans/shipline-chat-reliability.md), H. Chat controls on the server (controls.mjs):
// validation, the start-up flags, the control_request builders, the readers that keep only what the UI needs
// (never initialize's `account` or get_settings' merged settings), and <store>/ui/controls.json.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeFor, removeDir, storeOf, tmpDir } from '../helpers.mjs';
import {
  EFFORT_LEVELS,
  FALLBACK_MODELS,
  PERMISSION_MODES,
  controlArgs,
  controlRequest,
  modeFromControl,
  modeToControl,
  parseControlResponse,
  pickContext,
  pickEffort,
  pickModels,
  readDefaults,
  requests,
  validateControls,
  writeDefaults,
} from '../../src/ui/controls.mjs';
import { buildArgs } from '../../src/ui/claude.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) removeDir(d);
});

// initialize's models[] in the captured shape (2.1.318), with a field the server must not keep.
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true, isDefault: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Everyday', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'turbo'], supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Quick', supportsEffort: false, supportedEffortLevels: [], supportsAutoMode: false },
  { value: 'fable' },
];
const CLEAN_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Everyday', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Quick', supportsEffort: false, supportedEffortLevels: [], supportsAutoMode: false },
  { value: 'fable', resolvedModel: null, displayName: 'fable', description: '', supportsEffort: true, supportedEffortLevels: [], supportsAutoMode: true },
];

const badControl = (fn) =>
  assert.throws(fn, (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'bad-control');
    return true;
  });

describe('validateControls', () => {
  test('the lists match the plan', () => {
    assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(PERMISSION_MODES, ['manual', 'acceptEdits', 'plan', 'auto']);
    assert.deepEqual(FALLBACK_MODELS, ['default', 'opus', 'sonnet', 'haiku']);
  });

  test('good values: fallback aliases, cached values, full claude-* names, every effort and mode', () => {
    for (const model of ['default', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4.5'])
      assert.deepEqual(validateControls({ model }), { model });
    assert.deepEqual(validateControls({ model: 'fable' }, [{ value: 'fable' }]), { model: 'fable' });
    for (const effort of EFFORT_LEVELS) assert.deepEqual(validateControls({ effort }), { effort });
    for (const permissionMode of PERMISSION_MODES) assert.deepEqual(validateControls({ permissionMode }), { permissionMode });
    assert.deepEqual(validateControls({ model: 'opus', effort: 'low', permissionMode: 'plan', extra: 'ignored' }), {
      model: 'opus',
      effort: 'low',
      permissionMode: 'plan',
    });
    assert.deepEqual(validateControls({}), {});
  });

  test('bad values give 400 bad-control, shell metacharacters included', () => {
    for (const model of [
      'fable', // not cached, not a fallback, not claude-*
      'opus; rm -rf /',
      'opus && echo hi',
      '$(whoami)',
      '`id`',
      'claude-opus|cat',
      'claude-opus 5',
      'claude-OPUS',
      'claude-x\nrm',
      '--dangerously-skip-permissions',
      '',
      42,
      null,
      ['opus'],
    ])
      badControl(() => validateControls({ model }));
    for (const effort of ['ultra', 'HIGH', '', 'high;', null, 3]) badControl(() => validateControls({ effort }));
    for (const permissionMode of ['default', 'bypassPermissions', 'dontAsk', 'plan && x', 'Manual', null])
      badControl(() => validateControls({ permissionMode }));
    for (const input of [null, 'opus', ['opus'], 7]) badControl(() => validateControls(input));
  });
});

describe('controlArgs and buildArgs', () => {
  test('separate argv entries for the values that are set, in model / effort / mode order', () => {
    assert.deepEqual(controlArgs({ model: 'opus', effort: 'high', permissionMode: 'plan' }), [
      '--model', 'opus', '--effort', 'high', '--permission-mode', 'plan',
    ]);
    assert.deepEqual(controlArgs({ effort: 'low' }), ['--effort', 'low']);
    assert.deepEqual(controlArgs({ permissionMode: 'manual' }), ['--permission-mode', 'manual']);
    assert.deepEqual(controlArgs({}), []);
    assert.deepEqual(controlArgs(undefined), []);
    assert.deepEqual(controlArgs(null), []);
    assert.deepEqual(controlArgs({ model: '', effort: null }), []);
  });

  test('buildArgs appends them after the plan argv, and leaves them out when nothing is set', () => {
    const base = buildArgs({ sessionId: 's', mcpConfig: '/m.json' });
    assert.equal(base[base.length - 1], 'mcp__shipline_ui__approve');
    const withControls = buildArgs({ sessionId: 's', mcpConfig: '/m.json', controls: { model: 'claude-opus-5-5', permissionMode: 'acceptEdits' } });
    assert.deepEqual(withControls, [...base, '--model', 'claude-opus-5-5', '--permission-mode', 'acceptEdits']);
  });
});

describe('control_request builders and control_response parsing', () => {
  test('one JSON line per request, with the request_id and the captured subtypes', () => {
    const line = controlRequest('shipline-3', requests.setModel('opus'));
    assert.ok(line.endsWith('\n'));
    assert.equal(line.indexOf('\n'), line.length - 1, 'a single line');
    assert.deepEqual(JSON.parse(line), { type: 'control_request', request_id: 'shipline-3', request: { subtype: 'set_model', model: 'opus' } });
    assert.deepEqual(requests.initialize(), { subtype: 'initialize' });
    assert.deepEqual(requests.getSettings(), { subtype: 'get_settings' });
    assert.deepEqual(requests.getContextUsage(), { subtype: 'get_context_usage' });
    // set_effort is unsupported; the flag layer takes effortLevel.
    assert.deepEqual(requests.setEffort('max'), { subtype: 'apply_flag_settings', settings: { effortLevel: 'max' } });
    assert.deepEqual(requests.setPermissionMode('manual'), { subtype: 'set_permission_mode', mode: 'default' });
    assert.deepEqual(requests.setPermissionMode('plan'), { subtype: 'set_permission_mode', mode: 'plan' });
  });

  test('manual <-> default mapping', () => {
    assert.equal(modeToControl('manual'), 'default');
    assert.equal(modeToControl('acceptEdits'), 'acceptEdits');
    assert.equal(modeFromControl('default'), 'manual');
    assert.equal(modeFromControl('plan'), 'plan');
  });

  test('parseControlResponse reads the captured success and error shapes', () => {
    assert.deepEqual(
      parseControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: 'shipline-1', response: { model: 'claude-opus-5-5' } } }),
      { requestId: 'shipline-1', ok: true, response: { model: 'claude-opus-5-5' }, error: 'Unknown error' },
    );
    assert.deepEqual(
      parseControlResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'shipline-2', error: 'Unsupported control request subtype' } }),
      { requestId: 'shipline-2', ok: false, response: {}, error: 'Unsupported control request subtype' },
    );
    assert.equal(parseControlResponse({ type: 'control_response', response: { subtype: 'success' } }), null);
    assert.equal(parseControlResponse({ type: 'control_response' }), null);
    assert.equal(parseControlResponse({ type: 'result' }), null);
    assert.equal(parseControlResponse(null), null);
  });
});

describe('pick* keep only the listed fields', () => {
  test('pickModels: models[] (listed fields) and current_permission_mode; account and the rest are dropped', () => {
    const response = {
      models: MODELS,
      current_permission_mode: 'default',
      account: { email: 'dev@example.com', organization: 'Example Org' },
      commands: [{ name: 'x' }],
      output_style: 'default',
    };
    const picked = pickModels(response);
    assert.deepEqual(picked, { models: CLEAN_MODELS, permissionMode: 'manual' });
    assert.ok(!JSON.stringify(picked).includes('example'), 'nothing from account');
    assert.deepEqual(pickModels({ current_permission_mode: 'plan' }), { models: [], permissionMode: 'plan' });
    assert.deepEqual(pickModels(null), { models: [], permissionMode: null });
    assert.deepEqual(pickModels({ models: [null, 'x', { value: '' }, { displayName: 'no value' }] }).models, []);
  });

  test('pickEffort: applied.effort and applied.model only, never the merged settings', () => {
    const response = {
      effective: { env: { SECRET_TOKEN: 'x' }, permissions: { allow: ['Bash'] }, effortLevel: 'max', model: 'opus' },
      applied: { effort: 'xhigh', model: 'claude-opus-5-5', other: 'dropped' },
    };
    assert.deepEqual(pickEffort(response), { effort: 'xhigh', model: 'claude-opus-5-5' });
    assert.deepEqual(pickEffort({ applied: { effort: 'turbo' } }), { effort: null, model: null });
    assert.deepEqual(pickEffort({ effective: { effortLevel: 'max' } }), { effort: null, model: null });
    assert.deepEqual(pickEffort(null), { effort: null, model: null });
  });

  test('pickContext: the six fields and the 5 largest categories as { name, tokens }', () => {
    const response = {
      totalTokens: 19614,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
      percentage: 2,
      model: 'claude-opus-5-5',
      memoryFiles: [{ path: '/home/dev/.claude/CLAUDE.md', tokens: 900 }],
      categories: [
        { name: 'System prompt', tokens: 3100, color: 'a' },
        { name: 'System tools', tokens: 11800, color: 'b' },
        { name: 'MCP tools', tokens: 1200 },
        { name: 'Memory files', tokens: 900 },
        { name: 'Skills', tokens: 600 },
        { name: 'Messages', tokens: 2014 },
        { name: 'Free space', tokens: 0, isDeferred: true },
        { tokens: 99999 },
        null,
      ],
    };
    assert.deepEqual(pickContext(response), {
      totalTokens: 19614,
      maxTokens: 1000000,
      autoCompactThreshold: 967000,
      isAutoCompactEnabled: true,
      percentage: 2,
      categories: [
        { name: 'System tools', tokens: 11800 },
        { name: 'System prompt', tokens: 3100 },
        { name: 'Messages', tokens: 2014 },
        { name: 'MCP tools', tokens: 1200 },
        { name: 'Memory files', tokens: 900 },
      ],
    });
    assert.deepEqual(pickContext({}), {
      totalTokens: 0,
      maxTokens: 0,
      autoCompactThreshold: 0,
      isAutoCompactEnabled: false,
      percentage: 0,
      categories: [],
    });
  });
});

describe('controls.json', () => {
  function repo() {
    const root = tmpDir('shipline-controls-');
    dirs.push(root);
    process.env.SHIPLINE_HOME = homeFor(root);
    return { root, file: path.join(storeOf(root), 'ui', 'controls.json') };
  }

  test('missing or unreadable: no picks, no models', () => {
    const { root, file } = repo();
    assert.deepEqual(readDefaults(root), { models: [] });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    assert.deepEqual(readDefaults(root), { models: [] });
    writeFileSync(file, '[1,2]');
    assert.deepEqual(readDefaults(root), { models: [] });
  });

  test('writeDefaults merges picks and models into <store>/ui/controls.json; readDefaults reads them back', () => {
    const { root, file } = repo();
    assert.deepEqual(writeDefaults(root, { model: 'opus' }), { model: 'opus', models: [] });
    assert.deepEqual(writeDefaults(root, { effort: 'low', permissionMode: 'plan' }), { model: 'opus', effort: 'low', permissionMode: 'plan', models: [] });
    writeDefaults(root, { models: MODELS });
    assert.ok(existsSync(file));
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, { model: 'opus', effort: 'low', permissionMode: 'plan', models: CLEAN_MODELS });
    assert.deepEqual(readDefaults(root), onDisk);
    // A later pick keeps the models; a later models list keeps the picks.
    writeDefaults(root, { model: 'sonnet' });
    assert.equal(readDefaults(root).models.length, 4);
    writeDefaults(root, { models: [MODELS[2]] });
    assert.equal(readDefaults(root).model, 'sonnet');
    assert.deepEqual(readDefaults(root).models.map((m) => m.value), ['haiku']);
  });

  test('a hand-edited file cannot smuggle bad values or other keys into the flags', () => {
    const { root, file } = repo();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        model: 'opus; rm -rf /',
        effort: 'ultra',
        permissionMode: 'bypassPermissions',
        account: { email: 'dev@example.com' },
        models: [{ value: 'opus', account: 'x', resolvedModel: 'claude-opus-5-5' }],
      }),
    );
    const d = readDefaults(root);
    assert.deepEqual(d, {
      models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'opus', description: '', supportsEffort: true, supportedEffortLevels: [], supportsAutoMode: true }],
    });
    assert.deepEqual(controlArgs(d), []);
    // Bad picks passed to writeDefaults are ignored too.
    assert.deepEqual(writeDefaults(root, { model: '$(id)', effort: 'max' }).effort, 'max');
    assert.equal(readDefaults(root).model, undefined);
  });
});
