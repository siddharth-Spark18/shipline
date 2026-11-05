// Plan item 13: the YAML writer (src/yaml-emit.mjs) against the vendored parser (templates/shipline/bin/lib.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { emitConfig, emitWorkflow, rawScalars } from '../src/yaml-emit.mjs';
import { configLayout, headerFor, validateWorkflow } from '../src/setup-schema.mjs';
import { parseYaml } from '../templates/shipline/bin/lib.mjs';
import { FIXTURES, TEMPLATES } from './helpers.mjs';

const YAML_FIXTURES = path.join(FIXTURES, 'yaml');

// {} -> null everywhere: the parser reads `key:` with nothing nested as null.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return null;
    const out = {};
    for (const k of keys) out[k] = norm(v[k]);
    return out;
  }
  return v;
}

function isConfigFile(file) {
  return path.basename(file) === 'config.yml' || path.basename(file).startsWith('config-');
}

// Emits a file's own model with its own text as `raw`, the way a no-edit save does.
function reEmit(file, text) {
  const model = parseYaml(text);
  if (isConfigFile(file)) return emitConfig(model, { layout: configLayout(), raw: text });
  return emitWorkflow(model, { header: headerFor(model.id), raw: text });
}

const templateFiles = [path.join(TEMPLATES, 'config.yml'), ...readdirSync(path.join(TEMPLATES, 'workflows')).map((f) => path.join(TEMPLATES, 'workflows', f))].filter(
  (f) => f.endsWith('.yml'),
);
const fixtureFiles = readdirSync(YAML_FIXTURES)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => path.join(YAML_FIXTURES, f));

describe('round trip: parse, emit with raw, parse again', () => {
  for (const file of [...templateFiles, ...fixtureFiles]) {
    test(path.relative(path.dirname(path.dirname(file)), file), () => {
      const text = readFileSync(file, 'utf8');
      const model = parseYaml(text);
      const emitted = reEmit(file, text);
      assert.deepEqual(norm(parseYaml(emitted)), norm(model));
    });
  }
});

