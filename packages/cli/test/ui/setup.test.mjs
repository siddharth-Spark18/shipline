// Plan item 45, Setup and Interchangeability (Goals 4, 5 and 6): GET /api/setup, preview, save and
// workflow copy/delete against a real server on temporary repos.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, makeRepo, removeDir, runInit, stage, storeOf } from '../helpers.mjs';
import { api, openEvents, startUi } from './helpers.mjs';
import { headerFor } from '../../src/setup-schema.mjs';

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

let dir;
let ui;
const extra = []; // other repos/servers to clean up

const read = (rel) => readFileSync(path.join(dir, rel), 'utf8');
const write = (rel, text) => writeFileSync(path.join(dir, rel), text);
const getSetup = async (u = ui) => {
  const r = await api(u, 'GET', '/api/setup');
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const wfEntry = (setup, id) => setup.workflows.find((w) => w.id === id);
const asSave = (f) => ({ kind: f.kind, ...(f.id !== undefined ? { id: f.id } : {}), ...(f.kind === 'rules' ? { text: f.raw } : { model: f.model }), baseHash: f.hash });
const save = (files, u = ui) => api(u, 'POST', '/api/setup/save', { body: { files } });
const preview = (files, u = ui) => api(u, 'POST', '/api/setup/preview', { body: { files } });

function snapshot(root) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.name === '.state') continue;
      if (e.isDirectory()) walk(r);
      else out[r] = readFileSync(path.join(root, r), 'utf8');
    }
  };
  walk('.shipline');
  return out;
}

async function scratchRepo(prepare) {
  const d = makeRepo();
  if (prepare) prepare(d);
  const u = await startUi(d);
  extra.push({ dir: d, ui: u });
  return { dir: d, ui: u };
}

before(async () => {
  dir = makeRepo({ commitInit: true });
  ui = await startUi(dir);
});

after(async () => {
  for (const x of extra) {
    await x.ui.close();
    removeDir(x.dir);
  }
  if (ui) await ui.close();
  removeDir(dir);
});

describe('GET /api/setup', () => {
  test('returns every file with model, raw and hash, and the agent names', async () => {
    const s = await getSetup();
    assert.equal(s.config.kind, 'config');
    assert.equal(s.config.raw, read('.shipline/config.yml'));
    assert.equal(s.config.hash, sha256(s.config.raw));
    assert.ok(!('artifact_root' in s.config.model), 'Phase 1: artifact_root is gone from the shipped config');
    assert.ok(!('folder_pattern' in s.config.model));
    assert.deepEqual(s.workflows.map((w) => w.id), ['bugfix', 'feature', 'hotfix', 'small']);
    for (const w of s.workflows) {
      assert.equal(w.kind, 'workflow');
      assert.equal(w.hash, sha256(read(`.shipline/workflows/${w.id}.yml`)));
      assert.equal(w.model.id, w.id);
    }
    assert.ok(s.rules.some((r) => r.id === 'plan' && r.kind === 'rules' && r.raw === read('.shipline/rules/plan.md')));
    // Prepublish plan: agents is { shipline: [{ name, installed, excluded, hash }], repo: [name] }.
    assert.deepEqual(s.agents.shipline.map((a) => a.name), ['planner', 'builder', 'reviewer', 'qa-bug-hunter', 'wireframe-proposer', 'researcher']);
    for (const a of s.agents.shipline) {
      assert.deepEqual(a, { name: a.name, installed: true, excluded: false, hash: sha256(read(`.claude/agents/${a.name}.md`)) });
    }
    assert.deepEqual(s.agents.repo, []);
    assert.deepEqual(s.skills, { repo: [], selected: [] });
    assert.equal(s.versionHash, sha256(read('.shipline/bin/VERSION')));
  });

  test('a file that does not parse is returned with its error, and cannot be saved', async () => {
    write('.shipline/workflows/broken.yml', 'id: broken\n    stray: indent\n');
    try {
      const s = await getSetup();
      const b = wfEntry(s, 'broken');
      assert.equal(b.raw, 'id: broken\n    stray: indent\n');
      assert.match(b.parseError, /line 2: unexpected indentation/);
      assert.equal(b.model, undefined);
      assert.equal(b.hash, undefined);
      const r = await save([{ kind: 'workflow', id: 'broken', model: { id: 'broken', stages: [{ id: 'a', enforcement: 'guide' }] }, baseHash: sha256(b.raw) }]);
      assert.equal(r.status, 400);
      assert.equal(read('.shipline/workflows/broken.yml'), 'id: broken\n    stray: indent\n');
    } finally {
      rmSync(path.join(dir, '.shipline/workflows/broken.yml'));
    }
  });
});

