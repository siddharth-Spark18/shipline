// Teams Phase 3 (docs/plans/shipline-teams-phase3.md), E: the Verify scope check, extending the stage gate of
// test/stage-gate.test.mjs. `start` records task.base_commit; `check` stores manifest.checks.scope (changed,
// sensitive, outside_plan); `advance` on a `checks: true` stage asks the `scope` question after the failed-checks
// one and before confirm_to_advance; pr-summary shows a Scope line and JSON `scope`. Runs the vendored scripts of
// real temp repos; commands are `"<node>" "<script>"` with absolute paths (sh and cmd.exe alike). Node 18+.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, hook, makeRepo, removeDir, runInit, stage, storeOf, tmpDir } from './helpers.mjs';
import { scopeOf } from '../templates/shipline/bin/lib.mjs';

// plan (its "Files to touch" is optional here) -> verify (checks) -> pr.
const workflow = (id, confirm) => `id: ${id}
name: ${id}
stages:
  - id: plan
    name: Plan
    artifact: plan.md
    sections: [Scope]
    enforcement: guide
  - id: verify
    name: Verify
    artifact: verification.md
    checks: true
    enforcement: guide
    confirm_to_advance: ${confirm}
  - id: pr
    name: PR
    enforcement: guide
`;
const PLAN = '# Plan\n\n## Scope\n\nThe CSV export, nothing else at all.\n\n## Files to touch\n\n- `src/a.js` (modify): add the export\n- src/lib/ (create): helpers\n- docs/*.md: notes\n';
const PLAN_NO_FILES = '# Plan\n\n## Scope\n\nThe CSV export, nothing else.\n';
const VERIFICATION = '# Verification\n\nAll checked by hand.\n';

let dir;
let scripts;
let configText;
let n = 0;
const NODE = `"${process.execPath}"`;
const script = (name) => `${NODE} "${path.join(scripts, name)}"`;
const taskDir = (slug) => path.join(storeOf(dir), 'tasks', slug);
const manifestOf = (slug) => JSON.parse(readFileSync(path.join(taskDir(slug), 'manifest.json'), 'utf8'));
const stageOf = (slug, id) => manifestOf(slug).stages.find((s) => s.id === id);
const sessionState = (session) => JSON.parse(readFileSync(path.join(storeOf(dir), 'state', `${session}.json`), 'utf8'));
const write = (rel, text = 'x\n') => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};
const check = (session) => stage(dir, ['check'], session);
const runId = (slug) => manifestOf(slug).checks.fingerprint.slice(0, 8);
const scopeQ = (slug, sensitive, outside, run) => `Finish "verify" in task ${slug}? This change edits ${sensitive} test/lint/CI files and ${outside} files outside the plan (run ${run}).`;
const acceptQ = (slug, run) => `Finish "verify" in task ${slug} with failed checks: lint (run ${run})?`;
const advanceQ = (slug) => `Advance past "verify" in task ${slug}?`;
const SCOPE_OPTIONS = '"Finish anyway" and "Not yet"';

// Sets config.yml's commands and (optionally) scope_check; everything else as installed.
function setConfig(cmds, scopeCheck) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const block = ['test', 'lint', 'build'].map((k) => `  ${k}: ${cmds[k] === undefined ? '""' : q(cmds[k])}`).join('\n');
  let text = configText.replace(/\ncommands:\n(?: {2}[^\n]*\n)*/, `\ncommands:\n${block}\n`);
  if (scopeCheck !== undefined) {
    const re = /\nscope_check:\n(?: {2}[^\n]*\n)*/;
    assert.match(text, re);
    text = text.replace(re, `\nscope_check:\n${scopeCheck}\n`);
  }
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), text);
}
const PASSING = () => ({ test: script('pass.js') });
const LINT_FAILS = () => ({ test: script('pass.js'), lint: script('fail3.js') });

// The developer's answer to the pending question (the PostToolUse hook input for AskUserQuestion).
function answer(session, question, label) {
  const r = hook(dir, 'record-answer.mjs', {
    session_id: session,
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: `toolu_${session}_${Date.now()}`,
    tool_input: { questions: [{ question, header: 'Shipline', options: [{ label }], multiSelect: false }] },
    tool_response: { answers: { [question]: label } },
  });
  assert.equal(r.code, 0, r.stderr);
}
function asks(session, question, options) {
  const r = stage(dir, ['advance'], session);
  assert.equal(r.code, 1, r.stdout);
  assert.ok(r.stderr.includes(`  question: ${question}\n`), r.stderr);
  assert.ok(r.stderr.includes(`  options: ${options}\n`), r.stderr);
  return r;
}