describe('templates unchanged: a no-edit emit gives the exact bytes on disk', () => {
  for (const file of templateFiles) {
    test(path.basename(file), () => {
      const text = readFileSync(file, 'utf8');
      assert.equal(reEmit(file, text), text);
    });
  }

  test('an edit elsewhere keeps the original quoting of unchanged values (feature.yml)', () => {
    const text = readFileSync(path.join(TEMPLATES, 'workflows', 'feature.yml'), 'utf8');
    const model = parseYaml(text);
    model.name = 'Feature work';
    model.stages.find((s) => s.id === 'plan').enforcement = 'warn';
    const out = emitWorkflow(model, { header: headerFor('feature'), raw: text });
    assert.match(out, /^name: Feature work$/m);
    assert.match(out, /^      - tools: 'Edit\|Write\|MultiEdit\|NotebookEdit'$/m);
    assert.doesNotMatch(out, /^\s+allow_paths:|\{artifact_root\}/m); // Phase 1: removed from the template
    assert.match(out, /^      - bash: '\\bgit\\s\+commit\\b\|\\bgh\\s\+pr\\s\+create\\b'$/m);
    assert.deepEqual(parseYaml(out), model);
  });

  test('rawScalars keys stage lists by id and other lists by index', () => {
    const text = readFileSync(path.join(TEMPLATES, 'workflows', 'feature.yml'), 'utf8');
    const raw = rawScalars(text);
    assert.equal(raw.get('stages[id=plan].blocks[0].tools'), "'Edit|Write|MultiEdit|NotebookEdit'");
    assert.equal(raw.get('stages[id=plan].blocks[0].allow_paths'), undefined);
    const both = rawScalars(readFileSync(path.join(YAML_FIXTURES, 'workflow-both-blocks.yml'), 'utf8'));
    const sid = parseYaml(readFileSync(path.join(YAML_FIXTURES, 'workflow-both-blocks.yml'), 'utf8')).stages[0].id;
    assert.equal(both.get(`stages[id=${sid}].blocks[0].allow_paths[1]`), '"docs/**"');
    assert.equal(raw.get('stages[id=verify].enforcement'), 'block');
    const cfg = rawScalars(readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    assert.equal(cfg.get('folder_pattern'), undefined); // Phase 1: removed from the template
    assert.equal(cfg.get('branch_pattern'), '"{type}/{key}-{slug}"');
    assert.equal(cfg.get('commands.test'), '""');
  });
});

describe('fixtures (item 14)', () => {
  const fx = (name) => readFileSync(path.join(YAML_FIXTURES, name), 'utf8');
  const expected = (name) => readFileSync(path.join(YAML_FIXTURES, 'expected', name), 'utf8');

  for (const name of ['config-team-comment.yml', 'config-empty-commands.yml', 'config-no-tracker.yml', 'config-reordered.yml', 'config-unknown-key.yml']) {
    test(`${name} is written in the layout as expected`, () => {
      const text = fx(name);
      assert.equal(emitConfig(parseYaml(text), { layout: configLayout(), raw: text }), expected(name));
    });
  }

  test('config-unknown-key.yml keeps an interface-2 artifact_root and folder_pattern as unknown keys, quoting intact', () => {
    const out = emitConfig(parseYaml(fx('config-unknown-key.yml')), { layout: configLayout(), raw: fx('config-unknown-key.yml') });
    assert.match(out, /^artifact_root: docs\/shipline$/m);
    assert.match(out, /^folder_pattern: "\{key\}-\{slug\}"$/m);
    assert.equal(parseYaml(out).artifact_root, 'docs/shipline');
  });

  test('a team comment in config.yml is not written back', () => {
    const out = emitConfig(parseYaml(fx('config-team-comment.yml')), { layout: configLayout(), raw: fx('config-team-comment.yml') });
    assert.doesNotMatch(out, /Team note/);
    assert.doesNotMatch(out, /cloud instance/);
  });

  test('an empty commands map {} is written as a bare `commands:`', () => {
    const model = parseYaml(readFileSync(path.join(TEMPLATES, 'config.yml'), 'utf8'));
    model.commands = {};
    const out = emitConfig(model, { layout: configLayout() });
    // The shipped config has `skills: []` after the commands block, then ends with the ci block (Trust plan).
    assert.match(out, /\ncommands:\n\n# Optional[^\n]*\nskills: \[\]\n\n# Optional[^\n]*\n# missing_block:[^\n]*\nci:\n {2}missing_block: fail-unless-label\n {2}# The PR label[^\n]*\n {2}skip_label: shipline:skip\n$/);
    assert.equal(parseYaml(out).commands, null);
  });

  test('unknown keys at the top level and inside a stage survive', () => {
    const text = fx('workflow-unknown-keys.yml');
    const out = reEmit('workflow-unknown-keys.yml', text);
    const m = parseYaml(out);
    assert.equal(m.owner, 'platform-team');
    assert.equal(m.stages[0].sla_hours, 24);
    assert.deepEqual(m.stages[0].reviewers, ['alice', 'bob']);
  });

  test('a stage with both kinds of blocks keeps both', () => {
    const text = fx('workflow-both-blocks.yml');
    const out = reEmit('workflow-both-blocks.yml', text);
    assert.ok(out.endsWith(text), 'body after the header is byte-identical');
    assert.deepEqual(parseYaml(out).stages[0].blocks, [
      { tools: 'Edit|Write|MultiEdit|NotebookEdit', allow_paths: ['{artifact_root}/**', 'docs/**'] },
      { bash: '\\bgit\\s+commit\\b|\\bgh\\s+pr\\s+create\\b' },
    ]);
  });

  test('condition: ui_only and a custom branch_type are kept', () => {
    assert.equal(parseYaml(reEmit('workflow-ui-only.yml', fx('workflow-ui-only.yml'))).stages[0].condition, 'ui_only');
    assert.equal(parseYaml(reEmit('workflow-branch-type.yml', fx('workflow-branch-type.yml'))).branch_type, 'maint');
  });

  test('inline comments inside a workflow are dropped; the header comes from feature.yml', () => {
    const out = reEmit('workflow-inline-comments.yml', fx('workflow-inline-comments.yml'));
    assert.ok(out.startsWith(headerFor('feature')));
    assert.ok(headerFor('spike') === headerFor('feature'));
    for (const gone of ['time-boxed', 'try things out', 'only a reminder', 'hand-edited header']) assert.ok(!out.includes(gone), gone);
  });

  test('a quoted numeric artifact name stays a quoted string', () => {
    const text = fx('workflow-quoted-number.yml');
    const out = reEmit('workflow-quoted-number.yml', text);
    assert.match(out, /^    artifact: "123"$/m);
    assert.equal(parseYaml(out).stages[0].artifact, '123');
    // Also when written as a new value (no raw text to reuse).
    const fresh = emitWorkflow(parseYaml(text));
    assert.match(fresh, /^    artifact: "123"$/m);
  });
});

// A new value is emitted under `name:` with no raw text, then read back.
function emitValue(value) {
  const text = emitWorkflow({ id: 'x', name: value });
  const line = text.split('\n').find((l) => l.startsWith('name'));
  return { text, line, back: parseYaml(text).name };
}

describe('quoting of new values', () => {
  const cases = [
    ['', 'name: ""'],
    ['true', 'name: "true"'],
    ['false', 'name: "false"'],
    ['null', 'name: "null"'],
    ['~', 'name: "~"'],
    ['12', 'name: "12"'],
    ['-3.5', 'name: "-3.5"'],
    ['a: b', 'name: "a: b"'],
    ['x #y', 'name: "x #y"'],
    ['-x', 'name: "-x"'],
    ['#x', 'name: "#x"'],
    ['[x', 'name: "[x"'],
    ['"q', 'name: "\\"q"'],
    ["'q", 'name: "\'q"'],
    [' lead', 'name: " lead"'],
    ['trail ', 'name: "trail "'],
    ['\\bgit\\s+commit\\b', "name: '\\bgit\\s+commit\\b'"],
    ["a|it's", "name: 'a|it''s'"],
    ["it's #x|y", 'name: "it\'s #x|y"'],
    ['plain words', 'name: plain words'],
    ['a:b', 'name: a:b'],
    ["it's", "name: it's"],
  ];
  for (const [value, line] of cases) {
    test(JSON.stringify(value), () => {
      const r = emitValue(value);
      assert.equal(r.line, line);
      assert.equal(r.back, value);
    });
  }

  test('numbers and booleans are written bare', () => {
    const text = emitWorkflow({ id: 'x', n: 12, neg: -3, f: 1.5, t: true, no: false, nothing: null, empty: [], map: {} });
    assert.equal(text, 'id: x\nn: 12\nneg: -3\nf: 1.5\nt: true\nno: false\nnothing:\nempty: []\nmap:\n');
    assert.deepEqual(parseYaml(text), { id: 'x', n: 12, neg: -3, f: 1.5, t: true, no: false, nothing: null, empty: [], map: null });
  });
});

function emitList(list) {
  const text = emitWorkflow({ id: 'x', items: list });
  return { text, back: parseYaml(text).items };
}

describe('quoting of inline-list items', () => {
  const cases = [
    [['a', 'b'], 'items: [a, b]'],
    [['a', 'b,c'], 'items: [a, "b,c"]'],
    [['x]'], 'items: ["x]"]'],
    [['[x'], 'items: ["[x"]'],
    [["it's"], 'items: ["it\'s"]'],
    [['say "hi"'], 'items: [\'say "hi"\']'],
    [['true', '12', ''], 'items: ["true", "12", ""]'],
    [['{artifact_root}/**'], 'items: [{artifact_root}/**]'],
  ];
  for (const [list, line] of cases) {
    test(JSON.stringify(list), () => {
      const r = emitList(list);
      assert.equal(r.text.split('\n')[1], line);
      assert.deepEqual(r.back, list);
    });
  }

  test('an item with both " and , is written as a block list', () => {
    const r = emitList(['plain', 'a "b", c']);
    assert.match(r.text, /^items:\n  - plain\n  - /m);
    assert.deepEqual(r.back, ['plain', 'a "b", c']);
  });

  test("an item with both ' and ' #' is written as a block list", () => {
    const r = emitList(["it's #x|y"]);
    assert.match(r.text, /^items:\n  - "it's #x\|y"$/m);
    assert.deepEqual(r.back, ["it's #x|y"]);
  });
});

describe('rejected values', () => {
  test('a string with a newline is rejected by the schema, not emitted', () => {
    const errors = validateWorkflow({ id: 'x', name: 'two\nlines', stages: [{ id: 's', enforcement: 'guide' }] }, { id: 'x' });
    assert.deepEqual(errors, [{ path: 'name', message: 'line breaks are not allowed here' }]);
    assert.throws(() => emitWorkflow({ id: 'x', name: 'two\nlines' }), /line breaks are not allowed here/);
    assert.throws(() => emitWorkflow({ id: 'x', items: ['tab\there'] }), /line breaks are not allowed here/);
  });
});

// ---------- generated input ----------

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLE_STRINGS = ['', 'true', '12', 'a: b', 'x #y', '-lead', ' spaced ', 'trail ', '\\bgit\\s+commit\\b|it\'s', 'a,b', 'x]', '[y', '"quoted"', "it's", 'say "hi"', "it's #x|y", 'a "b", c', 'plain', 'docs/**', '{slug}'];

function generator(seed) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const key = () => {
    const n = 1 + Math.floor(r() * 8);
    let s = '';
    for (let i = 0; i < n; i++) s += pick('abcdefghijklmnopqrstuvwxyz_');
    return s;
  };
  const scalar = () => {
    const k = r();
    if (k < 0.6) return pick(TABLE_STRINGS);
    if (k < 0.75) return r() < 0.5;
    return Math.floor(r() * 2000) - 1000;
  };
  const map = (depth) => {
    const out = {};
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) out[key()] = value(depth + 1);
    return out;
  };
  const value = (depth) => {
    const k = r();
    if (depth >= 3 || k < 0.5) return scalar();
    if (k < 0.65) return map(depth);
    if (k < 0.85) return Array.from({ length: 1 + Math.floor(r() * 4) }, scalar);
    return Array.from({ length: 1 + Math.floor(r() * 3) }, () => map(depth + 1));
  };
  return () => map(0);
}

test('500 generated models round-trip (and re-emitting with raw is stable)', () => {
  const next = generator(20261104);
  for (let i = 0; i < 500; i++) {
    const model = next();
    let text;
    try {
      text = emitWorkflow(model);
    } catch (e) {
      assert.fail(`model #${i} could not be emitted: ${e.message}\n${JSON.stringify(model)}`);
    }
    let back;
    try {
      back = parseYaml(text);
    } catch (e) {
      assert.fail(`model #${i} emitted text that does not parse: ${e.message}\n${text}`);
    }
    assert.deepEqual(norm(back), norm(model), `model #${i}\n${text}`);
    assert.equal(emitWorkflow(back, { raw: text }), text, `model #${i} re-emit with raw differs`);
  }
});