describe('saving', () => {
  test('saving each template unchanged leaves its bytes unchanged', async () => {
    const before = snapshot(dir);
    const s = await getSetup();
    const files = [s.config, ...s.workflows, ...s.rules].map(asSave);
    const p = await preview(files);
    assert.equal(p.status, 200, p.text);
    for (const f of p.json.files) {
      assert.deepEqual(f.diff, [], `${f.kind} ${f.id}`);
      assert.deepEqual(f.removedComments, [], `${f.kind} ${f.id}`);
      assert.deepEqual(f.errors, [], `${f.kind} ${f.id}`);
    }
    assert.deepEqual(p.json.impact, []);
    const r = await save(files);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(snapshot(dir), before);
  });

  test('editing enforcement and saving is reflected by `stage.mjs status`', async () => {
    assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], 's1').code, 0);
    assert.match(stage(dir, ['status'], 's1').stdout, /Enforcement: guide\./);
    const s = await getSetup();
    const f = wfEntry(s, 'feature');
    const model = clone(f.model);
    model.stages.find((x) => x.id === 'jira').enforcement = 'warn';
    const before = read('.shipline/workflows/feature.yml');
    const r = await save([{ kind: 'workflow', id: 'feature', model, baseHash: f.hash }]);
    assert.equal(r.status, 200, r.text);
    const after = read('.shipline/workflows/feature.yml');
    assert.deepEqual(r.json.written, [{ kind: 'workflow', id: 'feature', hash: sha256(after) }]);
    // Exactly one line changed.
    const a = before.split('\n');
    const b = after.split('\n');
    assert.equal(a.length, b.length);
    assert.deepEqual(a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y), [['    enforcement: guide', '    enforcement: warn']]);
    assert.match(stage(dir, ['status'], 's1').stdout, /Enforcement: warn\./);
  });

  test('a save logs the hashes before and after', async () => {
    const log = readFileSync(path.join(storeOf(dir), 'ui', 'ui.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const entry = log.filter((e) => e.event === 'save').pop();
    assert.equal(entry.file, path.join('.shipline', 'workflows', 'feature.yml'));
    assert.equal(entry.hashAfter, sha256(read('.shipline/workflows/feature.yml')));
    assert.match(entry.hashBefore, /^[0-9a-f]{64}$/);
  });

  test('unknown keys survive a save (top level, in a stage, and in config)', async () => {
    const s = await getSetup();
    const f = wfEntry(s, 'hotfix');
    const model = clone(f.model);
    model.owner = 'platform';
    model.stages[0].sla_hours = 4;
    const cfg = clone(s.config.model);
    cfg.team_owner = 'platform';
    cfg.commands.typecheck = 'pnpm tsc';
    const r = await save([
      { kind: 'workflow', id: 'hotfix', model, baseHash: f.hash },
      { kind: 'config', model: cfg, baseHash: s.config.hash },
    ]);
    assert.equal(r.status, 200, r.text);
    // A later save from a fresh load (as the form does: it only edits what it knows) keeps them.
    const s2 = await getSetup();
    const m2 = clone(wfEntry(s2, 'hotfix').model);
    m2.description = 'urgent fix';
    assert.equal((await save([{ kind: 'workflow', id: 'hotfix', model: m2, baseHash: wfEntry(s2, 'hotfix').hash }])).status, 200);
    const s3 = await getSetup();
    assert.equal(wfEntry(s3, 'hotfix').model.owner, 'platform');
    assert.equal(wfEntry(s3, 'hotfix').model.stages[0].sla_hours, 4);
    assert.equal(s3.config.model.team_owner, 'platform');
    assert.equal(s3.config.model.commands.typecheck, 'pnpm tsc');
    assert.match(read('.shipline/config.yml'), /\n {2}typecheck: pnpm tsc\n\n# Optional[^\n]*\nskills: \[\]\n\nteam_owner: platform\n$/);
  });

  test('a file changed on disk gives 409, and in a two-file save nothing is written', async () => {
    const s = await getSetup();
    const cfg = clone(s.config.model);
    cfg.commands.test = 'pnpm test';
    const wf = clone(wfEntry(s, 'bugfix').model);
    wf.name = 'Bug';
    // Someone edits bugfix.yml after the page loaded it.
    const handEdited = read('.shipline/workflows/bugfix.yml') + '# hand edit\n';
    write('.shipline/workflows/bugfix.yml', handEdited);
    const configBefore = read('.shipline/config.yml');
    const r = await save([
      { kind: 'config', model: cfg, baseHash: s.config.hash },
      { kind: 'workflow', id: 'bugfix', model: wf, baseHash: wfEntry(s, 'bugfix').hash },
    ]);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'changed');
    assert.equal(read('.shipline/config.yml'), configBefore);
    assert.equal(read('.shipline/workflows/bugfix.yml'), handEdited);
  });

  test('a changed rules file gives 409 too; an unchanged one saves', async () => {
    const s = await getSetup();
    const plan = s.rules.find((x) => x.id === 'plan');
    const stale = await save([{ kind: 'rules', id: 'plan', text: 'new rules\n', baseHash: sha256('something else') }]);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'changed');
    const ok = await save([{ kind: 'rules', id: 'plan', text: plan.raw + '- One more rule.\n', baseHash: plan.hash }]);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(read('.shipline/rules/plan.md'), plan.raw + '- One more rule.\n');
    assert.deepEqual(readdirSync(path.join(dir, '.shipline/rules')).filter((f) => f.includes('.tmp')), []);
  });

  test('baseHash: null for an existing file gives 409 (exists), and nothing in the batch is written', async () => {
    const r = await save([
      { kind: 'rules', id: 'security', text: 'Check auth.\n', baseHash: null },
      { kind: 'rules', id: 'plan', text: 'overwrite\n', baseHash: null },
    ]);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'exists');
    assert.ok(!existsSync(path.join(dir, '.shipline/rules/security.md')));
    assert.notEqual(read('.shipline/rules/plan.md'), 'overwrite\n');
  });

  test('baseHash: null for a new file creates it', async () => {
    const r = await save([{ kind: 'rules', id: 'security', text: 'Check auth.\n', baseHash: null }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(read('.shipline/rules/security.md'), 'Check auth.\n');
    assert.deepEqual(r.json.written, [{ kind: 'rules', id: 'security', hash: sha256('Check auth.\n') }]);
  });

  test('an invalid model sent straight to save gives 400 with the error list', async () => {
    const s = await getSetup();
    const f = wfEntry(s, 'feature');
    const model = clone(f.model);
    model.stages[0].enforcement = 'bogus';
    model.stages[1].id = model.stages[2].id;
    model.stages[3].artifact = '../escape.md';
    const before = read('.shipline/workflows/feature.yml');
    const r = await save([{ kind: 'workflow', id: 'feature', model, baseHash: f.hash }]);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid');
    assert.ok(Array.isArray(r.json.error.details));
    const got = r.json.error.details.map((d) => `${d.kind}:${d.id}:${d.path}`).sort();
    assert.deepEqual(got, ['workflow:feature:stages[0].enforcement', 'workflow:feature:stages[2].id', 'workflow:feature:stages[3].artifact']);
    assert.equal(read('.shipline/workflows/feature.yml'), before);

    const cfgBad = await save([{ kind: 'config', model: { ...s.config.model, branch_pattern: '{key}' }, baseHash: s.config.hash }]);
    assert.equal(cfgBad.status, 400);
    assert.equal(cfgBad.json.error.details[0].path, 'branch_pattern');

    const p = await preview([{ kind: 'workflow', id: 'feature', model, baseHash: f.hash }]);
    assert.equal(p.status, 200);
    assert.equal(p.json.files[0].errors.length, 3);
  });

  test('a model the writer cannot read back gives 400 round-trip', async () => {
    const s = await getSetup();
    const f = wfEntry(s, 'feature');
    const model = clone(f.model);
    model['bad key'] = 1;
    const r = await save([{ kind: 'workflow', id: 'feature', model, baseHash: f.hash }]);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'round-trip');
  });

  test('these targets give 400: a rules id ../x and a workflow id ../../bin/guard', async () => {
    const guard = read('.shipline/bin/guard.mjs');
    const cases = [
      { kind: 'rules', id: '../x', text: 'pwned', baseHash: null },
      { kind: 'rules', id: '../../x', text: 'pwned', baseHash: null },
      { kind: 'workflow', id: '../../bin/guard', model: { id: '../../bin/guard', stages: [{ id: 'a', enforcement: 'guide' }] }, baseHash: null },
      { kind: 'workflow', id: '../bin/guard', model: { id: 'x', stages: [] }, baseHash: sha256(guard) },
      { kind: 'workflow', model: { id: 'x' }, baseHash: null },
      { kind: 'rules', id: 'a.b', text: 'x', baseHash: null },
      { kind: 'file', id: 'x', text: 'x', baseHash: null },
    ];
    for (const entry of cases) {
      for (const send of [save, preview]) {
        const r = await send([entry]);
        assert.equal(r.status, 400, `${JSON.stringify(entry)}: ${r.text}`);
        assert.equal(r.json.error.code, 'bad-target');
      }
    }
    assert.equal(read('.shipline/bin/guard.mjs'), guard);
    assert.ok(!existsSync(path.join(dir, '.shipline/x.md')));
    assert.ok(!existsSync(path.join(dir, 'x.md')));
    assert.ok(!existsSync(path.join(dir, '.shipline/bin/guard.yml')));
  });

  test('a request body over 1 MB gives 413', async () => {
    const r = await save([{ kind: 'rules', id: 'plan', text: 'x'.repeat(1024 * 1024 + 1), baseHash: null }]);
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'too-large');
  });
});