// A task at its verify stage. Returns { session, slug }.
function atVerify({ wf = 'scope', plan = PLAN } = {}) {
  const i = ++n;
  const session = `scope-s${i}`;
  const slug = `scope-task-${i}`;
  const r = stage(dir, ['start', '--workflow', wf, '--title', slug], session);
  assert.equal(r.code, 0, r.stderr);
  writeFileSync(path.join(taskDir(slug), 'plan.md'), plan);
  const a = stage(dir, ['advance'], session);
  assert.equal(a.code, 0, a.stderr);
  writeFileSync(path.join(taskDir(slug), 'verification.md'), VERIFICATION);
  return { session, slug };
}

// Removes what a test wrote into the repo (tracked files back to HEAD, untracked ones deleted; .shipline kept).
function cleanRepo() {
  rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); // ignored, so git clean keeps it
  git(dir, 'checkout', '-q', '--', 'src');
  git(dir, 'clean', '-fdq', '-e', '.shipline');
}

before(() => {
  dir = makeRepo({ commitInit: true });
  scripts = tmpDir('shipline-scope-scripts-');
  writeFileSync(path.join(scripts, 'pass.js'), "console.log('ok');\n");
  writeFileSync(path.join(scripts, 'fail3.js'), "console.log('lint error');\nprocess.exit(3);\n");
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'scope.yml'), workflow('scope', false));
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'scopeconfirm.yml'), workflow('scopeconfirm', true));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'scope workflows');
  configText = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
});
after(() => {
  removeDir(dir);
  removeDir(scripts);
});

describe('base_commit', () => {
  test('start records git rev-parse HEAD; resume does not change it', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    const head = git(dir, 'rev-parse', 'HEAD');
    assert.equal(manifestOf(slug).task.base_commit, head);
    write('src/later.js');
    git(dir, 'add', 'src/later.js');
    git(dir, 'commit', '-q', '-m', 'later');
    try {
      assert.equal(stage(dir, ['resume', slug], session).code, 0);
      assert.equal(manifestOf(slug).task.base_commit, head);
    } finally {
      git(dir, 'reset', '-q', '--hard', head);
    }
  });
});

