// Plan item 45, Setup and Interchangeability (Goals 4, 5 and 6): GET /api/setup, preview, save and
// workflow copy/delete against a real server on temporary repos.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo, removeDir, stage } from '../helpers.mjs';
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
    assert.equal(s.config.model.artifact_root, 'docs/shipline');
    assert.deepEqual(s.workflows.map((w) => w.id), ['bugfix', 'feature', 'hotfix']);
    for (const w of s.workflows) {
      assert.equal(w.kind, 'workflow');
      assert.equal(w.hash, sha256(read(`.shipline/workflows/${w.id}.yml`)));
      assert.equal(w.model.id, w.id);
    }
    assert.ok(s.rules.some((r) => r.id === 'plan' && r.kind === 'rules' && r.raw === read('.shipline/rules/plan.md')));
    assert.deepEqual(s.agents, ['builder', 'planner', 'qa-bug-hunter', 'researcher', 'reviewer', 'wireframe-proposer']);
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
    const log = readFileSync(path.join(dir, '.shipline/.state/ui.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
    assert.match(read('.shipline/config.yml'), /\n {2}typecheck: pnpm tsc\n\nteam_owner: platform\n$/);
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

    const cfgBad = await save([{ kind: 'config', model: { ...s.config.model, folder_pattern: '{key}' }, baseHash: s.config.hash }]);
    assert.equal(cfgBad.status, 400);
    assert.equal(cfgBad.json.error.details[0].path, 'folder_pattern');

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
      assert.ok(!existsSync(path.join(dir, '.shipline/.state/ui/tmp')) || readdirSync(path.join(dir, '.shipline/.state/ui/tmp')).length === 0);
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
    const taskDir = 'docs/shipline/add-export';

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
    const m = JSON.parse(read('docs/shipline/review-me/manifest.json'));
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
    assert.match(r.json.error.message, /npx shipline@9\.9\.9 ui/);
    const copy = await api(x.ui, 'POST', '/api/setup/workflows', { body: { action: 'copy', from: 'feature', id: 'review' } });
    assert.equal(copy.status, 423);
    assert.deepEqual(snapshot(x.dir), before);
    assert.equal((await api(x.ui, 'GET', '/api/tasks')).status, 200);
    const ev = await openEvents(x.ui);
    try {
      const b = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'version', 2000);
      assert.equal(b.data.text, 'This repo was set up with Shipline 9.9.9. Run `npx shipline@9.9.9 ui`.');
    } finally {
      ev.close();
    }
  });

  test('a repo with no VERSION is "repo older": a banner, and saving still works', async () => {
    const x = await scratchRepo((d) => rmSync(path.join(d, '.shipline/bin/VERSION')));
    const status = await api(x.ui, 'GET', '/api/status');
    assert.equal(status.json.versionState, 'repo-older');
    assert.deepEqual(status.json.repoVersion, { legacy: true, interface: 1 });
    const ev = await openEvents(x.ui);
    try {
      const b = await ev.waitFor((e) => e.type === 'banner' && e.data.kind === 'version', 2000);
      assert.equal(b.data.text, "This repo's hook scripts are from an older Shipline (interface 1). They don't have: the lost-task warning, visible warn reminders.");
    } finally {
      ev.close();
    }
    const s = await getSetup(x.ui);
    const model = clone(s.config.model);
    model.commands.test = 'pnpm test';
    assert.equal((await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui)).status, 200);
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

  test('after saving a new artifact_root, GET /api/tasks scans the new folder', async () => {
    const x = await scratchRepo();
    assert.equal(stage(x.dir, ['start', '--workflow', 'feature', '--title', 'Old place'], 'a').code, 0);
    let t = await api(x.ui, 'GET', '/api/tasks');
    assert.deepEqual(t.json.tasks.map((k) => k.dir), ['docs/shipline/old-place']);
    const s = await getSetup(x.ui);
    const model = clone(s.config.model);
    model.artifact_root = 'work/tasks';
    const r = await save([{ kind: 'config', model, baseHash: s.config.hash }], x.ui);
    assert.equal(r.status, 200, r.text);
    mkdirSync(path.join(x.dir, 'work'), { recursive: true });
    assert.equal(stage(x.dir, ['start', '--workflow', 'bugfix', '--title', 'New place'], 'b').code, 0);
    t = await api(x.ui, 'GET', '/api/tasks');
    assert.deepEqual(t.json.tasks.map((k) => k.dir), ['work/tasks/new-place']);
  });
});