describe('preview', () => {
  test('reports removed comments and marks them in the diff', async () => {
    write(
      '.shipline/workflows/spike.yml',
      '# Spike header (not shipped).\nid: spike\nname: Spike # time-boxed\nstages:\n  - id: explore\n    # Only a reminder.\n    enforcement: guide\n',
    );
    try {
      const s = await getSetup();
      const f = wfEntry(s, 'spike');
      const r = await preview([{ kind: 'workflow', id: 'spike', model: f.model, baseHash: f.hash }]);
      assert.equal(r.status, 200, r.text);
      const out = r.json.files[0];
      assert.deepEqual(out.removedComments.sort(), ['# Only a reminder.', '# Spike header (not shipped).', '# time-boxed'].sort());
      assert.ok(out.text.startsWith(headerFor('spike')));
      const dels = out.diff.flatMap((h) => h.lines).filter((l) => l.type === 'del');
      assert.ok(dels.some((l) => l.text === '    # Only a reminder.' && l.comment === true));
      const tmp = path.join(storeOf(dir), 'ui', 'tmp');
      assert.ok(!existsSync(tmp) || readdirSync(tmp).length === 0);
      assert.ok(!existsSync(path.join(dir, '.shipline/.state')));
    } finally {
      rmSync(path.join(dir, '.shipline/workflows/spike.yml'));
    }
  });

  test('a team comment in config.yml is shown as removed', async () => {
    const cfgText = read('.shipline/config.yml');
    write('.shipline/config.yml', cfgText.replace('tracker: jira', 'tracker: jira # cloud instance'));
    try {
      const s = await getSetup();
      const r = await preview([{ kind: 'config', model: s.config.model, baseHash: s.config.hash }]);
      assert.deepEqual(r.json.files[0].removedComments, ['# cloud instance']);
    } finally {
      write('.shipline/config.yml', cfgText);
    }
  });

  describe('open-task impact', () => {
    // s1 has an open feature task (started above); add an open bugfix task, which must never be listed.
    before(() => {
      assert.equal(stage(dir, ['start', '--workflow', 'bugfix', '--title', 'Fix crash'], 's2').code, 0);
    });
    const featurePreview = async (edit) => {
      const s = await getSetup();
      const f = wfEntry(s, 'feature');
      const model = clone(f.model);
      edit(model);
      const r = await preview([{ kind: 'workflow', id: 'feature', model, baseHash: f.hash }]);
      assert.equal(r.status, 200, r.text);
      return r.json;
    };
    const taskDir = path.join(storeOf(dir), 'tasks', 'add-export');

    test('adding a stage', async () => {
      const p = await featurePreview((m) => m.stages.splice(4, 0, { id: 'security', name: 'Security', enforcement: 'guide' }));
      assert.deepEqual(p.impact.map(({ task, added, removed, reordered }) => ({ task, added, removed, reordered })), [
        { task: taskDir, added: ['security'], removed: [], reordered: false },
      ]);
    });

    test('removing a stage (and its rules file stays)', async () => {
      const p = await featurePreview((m) => (m.stages = m.stages.filter((s) => s.id !== 'wireframes')));
      assert.deepEqual(p.impact.map(({ task, added, removed, reordered }) => ({ task, added, removed, reordered })), [
        { task: taskDir, added: [], removed: ['wireframes'], reordered: false },
      ]);
      assert.ok(p.files[0].notes.some((n) => n.includes('.shipline/rules/wireframes.md')));
    });

    test('reordering stages', async () => {
      const p = await featurePreview((m) => {
        const [a, b] = [m.stages[1], m.stages[2]];
        m.stages[1] = b;
        m.stages[2] = a;
      });
      assert.deepEqual(p.impact.map(({ task, added, removed, reordered }) => ({ task, added, removed, reordered })), [
        { task: taskDir, added: [], removed: [], reordered: true },
      ]);
    });

    test('a settings-only change has no impact', async () => {
      const p = await featurePreview((m) => {
        m.stages[3].enforcement = 'warn';
        m.stages[3].confirm_to_advance = false;
      });
      assert.deepEqual(p.impact, []);
    });
  });
});