describe('stage.mjs check: the scope', () => {
  test('changed covers committed, uncommitted and untracked files; sensitive and outside_plan are listed', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    const base = manifestOf(slug).task.base_commit;
    try {
      write('src/committed.js');
      git(dir, 'add', 'src/committed.js');
      git(dir, 'commit', '-q', '-m', 'committed after start');
      write('src/a.js', 'export const a = 2;\n'); // in the plan, uncommitted
      write('src/lib/util.js'); // in the plan (a folder entry), untracked
      write('docs/notes.md'); // in the plan (a glob)
      write('test/a.test.js'); // test
      write('src/b.spec.ts'); // test
      write('.eslintrc.json', '{}\n'); // lint
      write('.github/workflows/ci.yml'); // CI
      write('pnpm-lock.yaml'); // lockfile: never outside the plan
      write('.claude/agents/mine.md'); // .claude/: never outside the plan
      write('node_modules/x/index.js'); // ignored by git: not changed at all
      write('.gitignore', 'node_modules/\n');
      const r = check(session);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const sc = manifestOf(slug).checks.scope;
      assert.deepEqual(sc.changed, [
        '.claude/agents/mine.md',
        '.eslintrc.json',
        '.github/workflows/ci.yml',
        '.gitignore',
        '.shipline/config.yml', // setConfig: changed, but never outside the plan
        'docs/notes.md',
        'pnpm-lock.yaml',
        'src/a.js',
        'src/b.spec.ts',
        'src/committed.js',
        'src/lib/util.js',
        'test/a.test.js',
      ]);
      assert.deepEqual(sc.sensitive, ['.eslintrc.json', '.github/workflows/ci.yml', 'src/b.spec.ts', 'test/a.test.js']);
      assert.deepEqual(sc.outside_plan, ['.eslintrc.json', '.github/workflows/ci.yml', '.gitignore', 'src/b.spec.ts', 'src/committed.js', 'test/a.test.js']);
      assert.match(r.stdout, /^Scope: 1 lint config file, 1 CI config file, 2 test files, 6 files outside the plan$/m);
      assert.match(r.stdout, /^ {2}Test, lint and CI files edited:\n {4}\.eslintrc\.json\n {4}\.github\/workflows\/ci\.yml\n {4}src\/b\.spec\.ts\n {4}test\/a\.test\.js$/m);
      assert.match(r.stdout, /^ {2}Files outside the plan's "Files to touch":\n {4}\.eslintrc\.json\n/m);
    } finally {
      git(dir, 'reset', '-q', '--hard', base);
      cleanRepo();
    }
  });

  test('more sensitive kinds: Go and Python tests, __tests__, lint configs, sensitive_extra', () => {
    setConfig(PASSING(), "  enabled: true\n  sensitive_extra: ['config/**']");
    const { session, slug } = atVerify();
    try {
      for (const f of ['pkg/x_test.go', 'app/test_views.py', 'app/views_test.py', 'web/__tests__/a.js', 'tests/e2e/b.py', 'eslint.config.mjs', 'pyproject/ruff.toml', '.prettierrc', 'config/app.yml', 'src/lib/ok.js']) write(f);
      assert.equal(check(session).code, 0);
      const sc = manifestOf(slug).checks.scope;
      assert.deepEqual(sc.sensitive, ['.prettierrc', 'app/test_views.py', 'app/views_test.py', 'config/app.yml', 'eslint.config.mjs', 'pkg/x_test.go', 'pyproject/ruff.toml', 'tests/e2e/b.py', 'web/__tests__/a.js']);
    } finally {
      cleanRepo();
    }
  });

  test('outside_plan is null (unknown, never empty) with no "Files to touch", and with no plan at all', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify({ plan: PLAN_NO_FILES });
    try {
      write('src/x.js');
      const r = check(session);
      assert.equal(r.code, 0);
      assert.equal(manifestOf(slug).checks.scope.outside_plan, null);
      assert.match(r.stdout, /^Scope: no test, lint or CI files touched \(the plan lists no files, so changes outside it are not checked\)$/m);
      // The small workflow has no plan stage at all.
      const s2 = 'scope-small';
      assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', s2], s2).code, 0);
      assert.equal(check(s2).code, 0);
      assert.equal(manifestOf(s2).checks.scope.outside_plan, null);
      // Nothing to ask either: no sensitive file, outside_plan unknown.
      assert.deepEqual(manifestOf(s2).checks.scope.sensitive, []);
    } finally {
      cleanRepo();
    }
  });

  test('scopeOf: a task from before 0.13.0 (no base_commit) and one with base_commit null are unknown', () => {
    const cfg = { scope_check: { enabled: true, sensitive_extra: [] } };
    assert.deepEqual(scopeOf(dir, { task: {} }, PLAN, cfg), { changed: null, sensitive: [], outside_plan: null, note: 'unknown (task started before 0.13.0)' });
    assert.equal(scopeOf(dir, { task: { base_commit: null } }, PLAN, cfg).changed, null);
    assert.match(scopeOf(dir, { task: { base_commit: '0'.repeat(40) } }, PLAN, cfg).note, /git could not list the changes/);
  });

  test('a task started before 0.13.0: check reports "unknown" and advance asks nothing about scope', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    const mf = path.join(taskDir(slug), 'manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    delete m.task.base_commit;
    writeFileSync(mf, JSON.stringify(m, null, 2));
    try {
      write('test/x.test.js');
      const r = check(session);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^Scope: unknown \(task started before 0\.13\.0\)$/m);
      const a = stage(dir, ['advance'], session);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(stageOf(slug, 'verify').status, 'done');
    } finally {
      cleanRepo();
    }
  });
});