describe('workflow copy and delete', () => {
  test('copying feature to review writes workflows/review.yml with id: review; start records workflow: review', async () => {
    const r = await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'copy', from: 'feature', id: 'review' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true });
    const text = read('.shipline/workflows/review.yml');
    assert.match(text, /^id: review$/m);
    assert.ok(text.startsWith(headerFor('feature')));
    // The copy keeps the source's quoting.
    assert.match(text, /tools: 'Edit\|Write\|MultiEdit\|NotebookEdit'/);
    const st = stage(dir, ['start', '--workflow', 'review', '--title', 'Review me'], 'r1');
    assert.equal(st.code, 0, st.stderr);
    const m = JSON.parse(readFileSync(path.join(storeOf(dir), 'tasks', 'review-me', 'manifest.json'), 'utf8'));
    assert.equal(m.task.workflow, 'review');
  });

  test('copying onto an existing id gives 409 (exists)', async () => {
    const before = read('.shipline/workflows/bugfix.yml');
    const r = await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'copy', from: 'feature', id: 'bugfix' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'exists');
    assert.equal(read('.shipline/workflows/bugfix.yml'), before);
  });

  test('bad ids give 400 (bad-target)', async () => {
    for (const body of [
      { action: 'copy', from: 'feature', id: '../../bin/guard' },
      { action: 'copy', from: '../config', id: 'x' },
      { action: 'copy', from: 'nope', id: 'x' },
      { action: 'delete', id: '../rules/plan' },
      { action: 'rename', id: 'feature' },
    ]) {
      const r = await api(ui, 'POST', '/api/setup/workflows', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, 'bad-target');
    }
  });

  test('a workflow used by an open task cannot be deleted (409 in-use)', async () => {
    const r = await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'delete', id: 'review' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'in-use');
    assert.ok(existsSync(path.join(dir, '.shipline/workflows/review.yml')));
  });

  test('an unused workflow is deleted and its rules files stay', async () => {
    assert.equal((await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'copy', from: 'hotfix', id: 'temp' } })).status, 200);
    const r = await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'delete', id: 'temp' } });
    assert.equal(r.status, 200, r.text);
    assert.ok(!existsSync(path.join(dir, '.shipline/workflows/temp.yml')));
    assert.ok(existsSync(path.join(dir, '.shipline/rules/fix.md')));
  });
});

describe('workflow create (prepublish plan, "+ New workflow")', () => {
  test('creates workflows/<id>.yml with one implement stage; stage.mjs can start it', async () => {
    const r = await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'create', id: 'spike', name: '  Spike  ' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true });
    try {
      const text = read('.shipline/workflows/spike.yml');
      assert.ok(text.startsWith(headerFor('spike')));
      const s = await getSetup();
      assert.deepEqual(wfEntry(s, 'spike').model, {
        id: 'spike',
        name: 'Spike',
        stages: [{ id: 'implement', name: 'Implement', enforcement: 'guide', confirm_to_advance: false }],
      });
      assert.deepEqual(wfEntry(s, 'spike').errors ?? [], []);
      assert.match(stage(dir, ['workflows']).stdout, /^spike: Spike/m);
    } finally {
      rmSync(path.join(dir, '.shipline/workflows/spike.yml'), { force: true });
    }
  });

  test('an id that exists gives 409 exists and leaves the file alone', async () => {
    const before = read('.shipline/workflows/feature.yml');
    const r = await api(ui, 'POST', '/api/setup/workflows', { body: { action: 'create', id: 'feature', name: 'Feature 2' } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'exists');
    assert.equal(read('.shipline/workflows/feature.yml'), before);
  });

  test('a bad id or a missing name gives 400 invalid, and nothing is written', async () => {
    const before = readdirSync(path.join(dir, '.shipline/workflows')).sort();
    for (const body of [
      { action: 'create', id: '../evil', name: 'Evil' },
      { action: 'create', id: 'a b', name: 'Space' },
      { action: 'create', id: '', name: 'Empty' },
      { action: 'create', name: 'No id' },
      { action: 'create', id: 'noname' },
      { action: 'create', id: 'blank', name: '   ' },
    ]) {
      const r = await api(ui, 'POST', '/api/setup/workflows', { body });
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      assert.equal(r.json.error.code, 'invalid', JSON.stringify(body));
    }
    assert.deepEqual(readdirSync(path.join(dir, '.shipline/workflows')).sort(), before);
    assert.ok(!existsSync(path.join(dir, '.shipline/evil.yml')));
  });
});