describe('advance: the scope question', () => {
  test('end to end: pending_confirm, the recorded answer, then the stage finishes with scope_accepted', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    try {
      write('test/a.test.js');
      write('src/other.js');
      assert.equal(check(session).code, 0);
      const q = scopeQ(slug, 1, 2, runId(slug)); // the test file is outside the plan too
      const r = asks(session, q, SCOPE_OPTIONS);
      assert.match(r.stderr, /needs the developer to decide whether to finish with edits to test, lint or CI files or files outside the plan/);
      const pend = sessionState(session).pending_confirm;
      assert.equal(pend.kind, 'scope');
      assert.equal(pend.stage, 'verify');
      assert.equal(pend.question, q);
      // status shows the open question as it was issued.
      const st = stage(dir, ['status'], session);
      assert.ok(st.stdout.includes('A confirmation is still open (run `advance` after the developer answers).'), st.stdout);
      assert.ok(st.stdout.includes(q), st.stdout);
      // "Not yet" leaves it open, and says so.
      answer(session, q, 'Not yet');
      assert.match(asks(session, q, SCOPE_OPTIONS).stderr, /they answered "Not yet" last time/);
      // "Finish anyway" lets it through.
      answer(session, q, 'Finish anyway');
      const a = stage(dir, ['advance'], session);
      assert.equal(a.code, 0, a.stderr);
      const verify = stageOf(slug, 'verify');
      assert.equal(verify.status, 'done');
      const { checks } = manifestOf(slug);
      assert.deepEqual(verify.scope_accepted, { fingerprint: checks.fingerprint, ran_at: checks.ran_at });
      assert.equal(sessionState(session).pending_confirm, undefined);
    } finally {
      cleanRepo();
    }
  });

  test('the order: failed commands, then scope, then confirm_to_advance', () => {
    setConfig(LINT_FAILS());
    const { session, slug } = atVerify({ wf: 'scopeconfirm' });
    try {
      write('test/a.test.js');
      assert.equal(check(session).code, 1);
      const run = runId(slug);
      asks(session, acceptQ(slug, run), '"Finish anyway" and "Not yet"');
      answer(session, acceptQ(slug, run), 'Finish anyway');
      const q = scopeQ(slug, 1, 1, run);
      asks(session, q, SCOPE_OPTIONS);
      assert.deepEqual(stageOf(slug, 'verify').accepted.names, ['lint'], 'the accept answer survives the scope question');
      answer(session, q, 'Finish anyway');
      asks(session, advanceQ(slug), '"Advance" and "Not yet"');
      assert.ok(stageOf(slug, 'verify').scope_accepted, 'the scope answer survives the advance question');
      answer(session, advanceQ(slug), 'Advance');
      const a = stage(dir, ['advance'], session);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(stageOf(slug, 'verify').status, 'done');
    } finally {
      cleanRepo();
    }
  });

  test('nothing sensitive and nothing outside the plan: no scope question', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    try {
      write('src/a.js', 'export const a = 3;\n');
      assert.equal(check(session).code, 0);
      const a = stage(dir, ['advance'], session);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(stageOf(slug, 'verify').scope_accepted, undefined);
    } finally {
      cleanRepo();
    }
  });

  test('the acceptance is voided by a new check run', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify({ wf: 'scopeconfirm' });
    try {
      write('test/a.test.js');
      assert.equal(check(session).code, 0);
      const q1 = scopeQ(slug, 1, 1, runId(slug));
      asks(session, q1, SCOPE_OPTIONS);
      answer(session, q1, 'Finish anyway');
      // The scope is accepted (stored), then the advance question stops the stage.
      asks(session, advanceQ(slug), '"Advance" and "Not yet"');
      assert.ok(stageOf(slug, 'verify').scope_accepted);
      // A new run (the code changed) needs a new answer.
      write('test/b.test.js');
      assert.equal(check(session).code, 0);
      const q2 = scopeQ(slug, 2, 2, runId(slug));
      assert.notEqual(q2, q1);
      asks(session, q2, SCOPE_OPTIONS);
    } finally {
      cleanRepo();
    }
  });

  test('reopen clears scope_accepted', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    try {
      write('test/a.test.js');
      assert.equal(check(session).code, 0);
      const q = scopeQ(slug, 1, 1, runId(slug));
      asks(session, q, SCOPE_OPTIONS);
      answer(session, q, 'Finish anyway');
      assert.equal(stage(dir, ['advance'], session).code, 0);
      assert.ok(stageOf(slug, 'verify').scope_accepted);
      assert.equal(stage(dir, ['reopen', 'verify'], session).code, 0);
      assert.equal(stageOf(slug, 'verify').scope_accepted, undefined);
    } finally {
      cleanRepo();
    }
  });

  test('scope_check.enabled: false computes nothing and asks nothing', () => {
    setConfig(PASSING(), '  enabled: false\n  sensitive_extra: []');
    const { session, slug } = atVerify();
    try {
      write('test/a.test.js');
      write('src/other.js');
      const r = check(session);
      assert.equal(r.code, 0);
      assert.ok(!r.stdout.includes('Scope:'), r.stdout);
      assert.equal(manifestOf(slug).checks.scope, undefined);
      const s = stage(dir, ['pr-summary'], session);
      assert.ok(!s.stdout.includes('**Scope:**'), s.stdout);
      assert.equal(JSON.parse(/<!-- shipline:summary (.*) -->/.exec(s.stdout)[1]).scope, undefined);
      const a = stage(dir, ['advance'], session);
      assert.equal(a.code, 0, a.stderr);
    } finally {
      cleanRepo();
    }
  });
});

describe('pr-summary: the Scope line and JSON scope', () => {
  const summaryOf = (session) => {
    const r = stage(dir, ['pr-summary'], session);
    assert.equal(r.code, 0, r.stderr);
    const m = /<!-- shipline:summary (.*) -->\n$/.exec(r.stdout);
    assert.ok(m, r.stdout);
    return { text: r.stdout, json: JSON.parse(m[1]) };
  };
  const scopeLine = (text) => text.split('\n').find((l) => l.startsWith('**Scope:**'));

  test('before and after the answer: the counts, the two lists in <details>, and accepted in the JSON', () => {
    setConfig(PASSING());
    const { session, slug } = atVerify();
    try {
      write('test/a.test.js');
      write('test/b.test.js');
      write('src/other.js');
      assert.equal(check(session).code, 0);
      let s = summaryOf(session);
      assert.equal(scopeLine(s.text), '**Scope:** edits 2 test files, 3 files outside the plan');
      assert.ok(s.text.includes('<details><summary>Test, lint and CI files edited</summary>\n\n- `test/a.test.js`\n- `test/b.test.js`\n\n</details>'), s.text);
      assert.ok(s.text.includes('<details><summary>Files outside the plan</summary>\n\n- `src/other.js`\n- `test/a.test.js`\n- `test/b.test.js`\n\n</details>'), s.text);
      assert.deepEqual(s.json.scope, { sensitive: ['test/a.test.js', 'test/b.test.js'], outside_plan: ['src/other.js', 'test/a.test.js', 'test/b.test.js'], accepted: false });
      const q = scopeQ(slug, 2, 3, runId(slug));
      asks(session, q, SCOPE_OPTIONS);
      answer(session, q, 'Finish anyway');
      assert.equal(stage(dir, ['advance'], session).code, 0);
      s = summaryOf(session);
      assert.equal(scopeLine(s.text), '**Scope:** edits 2 test files, 3 files outside the plan (accepted)');
      assert.equal(s.json.scope.accepted, true);
    } finally {
      cleanRepo();
    }
  });

  test('outside_plan null in the JSON when the plan lists no files', () => {
    setConfig(PASSING());
    const { session } = atVerify({ plan: PLAN_NO_FILES });
    try {
      write('test/a.test.js');
      assert.equal(check(session).code, 0);
      const s = summaryOf(session);
      assert.deepEqual(s.json.scope, { sensitive: ['test/a.test.js'], outside_plan: null, accepted: false });
      assert.equal(scopeLine(s.text), '**Scope:** edits 1 test file');
      assert.ok(!s.text.includes('Files outside the plan'));
    } finally {
      cleanRepo();
    }
  });

  test('no check run yet: no Scope line and no JSON scope', () => {
    setConfig(PASSING());
    const { session } = atVerify();
    const s = summaryOf(session);
    assert.equal(scopeLine(s.text), undefined);
    assert.equal(s.json.scope, undefined);
  });
});

describe('outside git', () => {
  let plain;
  before(() => {
    plain = tmpDir('shipline-scope-nogit-');
    const r = runInit(plain);
    assert.equal(r.code, 0, r.stderr);
  });
  after(() => removeDir(plain));

  test('base_commit is null, check still runs and reports the scope as unknown, and advance asks nothing about it', () => {
    const slug = 'nogit';
    const r = stage(plain, ['start', '--workflow', 'small', '--title', slug], 'ng1');
    assert.equal(r.code, 0, r.stderr);
    const mf = path.join(storeOf(plain), 'tasks', slug, 'manifest.json');
    assert.equal(JSON.parse(readFileSync(mf, 'utf8')).task.base_commit, null);
    const c = stage(plain, ['check'], 'ng1');
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, /^Scope: unknown \(not a git repository, or it had no commits when the task started\)$/m);
    const scope = JSON.parse(readFileSync(mf, 'utf8')).checks.scope;
    assert.equal(scope.changed, null);
    // Through to verify: implement (guide) then verify (checks, confirm_to_advance) asks only the advance question.
    // tracker: none (the default) skipped the optional ticket stage on start.
    assert.deepEqual(JSON.parse(readFileSync(mf, 'utf8')).stages[0].skipped.via, 'optional');
    writeFileSync(path.join(storeOf(plain), 'tasks', slug, 'implementation.md'), 'done\n');
    assert.equal(stage(plain, ['advance'], 'ng1').code, 0);
    writeFileSync(path.join(storeOf(plain), 'tasks', slug, 'verification.md'), '# V\n\n## Checklist\n\n- [x] it works as intended\n');
    const a = stage(plain, ['advance'], 'ng1');
    assert.equal(a.code, 1);
    assert.match(a.stderr, /question: Advance past "verify"/);
    rmSync(path.join(storeOf(plain), 'tasks', slug, 'verification.md'));
  });
});