describe('agents and skills (prepublish plan, Setup -> Agents & skills)', () => {
  const AGENT = (n) => `.claude/agents/${n}.md`;
  const template = (n) => readFileSync(path.join(CLI_ROOT, 'templates', 'claude', 'agents', `${n}.md`), 'utf8');
  const agentsPost = (x, body, { preview = false } = {}) => api(x.ui, 'POST', `/api/setup/agents${preview ? '?preview=1' : ''}`, { body });
  const versionOf = (x) => JSON.parse(readFileSync(path.join(x.dir, '.shipline/bin/VERSION'), 'utf8'));
  const xread = (x, rel) => readFileSync(path.join(x.dir, rel), 'utf8');
  const xexists = (x, rel) => existsSync(path.join(x.dir, rel));
  // The base hashes the page would send: the agent file hashes from GET /api/setup (null = must not exist).
  async function bases(x, names) {
    const s = await getSetup(x.ui);
    const baseHashes = {};
    for (const n of names) baseHashes[AGENT(n)] = s.agents.shipline.find((a) => a.name === n).hash;
    return { baseHashes, baseVersionHash: s.versionHash };
  }

  // A repo whose team had its own planner.md before `init --yes` (a "keep yours" clash), plus its own agent and skill.
  async function teamRepo() {
    const d = makeRepo({ init: false });
    mkdirSync(path.join(d, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(d, AGENT('planner')), '# Our planner\n');
    writeFileSync(path.join(d, AGENT('mine')), '# Our own agent\n');
    mkdirSync(path.join(d, '.claude/skills/deploy'), { recursive: true });
    writeFileSync(path.join(d, '.claude/skills/deploy/SKILL.md'), '# Deploy\n');
    const r = runInit(d);
    assert.equal(r.code, 0, r.stderr);
    const u = await startUi(d);
    extra.push({ dir: d, ui: u });
    return { dir: d, ui: u };
  }

  test('GET /api/setup: a kept clash is excluded, agents.repo lists only non-Shipline names, skills.repo skips shipline-*', async () => {
    const x = await teamRepo();
    const s = await getSetup(x.ui);
    assert.deepEqual(s.agents.shipline.find((a) => a.name === 'planner'), { name: 'planner', installed: true, excluded: true, hash: sha256('# Our planner\n') });
    assert.deepEqual(s.agents.repo, ['mine']);
    assert.deepEqual(s.skills, { repo: ['deploy'], selected: [] });
  });

  test('skills saved through POST /api/setup/save: a missing skill folder is a warning, not an error', async () => {
    const x = await teamRepo();
    const s = await getSetup(x.ui);
    const model = clone(s.config.model);
    model.skills = ['deploy', 'gone'];
    const p = await preview([{ kind: 'config', model, baseHash: s.config.hash }], x.ui);
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.files[0].errors, []);
    const r = await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui);
    assert.equal(r.status, 200, r.text);
    assert.match(xread(x, '.shipline/config.yml'), /^skills: \[deploy, gone\]$/m);
    assert.deepEqual((await getSetup(x.ui)).skills, { repo: ['deploy'], selected: ['deploy', 'gone'] });
    const bad = clone(model);
    bad.skills = ['../x'];
    const r2 = await save([{ kind: 'config', model: bad, baseHash: (await getSetup(x.ui)).config.hash }], x.ui);
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error.details[0].path, 'skills[0]');
  });

  test('preview of a removal: text null, every line deleted, the stages that use it, VERSION before/after; nothing written', async () => {
    const x = await scratchRepo();
    const before = snapshot(x.dir);
    const agentBefore = xread(x, AGENT('researcher'));
    const p = await agentsPost(x, { remove: ['researcher'] }, { preview: true });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.files.length, 1);
    const f = p.json.files[0];
    assert.equal(f.kind, 'agent');
    assert.equal(f.id, 'researcher');
    assert.equal(f.text, null);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.removedComments, []);
    const lines = f.diff.flatMap((h) => h.lines);
    assert.ok(lines.length > 0 && lines.every((l) => l.type === 'del'), JSON.stringify(lines.slice(0, 3)));
    assert.ok(f.notes.some((n) => n.includes('agent not installed') && n.includes('bugfix.root_cause') && n.includes('feature.feasibility')), JSON.stringify(f.notes));
    assert.deepEqual(p.json.version.before.excluded, []);
    assert.deepEqual(p.json.version.after.excluded, [AGENT('researcher')]);
    assert.ok(AGENT('researcher') in p.json.version.before.files);
    assert.ok(!(AGENT('researcher') in p.json.version.after.files));
    assert.deepEqual(snapshot(x.dir), before);
    assert.equal(xread(x, AGENT('researcher')), agentBefore);
  });

  test('apply remove, then add back: files and VERSION (files, excluded) follow, VERSION last', async () => {
    const x = await scratchRepo();
    const r = await agentsPost(x, { remove: ['researcher', 'reviewer'], ...(await bases(x, ['researcher', 'reviewer'])) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, {
      written: [
        { kind: 'agent', id: 'researcher', action: 'delete' },
        { kind: 'agent', id: 'reviewer', action: 'delete' },
      ],
    });
    assert.ok(!xexists(x, AGENT('researcher')));
    assert.ok(!xexists(x, AGENT('reviewer')));
    let v = versionOf(x);
    assert.deepEqual(v.excluded, [AGENT('researcher'), AGENT('reviewer')]);
    assert.ok(!(AGENT('researcher') in v.files));
    assert.equal(v.interface, 3);
    let s = await getSetup(x.ui);
    assert.deepEqual(s.agents.shipline.find((a) => a.name === 'researcher'), { name: 'researcher', installed: false, excluded: true, hash: null });
    assert.equal(s.versionHash, sha256(xread(x, '.shipline/bin/VERSION')));
    // A stage that uses the removed agent now gets the existing "unknown agent" warning, not an error.
    const feature = wfEntry(s, 'feature');
    const p = await preview([{ kind: 'workflow', id: 'feature', model: feature.model, baseHash: feature.hash }], x.ui);
    assert.deepEqual(p.json.files[0].errors, []);

    // Add researcher back (baseHashes null: the file must not exist).
    const add = await agentsPost(x, { add: ['researcher'], ...(await bases(x, ['researcher'])) });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(add.json, { written: [{ kind: 'agent', id: 'researcher', action: 'write' }] });
    assert.equal(xread(x, AGENT('researcher')), template('researcher'));
    v = versionOf(x);
    assert.deepEqual(v.excluded, [AGENT('reviewer')]);
    assert.equal(v.files[AGENT('researcher')], sha256(template('researcher')));
    s = await getSetup(x.ui);
    assert.deepEqual(s.agents.shipline.find((a) => a.name === 'researcher'), { name: 'researcher', installed: true, excluded: false, hash: sha256(template('researcher')) });
    // upgrade's view of it: the reviewer exclusion stays (covered in upgrade.test.mjs); the log has an entry.
    const log = readFileSync(path.join(storeOf(x.dir), 'ui', 'ui.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(log.some((e) => e.event === 'agents' && e.id === 'researcher' && e.action === 'write' && e.hashBefore === null));
  });

  test('adding an agent that is already installed (and not excluded) changes nothing', async () => {
    const x = await scratchRepo();
    const before = snapshot(x.dir);
    const p = await agentsPost(x, { add: ['builder'] }, { preview: true });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.files, []);
    const r = await agentsPost(x, { add: ['builder'], ...(await bases(x, [])) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.written, []);
    // VERSION may be rewritten (keys sorted, as upgrade writes them), but its content is the same.
    const { ['.shipline/bin/VERSION']: vBefore, ...restBefore } = before;
    const { ['.shipline/bin/VERSION']: vAfter, ...restAfter } = snapshot(x.dir);
    assert.deepEqual(restAfter, restBefore);
    assert.deepEqual(JSON.parse(vAfter), JSON.parse(vBefore));
  });

  test('every affected path needs a baseHashes entry (400), and nothing is written', async () => {
    const x = await scratchRepo();
    const { baseVersionHash } = await bases(x, []);
    for (const body of [
      { remove: ['researcher'], baseVersionHash, baseHashes: {} },
      { remove: ['researcher'], baseVersionHash },
      { remove: ['researcher'], baseHashes: { [AGENT('researcher')]: sha256(xread(x, AGENT('researcher'))) } },
    ]) {
      const r = await agentsPost(x, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
    }
    assert.ok(xexists(x, AGENT('researcher')));
    assert.deepEqual(versionOf(x).excluded, []);
  });

  test('409 changed: a stale VERSION hash or a changed agent file, with the paths; nothing is written', async () => {
    const x = await scratchRepo();
    const b = await bases(x, ['researcher', 'builder']);
    // Someone edits builder.md and VERSION after the page loaded.
    writeFileSync(path.join(x.dir, AGENT('builder')), xread(x, AGENT('builder')) + '\nhand edit\n');
    const v = versionOf(x);
    v.note = 'touched';
    writeFileSync(path.join(x.dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const before = snapshot(x.dir);
    const researcher = xread(x, AGENT('researcher'));
    const builder = xread(x, AGENT('builder'));
    const r = await agentsPost(x, { remove: ['researcher', 'builder'], ...b });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'changed');
    assert.deepEqual(r.json.error.details.paths.sort(), ['.claude/agents/builder.md', '.shipline/bin/VERSION']);
    assert.deepEqual(snapshot(x.dir), before);
    assert.equal(xread(x, AGENT('researcher')), researcher);
    assert.equal(xread(x, AGENT('builder')), builder);
    // A file that appeared where null ("must not exist") was sent is a change too.
    const y = await scratchRepo();
    await agentsPost(y, { remove: ['researcher'], ...(await bases(y, ['researcher'])) });
    const nb = await bases(y, ['researcher']);
    assert.equal(nb.baseHashes[AGENT('researcher')], null);
    writeFileSync(path.join(y.dir, AGENT('researcher')), '# appeared\n');
    const r2 = await agentsPost(y, { add: ['researcher'], ...nb });
    assert.equal(r2.status, 409, r2.text);
    assert.deepEqual(r2.json.error.details.paths, ['.claude/agents/researcher.md']);
    assert.equal(xread(y, AGENT('researcher')), '# appeared\n');
  });

  test('remove on the team\'s own (kept) agent is 400 not-shipline and leaves the file', async () => {
    const x = await teamRepo();
    const before = snapshot(x.dir);
    for (const preview of [true, false]) {
      const r = await agentsPost(x, { remove: ['planner'], ...(await bases(x, ['planner'])) }, { preview });
      assert.equal(r.status, 400, r.text);
      assert.equal(r.json.error.code, 'not-shipline');
      assert.equal(r.json.error.details.path, '.claude/agents/planner.md');
    }
    assert.equal(xread(x, AGENT('planner')), '# Our planner\n');
    assert.deepEqual(snapshot(x.dir), before);
  });

  test('add on the team\'s own agent: the preview is a normal diff; apply replaces the file and moves the path from excluded to files', async () => {
    const x = await teamRepo();
    assert.deepEqual(versionOf(x).excluded, [AGENT('planner')]);
    const p = await agentsPost(x, { add: ['planner'] }, { preview: true });
    assert.equal(p.status, 200, p.text);
    const f = p.json.files[0];
    assert.equal(f.id, 'planner');
    assert.equal(f.text, template('planner'));
    const lines = f.diff.flatMap((h) => h.lines);
    assert.ok(lines.some((l) => l.type === 'del' && l.text === '# Our planner'));
    assert.ok(lines.some((l) => l.type === 'add'));
    const r = await agentsPost(x, { add: ['planner'], ...(await bases(x, ['planner'])) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.written, [{ kind: 'agent', id: 'planner', action: 'write' }]);
    assert.equal(xread(x, AGENT('planner')), template('planner'));
    const v = versionOf(x);
    assert.deepEqual(v.excluded, []);
    assert.equal(v.files[AGENT('planner')], sha256(template('planner')));
    assert.equal(xread(x, AGENT('mine')), '# Our own agent\n', 'the team\'s other agent is untouched');
  });

  test('bad requests give 400: unknown names, nothing to do, the same name in add and remove', async () => {
    const x = await scratchRepo();
    const b = await bases(x, ['builder']);
    const cases = [
      [{ add: ['ghost'], ...b }, 'bad-target'],
      [{ remove: ['../../.shipline/bin/guard'], ...b }, 'bad-target'],
      [{ remove: ['mine'], ...b }, 'bad-target'],
      [{ add: 'builder', ...b }, null],
      [{ ...b }, null],
      [{ add: ['builder'], remove: ['builder'], ...b }, null],
    ];
    for (const [body, code] of cases) {
      const r = await agentsPost(x, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      if (code) assert.equal(r.json.error.code, code, JSON.stringify(body));
    }
    assert.ok(xexists(x, '.shipline/bin/guard.mjs'));
  });

  test('a "repo newer" VERSION refuses it with 423', async () => {
    const x = await scratchRepo((d) => writeFileSync(path.join(d, '.shipline/bin/VERSION'), '{"package":"9.9.9","interface":99}\n'));
    const r = await agentsPost(x, { remove: ['researcher'], baseVersionHash: 'x', baseHashes: {} });
    assert.equal(r.status, 423, r.text);
    assert.equal(r.json.error.code, 'repo-newer');
    assert.ok(xexists(x, AGENT('researcher')));
  });
});

describe('interchangeability', () => {
  test('a hand edit, then a UI save, then a hand edit loses no fields', async () => {
    // 1. Hand edit, as /shipline-setup would make it.
    let text = read('.shipline/workflows/bugfix.yml');
    text = text
      .replace('description: something is broken and needs fixing', "description: something is broken and needs fixing\nowner: 'qa-team'")
      .replace('    name: Reproduce\n', '    name: Reproduce\n    timeout_min: 30\n');
    write('.shipline/workflows/bugfix.yml', text);
    // 2. UI save of another field.
    const s = await getSetup();
    const f = wfEntry(s, 'bugfix');
    const model = clone(f.model);
    model.name = 'Bugfix (team)';
    const r = await save([{ kind: 'workflow', id: 'bugfix', model, baseHash: f.hash }]);
    assert.equal(r.status, 200, r.text);
    const saved = read('.shipline/workflows/bugfix.yml');
    assert.match(saved, /^owner: 'qa-team'$/m, 'the hand-written quoting is kept');
    assert.match(saved, /^ {4}timeout_min: 30$/m);
    // 3. Another hand edit.
    write('.shipline/workflows/bugfix.yml', saved.replace('stages:\n', 'labels: [bug, triage]\nstages:\n'));
    const s2 = await getSetup();
    const m = wfEntry(s2, 'bugfix').model;
    assert.equal(m.name, 'Bugfix (team)');
    assert.equal(m.owner, 'qa-team');
    assert.deepEqual(m.labels, ['bug', 'triage']);
    assert.equal(m.stages.find((x) => x.id === 'reproduce').timeout_min, 30);
    assert.deepEqual(m.stages.map((x) => x.id), ['jira', 'reproduce', 'root_cause', 'fix', 'verify', 'pr']);
    assert.equal(m.stages.find((x) => x.id === 'verify').blocks[0].bash, '\\bgit\\s+commit\\b|\\bgh\\s+pr\\s+create\\b');
    // The hooks still read it.
    assert.match(stage(dir, ['workflows']).stdout, /^bugfix: Bugfix \(team\)/m);
  });
});

describe('version contract', () => {
  test('a "repo newer" VERSION refuses the save; Tasks still works', async () => {
    const x = await scratchRepo((d) => writeFileSync(path.join(d, '.shipline/bin/VERSION'), '{"package":"9.9.9","interface":99}\n'));
    const status = await api(x.ui, 'GET', '/api/status');
    assert.equal(status.json.versionState, 'repo-newer');
    const s = await getSetup(x.ui);
    const before = snapshot(x.dir);
    const model = clone(s.config.model);
    model.commands.test = 'pnpm test';
    const r = await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui);
    assert.equal(r.status, 423);
    assert.equal(r.json.error.code, 'repo-newer');
    assert.match(r.json.error.message, /npx @forgeyard\/shipline@9\.9\.9 ui/);
    const copy = await api(x.ui, 'POST', '/api/setup/workflows', { body: { action: 'copy', from: 'feature', id: 'review' } });
    assert.equal(copy.status, 423);
    assert.deepEqual(snapshot(x.dir), before);
    assert.equal((await api(x.ui, 'GET', '/api/tasks')).status, 200);
    const ev = await openEvents(x.ui);
    try {
      const b = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'version', 2000);
      assert.equal(b.data.text, 'This repo was set up with Shipline 9.9.9. Run `npx @forgeyard/shipline@9.9.9 ui`.');
    } finally {
      ev.close();
    }
  });

  test('a repo with no VERSION is "repo older": a banner, and saving still works', async () => {
    const x = await scratchRepo((d) => rmSync(path.join(d, '.shipline/bin/VERSION')));
    const status = await api(x.ui, 'GET', '/api/status');
    assert.equal(status.json.versionState, 'repo-older');
    assert.deepEqual(status.json.repoVersion, { legacy: true, interface: 1 });
    assert.equal(status.json.needsUpgrade, true);
    const ev = await openEvents(x.ui);
    try {
      const b = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'version', 2000);
      assert.equal(b.data.text, 'Task data is still stored in this repo. Run `npx @forgeyard/shipline upgrade` to move it to ~/.shipline.');
    } finally {
      ev.close();
    }
    const s = await getSetup(x.ui);
    const model = clone(s.config.model);
    model.commands.test = 'pnpm test';
    assert.equal((await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui)).status, 200);
  });

  test('an interface-2 repo: the upgrade banner, and saving config.yml keeps artifact_root and folder_pattern as unknown keys', async () => {
    const x = await scratchRepo((d) => {
      writeFileSync(path.join(d, '.shipline/bin/VERSION'), '{"package":"0.6.0","interface":2}\n');
      const cfg = readFileSync(path.join(d, '.shipline/config.yml'), 'utf8');
      writeFileSync(path.join(d, '.shipline/config.yml'), `artifact_root: work/tasks\nfolder_pattern: "{slug}"\n${cfg}`);
    });
    const status = await api(x.ui, 'GET', '/api/status');
    assert.equal(status.json.versionState, 'repo-older');
    assert.equal(status.json.needsUpgrade, true);
    const ev = await openEvents(x.ui);
    try {
      const b = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'version', 2000);
      assert.match(b.data.text, /Task data is still stored in this repo\. Run `npx @forgeyard\/shipline upgrade`/);
    } finally {
      ev.close();
    }
    const s = await getSetup(x.ui);
    assert.equal(s.config.model.artifact_root, 'work/tasks');
    const model = clone(s.config.model);
    model.commands.test = 'pnpm test';
    const r = await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui);
    assert.equal(r.status, 200, r.text);
    const saved = readFileSync(path.join(x.dir, '.shipline/config.yml'), 'utf8');
    assert.match(saved, /^artifact_root: work\/tasks$/m);
    assert.match(saved, /^folder_pattern: "\{slug\}"$/m);
    assert.match(saved, /^ {2}test: pnpm test$/m);
  });
});

describe('config.yml', () => {
  test("with a config.yml that doesn't parse, the server still starts and /api/tasks returns configError", async () => {
    const x = await scratchRepo((d) => writeFileSync(path.join(d, '.shipline/config.yml'), 'artifact_root: docs\n   bad: indent\n'));
    const t = await api(x.ui, 'GET', '/api/tasks');
    assert.equal(t.status, 200);
    assert.deepEqual(t.json.tasks, []);
    assert.match(t.json.configError, /unexpected indentation/);
    const s = await getSetup(x.ui);
    assert.match(s.config.parseError, /unexpected indentation/);
    assert.equal(s.config.model, undefined);
  });

  test('an interface-3 repo always scans the store: an artifact_root saved into config.yml changes nothing', async () => {
    const x = await scratchRepo();
    const tasks = path.join(storeOf(x.dir), 'tasks');
    assert.equal(stage(x.dir, ['start', '--workflow', 'feature', '--title', 'Old place'], 'a').code, 0);
    let t = await api(x.ui, 'GET', '/api/tasks');
    assert.deepEqual(t.json.tasks.map((k) => k.dir), [path.join(tasks, 'old-place')]);
    const s = await getSetup(x.ui);
    const model = clone(s.config.model);
    model.artifact_root = 'work/tasks';
    const r = await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui);
    assert.equal(r.status, 200, r.text);
    assert.equal(stage(x.dir, ['start', '--workflow', 'bugfix', '--title', 'New place'], 'b').code, 0);
    t = await api(x.ui, 'GET', '/api/tasks');
    assert.deepEqual(t.json.tasks.map((k) => k.dir).sort(), [path.join(tasks, 'new-place'), path.join(tasks, 'old-place')]);
    assert.ok(!existsSync(path.join(x.dir, 'work')));
  });
});
