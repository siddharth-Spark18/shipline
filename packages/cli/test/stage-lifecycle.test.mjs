// Shipline 2.2.0, part D (docs/plans/shipline-2-2-0-dev-loop.md): the task lifecycle and the dev-loop escape hatches.
// Abandon and title collisions (D2), ownership (D3), `status --all` and the quieter session start (D4), side passes (D5),
// unbinding on completion and `last_task` (D6), `explain` (D7), the headless policy (D8), SessionStart auto-bind (D1)
// and worktree roots (D12). Runs the vendored scripts of real temp repos. Node 18+ (test:hooks).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, homeFor, hook, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';
import { findRoot, listAllTasks, listOpenTasks } from '../templates/shipline/bin/lib.mjs';

// One stage that blocks every file edit outside docs/ until it is done.
const DOCS_WF = `id: dw
name: Dw
stages:
  - id: write
    name: Write
    enforcement: block
    blocks:
      - tools: 'Edit|Write|MultiEdit|NotebookEdit'
        allow_paths: ['docs/**']
  - id: after
    name: After
    enforcement: guide
`;
// A single guide stage: finishing it completes the task.
const ONE_WF = `id: one
name: One
stages:
  - id: only
    name: Only
    enforcement: guide
`;
// A Verify-like stage that needs checks and the developer's answer.
const HEADLESS_WF = `id: hl
name: Hl
stages:
  - id: verify
    name: Verify
    artifact: verification.md
    checks: true
    enforcement: guide
    confirm_to_advance: true
`;

let dir;
let scripts;
const NODE = `"${process.execPath}"`;
const tasksOf = (d = dir) => path.join(storeOf(d), 'tasks');
const stateOf = (session, d = dir) => path.join(storeOf(d), 'state', `${session}.json`);
const readState = (session, d = dir) => JSON.parse(readFileSync(stateOf(session, d), 'utf8'));
const manifestOf = (slug, d = dir) => JSON.parse(readFileSync(path.join(tasksOf(d), slug, 'manifest.json'), 'utf8'));
const writeManifest = (slug, m, d = dir) => writeFileSync(path.join(tasksOf(d), slug, 'manifest.json'), JSON.stringify(m, null, 2));
const ownerOf = (slug, d = dir) => JSON.parse(readFileSync(path.join(tasksOf(d), slug, 'owner.json'), 'utf8'));
// The lib functions read the store of $SHIPLINE_HOME; point this process at the temp repo's own home for the call.
function inStore(d, fn) {
  const saved = process.env.SHIPLINE_HOME;
  process.env.SHIPLINE_HOME = homeFor(d);
  try {
    return fn();
  } finally {
    process.env.SHIPLINE_HOME = saved;
  }
}
let uniq = 0;
const nextSession = (p = 'ls') => `${p}${++uniq}`;

// The stage CLI with extra environment (SHIPLINE_NONINTERACTIVE and the like).
function stageEnv(args, session, env = {}, d = dir) {
  return run(process.execPath, [path.join(d, '.shipline', 'bin', 'stage.mjs'), ...args, ...(session ? ['--session', session] : [])], { cwd: d, env });
}
const headless = { SHIPLINE_NONINTERACTIVE: '1' };

// The guard hook for one tool call; `env` adds environment. Returns { json, hso, decision, reason }.
function guard(session, tool, toolInput, { env, cwd = dir, root = dir } = {}) {
  const r = run(process.execPath, [path.join(root, '.shipline', 'bin', 'guard.mjs')], {
    cwd,
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }),
    env,
  });
  assert.equal(r.code, 0, r.stderr);
  const json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  const hso = (json && json.hookSpecificOutput) || null;
  return { json, hso, decision: hso ? hso.permissionDecision || null : null, reason: hso ? hso.permissionDecisionReason || '' : '' };
}
const edit = (session, file, opts) => guard(session, 'Edit', { file_path: path.join(opts && opts.root ? opts.root : dir, file), old_string: 'a', new_string: 'b' }, opts);
const bash = (session, command, opts) => guard(session, 'Bash', { command }, opts);

// The developer's answer to a pending question (the PostToolUse hook for AskUserQuestion).
function answer(session, question, label, d = dir) {
  const r = hook(d, 'record-answer.mjs', {
    session_id: session,
    cwd: d,
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: `toolu_${session}_${Date.now()}_${++uniq}`,
    tool_input: { questions: [{ question, header: 'Shipline', options: [{ label }], multiSelect: false }] },
    tool_response: { answers: { [question]: label } },
  });
  assert.equal(r.code, 0, r.stderr);
}
// The question a command that needs an answer printed.
const questionOf = (r) => {
  const m = /^ {2}question: (.*)$/m.exec(r.stderr);
  assert.ok(m, `no question in: ${r.stderr}`);
  return m[1];
};
// Runs `args`; it must ask, the developer answers `label`, and the identical rerun is returned.
function confirmed(args, session, label) {
  const first = stage(dir, args, session);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  answer(session, questionOf(first), label);
  return stage(dir, args, session);
}
const startTask = (wf, title, session) => {
  const r = stage(dir, ['start', '--workflow', wf, '--title', title], session);
  assert.equal(r.code, 0, r.stderr);
  return r;
};

before(() => {
  dir = makeRepo({ commitInit: true });
  scripts = tmpDir('shipline-lifecycle-scripts-');
  writeFileSync(path.join(scripts, 'pass.js'), "console.log('ok');\n");
  writeFileSync(path.join(scripts, 'fail.js'), "console.log('broken');\nprocess.exit(3);\n");
  for (const [id, text] of [['dw', DOCS_WF], ['one', ONE_WF], ['hl', HEADLESS_WF]]) writeFileSync(path.join(dir, '.shipline', 'workflows', `${id}.yml`), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'lifecycle workflows');
});
after(() => {
  removeDir(dir);
  removeDir(scripts);
});

describe('D2: abandon and title collisions', () => {
  test('without an answer it asks and changes nothing; the answer authorises only the identical rerun', () => {
    const s = nextSession();
    startTask('one', 'Drop me', s);
    const first = stage(dir, ['abandon', '--reason', 'duplicate'], s);
    assert.equal(first.code, 1);
    assert.equal(questionOf(first), 'Abandon task drop-me? Reason: duplicate');
    assert.match(first.stderr, /options: "Abandon" and "Keep it"/);
    assert.match(first.stderr, /again with exactly the same arguments/);
    assert.equal(manifestOf('drop-me').abandoned, undefined);
    assert.equal(readState(s).task_dir, path.join(tasksOf(), 'drop-me'));
    // The answer is for "duplicate"; another reason is another question.
    answer(s, 'Abandon task drop-me? Reason: duplicate', 'Abandon');
    const other = stage(dir, ['abandon', '--reason', 'something else'], s);
    assert.equal(other.code, 1);
    assert.equal(questionOf(other), 'Abandon task drop-me? Reason: something else');
    assert.equal(manifestOf('drop-me').abandoned, undefined);
  });

  test('with the answer: abandoned, unbound, hidden from open lists, shown by status --all; resume brings it back', () => {
    const s = nextSession();
    startTask('one', 'Old idea', s);
    const done = confirmed(['abandon', '--reason', 'not needed'], s, 'Abandon');
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout.trim(), 'Abandoned old-idea. Resume it any time with stage.mjs resume old-idea.');
    const ab = manifestOf('old-idea').abandoned;
    assert.equal(ab.reason, 'not needed');
    assert.ok(Date.parse(ab.at) > 0);
    assert.equal(existsSync(stateOf(s)), false, 'the binding is removed');
    assert.ok(!inStore(dir, () => listOpenTasks(dir)).some((t) => t.slug === 'old-idea'));
    const all = inStore(dir, () => listAllTasks(dir)).find((t) => t.slug === 'old-idea');
    assert.equal(all.state, 'abandoned');
    const st = stage(dir, ['status', '--all'], s);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /^old-idea \(one\) stage: only, .*\[abandoned\]$/m);
    // Resume clears it.
    const r = stage(dir, ['resume', 'old-idea'], s);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(manifestOf('old-idea').abandoned, undefined);
    assert.equal(readState(s).task_dir, path.join(tasksOf(), 'old-idea'));
    assert.ok(inStore(dir, () => listOpenTasks(dir)).some((t) => t.slug === 'old-idea'));
  });

  test('abandon --task <folder> asks about that task; a finished or already abandoned task is refused', () => {
    const s = nextSession();
    startTask('one', 'Other task', nextSession());
    const first = stage(dir, ['abandon', '--task', 'other-task'], s);
    assert.equal(first.code, 1);
    assert.equal(questionOf(first), 'Abandon task other-task? Reason: none');
    const again = confirmed(['abandon', '--task', 'other-task'], s, 'Abandon');
    assert.equal(again.code, 0, again.stderr);
    const twice = stage(dir, ['abandon', '--task', 'other-task'], s);
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /already abandoned/);
  });

  test('a guard call from a session still bound to an abandoned task enforces nothing', () => {
    const a = nextSession();
    const b = nextSession();
    startTask('dw', 'Docs only', a);
    assert.equal(stage(dir, ['resume', 'docs-only'], b).code, 0);
    assert.equal(edit(b, 'src/a.js').decision, 'deny');
    assert.equal(confirmed(['abandon'], a, 'Abandon').code, 0);
    assert.equal(edit(b, 'src/a.js').decision, null);
  });

  test('a title whose folder exists (open, done or abandoned) gets -2, -3, and the branch follows', () => {
    const s1 = nextSession();
    const first = startTask('one', 'Same title', s1);
    assert.match(first.stdout, /in .*tasks[\\/]same-title\n/);
    const second = startTask('one', 'Same title', nextSession());
    assert.match(second.stdout, /A task folder for "same-title" already exists; using same-title-2\./);
    assert.match(second.stdout, /Suggested branch: one\/same-title-2\n/);
    const m2 = manifestOf('same-title-2');
    assert.equal(m2.task.title, 'Same title');
    assert.equal(m2.task.slug, 'same-title-2');
    // A finished and an abandoned one count too.
    const mf = manifestOf('same-title');
    for (const s of mf.stages) s.status = 'done';
    writeManifest('same-title', mf);
    startTask('one', 'Same title', nextSession());
    assert.ok(existsSync(path.join(tasksOf(), 'same-title-3', 'manifest.json')));
    assert.equal(confirmed(['abandon', '--task', 'same-title-3'], nextSession(), 'Abandon').code, 0);
    startTask('one', 'Same title', nextSession());
    assert.ok(existsSync(path.join(tasksOf(), 'same-title-4', 'manifest.json')));
  });

  test('with a ticket the folder is <KEY>-<slug>-2', () => {
    const r1 = stage(dir, ['start', '--workflow', 'one', '--title', 'Ticketed', '--ticket', 'ab-1'], nextSession());
    assert.equal(r1.code, 0, r1.stderr);
    const r2 = stage(dir, ['start', '--workflow', 'one', '--title', 'Ticketed', '--ticket', 'ab-1'], nextSession());
    assert.equal(r2.code, 0, r2.stderr);
    assert.ok(existsSync(path.join(tasksOf(), 'AB-1-ticketed-2', 'manifest.json')));
  });
});

describe('D3: ownership', () => {
  test('start writes owner.json; resume while another session is active warns and takes ownership', () => {
    const a = nextSession();
    const b = nextSession();
    startTask('one', 'Shared task', a);
    assert.equal(ownerOf('shared-task').session, a);
    const r = stage(dir, ['resume', 'shared-task'], b);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith(`Another Claude session (${a.slice(0, 8)}) was working on this task 0 min ago. Both sessions now see it; avoid editing the same files.\n`), r.stdout);
    assert.equal(ownerOf('shared-task').session, b);
    assert.equal(readState(a).task_dir, readState(b).task_dir, 'both stay bound');
  });

  test('a stale owner (over 10 minutes) gives no warning', () => {
    const a = nextSession();
    startTask('one', 'Stale owner', a);
    const f = path.join(tasksOf(), 'stale-owner', 'owner.json');
    writeFileSync(f, JSON.stringify({ session: a, last_seen: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
    const r = stage(dir, ['resume', 'stale-owner'], nextSession());
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('Another Claude session'), r.stdout);
  });

  test('a corrupt owner.json is treated as absent', () => {
    const a = nextSession();
    startTask('one', 'Corrupt owner', a);
    writeFileSync(path.join(tasksOf(), 'corrupt-owner', 'owner.json'), '{nope');
    const r = stage(dir, ['resume', 'corrupt-owner'], nextSession());
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('Another Claude session'));
  });

  test('the guard refreshes owner.json at most once a minute', () => {
    const s = nextSession();
    startTask('one', 'Heartbeat', s);
    const f = path.join(tasksOf(), 'heartbeat', 'owner.json');
    const old = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    writeFileSync(f, JSON.stringify({ session: 'someone-else', last_seen: old }));
    edit(s, 'src/a.js');
    const o1 = ownerOf('heartbeat');
    assert.equal(o1.session, s);
    assert.ok(Date.parse(o1.last_seen) > Date.parse(old));
    edit(s, 'src/a.js');
    assert.equal(ownerOf('heartbeat').last_seen, o1.last_seen, 'throttled: no write within 60 s');
  });
});

describe('D4: status --all and a quieter session start', () => {
  test('status --all (with or without a session) lists every task with workflow, stage, age, branch and marker', () => {
    const s = nextSession();
    startTask('one', 'Listed open', s);
    startTask('one', 'Listed done', nextSession());
    const m = manifestOf('listed-done');
    for (const st of m.stages) st.status = 'done';
    writeManifest('listed-done', m);
    for (const session of [s, null]) {
      const r = stage(dir, ['status', '--all'], session);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^listed-open \(one\) stage: only, today, branch: one\/listed-open$/m);
      assert.match(r.stdout, /^listed-done \(one\) stage: none, .*\[done\]$/m);
    }
    const j = JSON.parse(stage(dir, ['status', '--all', '--json'], null).stdout);
    assert.ok(j.tasks.some((t) => t.slug === 'listed-open' && t.state === 'open'));
    assert.ok(j.tasks.some((t) => t.slug === 'listed-done' && t.state === 'done'));
  });
});

describe('D5: side passes', () => {
  let s;
  before(() => {
    s = nextSession('side');
    startTask('dw', 'Side task', s);
  });
  const pass = () => readState(s).side_pass;

  test('the stage blocks an unrelated edit; a side pass needs the developer, then lets exactly those files through', () => {
    assert.equal(edit(s, 'README.md').decision, 'deny');
    const first = stage(dir, ['side', '--files', 'README.md', '--reason', 'typo'], s);
    assert.equal(first.code, 1);
    assert.equal(questionOf(first), 'Allow edits to README.md outside the stages of task side-task? Reason: typo');
    assert.match(first.stderr, /options: "Allow" and "Don't allow"/);
    assert.equal(pass(), undefined);
    answer(s, questionOf(first), 'Allow');
    const ok = stage(dir, ['side', '--files', 'README.md', '--reason', 'typo'], s);
    assert.equal(ok.code, 0, ok.stderr);
    const sp = pass();
    assert.deepEqual(sp.files, ['README.md']);
    assert.equal(sp.reason, 'typo');
    const left = Date.parse(sp.expires_at) - Date.now();
    assert.ok(left > 29 * 60 * 1000 && left <= 30 * 60 * 1000, `expires in ${left} ms`);
    const logged = manifestOf('side-task').side_passes;
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0].files, ['README.md']);
    assert.equal(logged[0].session, s);
    // README.md passes (file tool and a Bash write); another file and a rail still do not.
    assert.equal(edit(s, 'README.md').decision, null);
    assert.equal(bash(s, 'echo hi > README.md').decision, null);
    assert.equal(edit(s, 'src/a.js').decision, 'deny');
    assert.equal(bash(s, 'echo hi > src/a.js').decision, 'deny');
    assert.equal(bash(s, 'cat .env').decision, 'deny', 'a side pass never lifts a rail');
  });

  test('an answer for one file list does not authorise another; globs, absolute paths, none and over 10 are refused', () => {
    const other = stage(dir, ['side', '--files', 'README.md,docs/x.md', '--reason', 'typo'], s);
    assert.equal(other.code, 1);
    assert.equal(questionOf(other), 'Allow edits to README.md, docs/x.md outside the stages of task side-task? Reason: typo');
    for (const files of ['src/*.js', '/etc/passwd', '../x.md', 'a?.md']) {
      const r = stage(dir, ['side', '--files', files, '--reason', 'x'], s);
      assert.equal(r.code, 1, files);
      assert.match(r.stderr, /exact file paths|inside the repo/, files);
    }
    const none = stage(dir, ['side', '--reason', 'x'], s);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /side needs --files/);
    const many = stage(dir, ['side', '--files', Array.from({ length: 11 }, (_, i) => `d/f${i}.md`).join(','), '--reason', 'x'], s);
    assert.equal(many.code, 1);
    assert.match(many.stderr, /1 to 10 files/);
    const noReason = stage(dir, ['side', '--files', 'README.md'], s);
    assert.equal(noReason.code, 1);
    assert.match(noReason.stderr, /--reason/);
  });

  test('advance does not clear the pass; a new side replaces the old after its own answer; side done clears it', () => {
    const r = confirmed(['side', '--files', 'src/a.js', '--reason', 'tweak'], s, 'Allow');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pass().files, ['src/a.js']);
    assert.equal(edit(s, 'README.md').decision, 'deny', 'the old pass is replaced');
    assert.equal(edit(s, 'src/a.js').decision, null);
    const done = stage(dir, ['side', 'done'], s);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(pass(), undefined);
    assert.equal(edit(s, 'src/a.js').decision, 'deny');
    assert.equal(readState(s).task_dir, path.join(tasksOf(), 'side-task'), 'the binding stays');
  });

  test('an expired pass no longer lets anything through', () => {
    assert.equal(confirmed(['side', '--files', 'README.md', '--reason', 'late'], s, 'Allow').code, 0);
    assert.equal(edit(s, 'README.md').decision, null);
    const st = readState(s);
    st.side_pass.expires_at = new Date(Date.now() - 1000).toISOString();
    writeFileSync(stateOf(s), JSON.stringify(st));
    assert.equal(edit(s, 'README.md').decision, 'deny');
  });

  test('without a task: "No task is active; nothing blocks this edit."', () => {
    const r = stage(dir, ['side', '--files', 'README.md', '--reason', 'x'], nextSession());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'No task is active; nothing blocks this edit.');
  });

  test('a stage advance on another session leaves this pass alone; the pass is per session', () => {
    assert.equal(confirmed(['side', '--files', 'README.md', '--reason', 'again'], s, 'Allow').code, 0);
    const b = nextSession();
    assert.equal(stage(dir, ['resume', 'side-task'], b).code, 0);
    assert.equal(edit(b, 'README.md').decision, 'deny');
    assert.equal(edit(s, 'README.md').decision, null);
  });
});

describe('D6: unbind on completion, and last_task', () => {
  test('finishing the last stage unbinds the session, keeps last_task, and the prompt hook treats the next request as new', () => {
    const s = nextSession();
    startTask('one', 'Finish me', s);
    const r = stage(dir, ['advance'], s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Task finish-me is complete; this session is no longer tracking a task\./);
    const st = readState(s);
    assert.equal(st.task_dir, undefined);
    assert.equal(st.last_task, path.join(tasksOf(), 'finish-me'));
    const p = hook(dir, 'prompt-submit.mjs', { session_id: s, cwd: dir, prompt: 'next thing' });
    assert.match(p.json.hookSpecificOutput.additionalContext, /^Shipline: no workflow is active\./);
    assert.equal(edit(s, 'src/a.js').decision, null);
  });

  test('pr-summary and status with no binding and no --task use last_task and say so on stderr', () => {
    const s = nextSession();
    startTask('one', 'Summarise me', s);
    assert.equal(stage(dir, ['advance'], s).code, 0);
    const pr = stage(dir, ['pr-summary'], s);
    assert.equal(pr.code, 0, pr.stderr);
    assert.match(pr.stderr, /\(task .*summarise-me, finished in this session\)/);
    assert.ok(!pr.stdout.includes('finished in this session'), 'the pasted summary stays clean');
    assert.match(pr.stdout, /<!-- shipline:summary /);
    const status = stage(dir, ['status'], s);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stderr, /finished in this session/);
    assert.match(status.stdout, /All stages are done/);
    // Other commands still need a bound task.
    const adv = stage(dir, ['advance'], s);
    assert.equal(adv.code, 1);
    assert.match(adv.stderr, /no active task/);
    // A session that never finished a task gets no such fallback.
    const none = stage(dir, ['pr-summary'], nextSession());
    assert.equal(none.code, 1);
  });

  test('starting another task replaces last_task', () => {
    const s = nextSession();
    startTask('one', 'First done', s);
    assert.equal(stage(dir, ['advance'], s).code, 0);
    startTask('one', 'Second one', s);
    const st = readState(s);
    assert.equal(st.last_task, undefined);
    assert.equal(st.task_dir, path.join(tasksOf(), 'second-one'));
  });

  test('a task finished through skip unbinds too; --task of another task leaves the binding', () => {
    const s = nextSession();
    startTask('one', 'Keep bound', s);
    startTask('one', 'Finish elsewhere', nextSession());
    const other = stage(dir, ['advance', '--task', 'finish-elsewhere'], s);
    assert.equal(other.code, 0, other.stderr);
    assert.equal(readState(s).task_dir, path.join(tasksOf(), 'keep-bound'));
    assert.doesNotMatch(other.stdout, /no longer tracking/);
  });
});

describe('D7: explain', () => {
  test('a stage block: the stage, advance, and a side pass for an unrelated edit', () => {
    const s = nextSession();
    startTask('dw', 'Explain stage', s);
    assert.equal(edit(s, 'README.md').decision, 'deny');
    const r = stage(dir, ['explain'], s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /denied Edit on .*README\.md/);
    assert.match(r.stdout, /the "write" stage of this task hasn't been finished/);
    assert.match(r.stdout, /finish "write" and run stage\.mjs advance/);
    assert.match(r.stdout, /stage\.mjs side --files .*README\.md --reason/);
  });

  test('a rail: its id, level and config key, and no way around it', () => {
    const s = nextSession();
    assert.equal(bash(s, 'cat .env').decision, 'deny'); // no task needed
    const r = stage(dir, ['explain'], s);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /guardrail print_credentials \(currently deny\)/);
    assert.match(r.stdout, /rails\.print_credentials: ask\|off in \.shipline\/config\.yml/);
    assert.doesNotMatch(r.stdout, /side --files/);
  });

  test('a protected path (an ask) names its protected_paths entry', () => {
    const s = nextSession();
    assert.equal(edit(s, 'migrations/001.sql').decision, 'ask');
    const r = stage(dir, ['explain'], s);
    assert.match(r.stdout, /asked about Edit/);
    assert.match(r.stdout, /protected_paths entry migrations\/\*\*/);
  });

  test('the last decision wins; nothing recorded prints the plain message', () => {
    const s = nextSession();
    assert.equal(stage(dir, ['explain'], s).stdout.trim(), 'No Shipline denial recorded for this session.');
    bash(s, 'cat .env');
    edit(s, 'migrations/001.sql');
    assert.match(stage(dir, ['explain'], s).stdout, /protected_paths/);
    writeFileSync(path.join(storeOf(dir), 'state', `${s}.decision.json`), '{nope');
    assert.equal(stage(dir, ['explain'], s).stdout.trim(), 'No Shipline denial recorded for this session.', 'a corrupt record is absent');
  });
});

describe('D8: the headless policy', () => {
  const setConfig = (test, policy) => {
    const f = path.join(dir, '.shipline', 'config.yml');
    let text = readFileSync(f, 'utf8');
    text = text.replace(/^ {2}test: .*$/m, `  test: '${NODE} "${path.join(scripts, test)}"'`);
    text = text.replace(/^non_interactive: .*$/m, `non_interactive: ${policy}`);
    writeFileSync(f, text);
  };
  const atVerify = (title) => {
    const s = nextSession('hl');
    startTask('hl', title, s);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    writeFileSync(path.join(tasksOf(), slug, 'verification.md'), '# Verification\n\nChecked.\n');
    return { s, slug };
  };

  test('without the flag nothing changes: advance asks the developer', () => {
    setConfig('pass.js', 'checks_pass');
    const { s } = atVerify('Plain run');
    assert.equal(stage(dir, ['check'], s).code, 0);
    const r = stage(dir, ['advance'], s);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /question: Advance past "verify"/);
  });

  test('with the flag and non_interactive: deny, a command that would ask fails with the policy message', () => {
    setConfig('pass.js', 'deny');
    const { s } = atVerify('Deny run');
    assert.equal(stageEnv(['check'], s, headless).code, 0);
    const r = stageEnv(['advance'], s, headless);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("This stage needs the developer's answer, and this is a non-interactive run (SHIPLINE_NONINTERACTIVE=1). Set non_interactive: checks_pass in .shipline/config.yml to let passing checks advance, or run interactively."), r.stderr);
    assert.doesNotMatch(r.stderr, /question:/);
    assert.equal(manifestOf('deny-run').stages[0].status, 'in_progress');
  });

  test('checks_pass: passing checks on the current code advance the stage, recorded as non_interactive', () => {
    setConfig('pass.js', 'checks_pass');
    const { s, slug } = atVerify('Auto run');
    assert.equal(stageEnv(['check'], s, headless).code, 0);
    const r = stageEnv(['advance'], s, headless);
    assert.equal(r.code, 0, r.stderr);
    const v = manifestOf(slug).stages[0];
    assert.equal(v.status, 'done');
    assert.equal(v.approved_by, 'non_interactive');
    assert.equal(v.confirmed.via, 'non_interactive');
    const pr = stage(dir, ['pr-summary'], null, dir).stdout;
    assert.equal(pr, '', 'no session and no --task: nothing to summarise');
    const sum = stageEnv(['pr-summary', '--task', slug], null, headless).stdout;
    assert.match(sum, /\| verify \| done \| auto \(non-interactive\) \|/);
    assert.match(sum, /Advanced without a developer answer \(non-interactive, checks passed\): verify/);
    assert.equal(JSON.parse(/<!-- shipline:summary (.*) -->/.exec(sum)[1]).stages[0].confirmed, 'non_interactive');
  });

  test('checks_pass: no check run, stale code or failing checks are refused with the reason', () => {
    setConfig('pass.js', 'checks_pass');
    const none = atVerify('No check');
    const r1 = stageEnv(['advance'], none.s, headless);
    assert.equal(r1.code, 1);
    assert.match(r1.stderr, /needs a check run/); // the checks gate comes first
    assert.equal(manifestOf(none.slug).stages[0].status, 'in_progress');
    const stale = atVerify('Stale check');
    assert.equal(stageEnv(['check'], stale.s, headless).code, 0);
    writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 2;\n');
    try {
      const r2 = stageEnv(['advance'], stale.s, headless);
      assert.equal(r2.code, 1);
      assert.match(r2.stderr, /code changed|current code/);
    } finally {
      git(dir, 'checkout', '-q', '--', 'src/a.js');
    }
    setConfig('fail.js', 'checks_pass');
    const failing = atVerify('Failing check');
    assert.equal(stageEnv(['check'], failing.s, headless).code, 1);
    const r3 = stageEnv(['advance'], failing.s, headless);
    assert.equal(r3.code, 1);
    assert.match(r3.stderr, /non-interactive run/);
    assert.equal(manifestOf(failing.slug).stages[0].status, 'in_progress');
  });

  test('skip, abandon and side are never auto-approved', () => {
    setConfig('pass.js', 'checks_pass');
    const { s } = atVerify('Never auto');
    for (const args of [['skip', '--reason', 'x'], ['abandon'], ['side', '--files', 'README.md', '--reason', 'x']]) {
      const r = stageEnv(args, s, headless);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stderr, /non-interactive run \(SHIPLINE_NONINTERACTIVE=1\)/, args.join(' '));
    }
    assert.equal(manifestOf('never-auto').abandoned, undefined);
  });

  test('the guard returns an ask as a deny, with the suffix, and records it as a deny', () => {
    const s = nextSession();
    const normal = bash(s, 'source .env && echo ok');
    assert.equal(normal.decision, 'ask');
    const r = bash(s, 'source .env && echo ok', { env: headless });
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason.endsWith("(non-interactive run: this needs a developer's approval)"), r.reason);
    const rec = JSON.parse(readFileSync(path.join(storeOf(dir), 'state', `${s}.decision.json`), 'utf8'));
    assert.equal(rec.decision, 'deny');
    assert.equal(rec.kind, 'rail');
    assert.equal(rec.id, 'print_credentials');
    // A protected path too.
    assert.equal(edit(s, 'migrations/001.sql', { env: headless }).decision, 'deny');
  });
});

describe('D1: SessionStart auto-bind', () => {
  let repo;
  const start = (session, source = 'startup', extra = {}) => hook(repo, 'session-start.mjs', { session_id: session, cwd: repo, hook_event_name: 'SessionStart', source, ...extra });
  const ctx = (r) => r.json.hookSpecificOutput.additionalContext;
  const bindingOf = (session) => (existsSync(stateOf(session, repo)) ? readState(session, repo) : null);
  const taskIn = (title, session, wf = 'bugfix') => {
    const r = stage(repo, ['start', '--workflow', wf, '--title', title], session);
    assert.equal(r.code, 0, r.stderr);
  };

  before(() => {
    repo = makeRepo({ commitInit: true });
  });
  after(() => removeDir(repo));

  test('one open task on the branch: a new session (source clear) is bound, with the "continuing" context', () => {
    taskIn('Auto one', 'first');
    git(repo, 'switch', '-q', '-c', 'bugfix/auto-one');
    const r = start('after-clear', 'clear');
    assert.equal(r.code, 0, r.stderr);
    assert.match(ctx(r), /Shipline: continuing task auto-one \(bugfix workflow\), current stage "reproduce"\. Run: node \.shipline\/bin\/stage\.mjs status/);
    assert.equal(bindingOf('after-clear').task_dir, path.join(tasksOf(repo), 'auto-one'));
    // The guard now enforces the task's stages for the new session.
    assert.equal(ownerOf('auto-one', repo).session, 'after-clear');
    git(repo, 'switch', '-q', 'main');
  });

  test('an existing binding is kept (whatever the source); no task on the branch means no bind', () => {
    git(repo, 'switch', '-q', 'bugfix/auto-one');
    stage(repo, ['resume', 'auto-one'], 'bound-already');
    const r = start('bound-already', 'resume');
    assert.match(ctx(r), /This session is already working on task .*auto-one/);
    git(repo, 'switch', '-q', 'main');
    const none = start('on-main', 'startup');
    assert.equal(bindingOf('on-main'), null);
    assert.match(ctx(none), /Unfinished Shipline tasks/);
  });

  test('two open tasks on the branch: no bind, both listed', () => {
    taskIn('Auto two', 'second');
    const f = path.join(tasksOf(repo), 'auto-two', 'manifest.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    m.task.branch = 'bugfix/auto-one';
    writeFileSync(f, JSON.stringify(m));
    git(repo, 'switch', '-q', 'bugfix/auto-one');
    try {
      const r = start('two-match', 'startup');
      assert.equal(bindingOf('two-match'), null);
      assert.match(ctx(r), /- auto-one \[bugfix\].*\(matches the current git branch, likely this one\)/);
      assert.match(ctx(r), /- auto-two \[bugfix\].*\(matches the current git branch, likely this one\)/);
    } finally {
      git(repo, 'switch', '-q', 'main');
      m.task.branch = 'bugfix/auto-two';
      writeFileSync(f, JSON.stringify(m));
    }
  });

  test('an abandoned task on the branch is not bound; a detached HEAD never binds; a task without a branch never binds', () => {
    git(repo, 'switch', '-q', 'bugfix/auto-one');
    try {
      assert.equal(confirmedIn(repo, ['abandon', '--task', 'auto-one'], 'abandoner', 'Abandon').code, 0);
      const r = start('abandoned-match', 'startup');
      assert.equal(bindingOf('abandoned-match'), null);
      assert.ok(!/auto-one/.test(ctx(r)), 'an abandoned task is not even listed');
      stage(repo, ['resume', 'auto-one'], 'resumer'); // back to open
      git(repo, 'checkout', '-q', '--detach');
      const d = start('detached', 'startup');
      assert.equal(bindingOf('detached'), null);
      assert.match(ctx(d), /Unfinished Shipline tasks/);
    } finally {
      git(repo, 'switch', '-q', 'main');
    }
    const f = path.join(tasksOf(repo), 'auto-two', 'manifest.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    delete m.task.branch;
    writeFileSync(f, JSON.stringify(m));
    git(repo, 'switch', '-q', '-c', 'whatever');
    const r = start('no-branch', 'startup');
    assert.equal(bindingOf('no-branch'), null);
    git(repo, 'switch', '-q', 'main');
    assert.match(ctx(r), /auto-two/);
  });

  test('the ownership warning: another session was active on the task a moment ago', () => {
    taskIn('Warned task', 'earlier');
    git(repo, 'switch', '-q', '-c', 'bugfix/warned-task');
    const r = start('later', 'startup');
    assert.match(ctx(r), /continuing task warned-task/);
    assert.match(ctx(r), /Another Claude session \(earlier\) was working on this task \d+ min ago\./);
    git(repo, 'switch', '-q', 'main');
  });

  test('stale tasks collapse into a count; a task on the current branch is always listed; ages are shown', () => {
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    const age = (slug) => {
      const f = path.join(tasksOf(repo), slug, 'manifest.json');
      const m = JSON.parse(readFileSync(f, 'utf8'));
      m.task.updated = old;
      for (const s of m.stages) s.updated = old;
      writeFileSync(f, JSON.stringify(m));
      writeFileSync(path.join(tasksOf(repo), slug, 'owner.json'), JSON.stringify({ session: 'gone', last_seen: old }));
    };
    const cfgFile = path.join(repo, '.shipline', 'config.yml');
    writeFileSync(cfgFile, readFileSync(cfgFile, 'utf8').replace(/^stale_task_days: .*$/m, 'stale_task_days: 7'));
    age('auto-two');
    age('warned-task');
    age('auto-one');
    // Everything is old and nothing is on this branch: collapsed to a count.
    const r = start('fresh-stale', 'startup');
    assert.doesNotMatch(ctx(r), /Unfinished Shipline tasks/);
    assert.match(ctx(r), /^\+3 older tasks \(idle over 7 days\): node \.shipline\/bin\/stage\.mjs status --all$/m);
    // A recent task is listed with its age; the old ones stay in the count.
    taskIn('Fresh one', 'fresh-owner');
    const r2 = start('fresh-stale-2', 'startup');
    assert.match(ctx(r2), /- fresh-one \[bugfix\]: .*\(0d ago\)/);
    assert.match(ctx(r2), /\+3 older tasks/);
    // Two old tasks on the current branch: never collapsed (and two matches means no bind).
    for (const slug of ['auto-one', 'auto-two']) {
      const f = path.join(tasksOf(repo), slug, 'manifest.json');
      const m = JSON.parse(readFileSync(f, 'utf8'));
      m.task.branch = 'bugfix/shared-old';
      writeFileSync(f, JSON.stringify(m));
    }
    git(repo, 'switch', '-q', '-c', 'bugfix/shared-old');
    try {
      const r3 = start('fresh-stale-3', 'startup');
      assert.match(ctx(r3), /- auto-one \[bugfix\]: .*\(20d ago\) \(matches the current git branch/);
      assert.match(ctx(r3), /- auto-two \[bugfix\]: .*\(20d ago\) \(matches the current git branch/);
      assert.match(ctx(r3), /\+1 older tasks/);
    } finally {
      git(repo, 'switch', '-q', 'main');
    }
    const all = stage(repo, ['status', '--all'], null);
    assert.match(all.stdout, /^auto-one \(bugfix\) stage: reproduce, 20d ago/m);
    assert.match(all.stdout, /^fresh-one \(bugfix\) stage: reproduce, today/m);
  });
});

// confirmed() for another repo.
function confirmedIn(repo, args, session, label) {
  const first = stage(repo, args, session);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  answer(session, questionOf(first), label, repo);
  return stage(repo, args, session);
}

describe('D12: worktrees', () => {
  let repo;
  let wt;
  before(() => {
    repo = makeRepo({ commitInit: true });
    wt = path.join(repo, '.claude', 'worktrees', 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    assert.ok(existsSync(path.join(wt, '.shipline', 'config.yml')), 'the worktree has its own .shipline');
  });
  after(() => removeDir(repo));

  test('findRoot: the cwd\'s git toplevel wins over CLAUDE_PROJECT_DIR; without a config there it falls back', () => {
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = repo;
    try {
      assert.equal(findRoot(wt), wt);
      assert.equal(findRoot(path.join(wt, 'src')), wt, 'a subfolder resolves to the worktree root');
      assert.equal(findRoot(repo), repo);
      const plain = tmpDir();
      try {
        git(plain, 'init', '-q');
        assert.equal(findRoot(plain), repo, 'a repo without .shipline/config.yml: the CLAUDE_PROJECT_DIR walk');
      } finally {
        removeDir(plain);
      }
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }
  });

  test('guard from the worktree: src/a.js is an ordinary edit, not agent config', () => {
    const r = guard('wt-s', 'Edit', { file_path: path.join(wt, 'src', 'a.js'), old_string: 'a', new_string: 'b' }, { cwd: wt, root: wt, env: { CLAUDE_PROJECT_DIR: repo } });
    assert.equal(r.decision, null, r.reason);
    // Real agent config in the worktree is still agent config.
    const cfg = guard('wt-s', 'Edit', { file_path: path.join(wt, 'CLAUDE.md'), old_string: 'a', new_string: 'b' }, { cwd: wt, root: wt, env: { CLAUDE_PROJECT_DIR: repo } });
    assert.equal(cfg.decision, 'ask');
  });

  test('guard from the main checkout: .claude/worktrees/** is not agent config, the rest of .claude/ is', () => {
    const inWt = guard('wt-s2', 'Edit', { file_path: path.join(repo, '.claude', 'worktrees', 'wt', 'src', 'a.js'), old_string: 'a', new_string: 'b' }, { cwd: repo, root: repo });
    assert.equal(inWt.decision, null, inWt.reason);
    const settings = guard('wt-s2', 'Edit', { file_path: path.join(repo, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' }, { cwd: repo, root: repo });
    assert.equal(settings.decision, 'ask');
  });

  test('stage.mjs run from the worktree uses the worktree as its root (its own store)', () => {
    const r = run(process.execPath, [path.join(wt, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'one', '--title', 'In worktree', '--session', 'wt-stage'], { cwd: wt, env: { CLAUDE_PROJECT_DIR: repo } });
    // The workflow `one` doesn't exist in this repo; the point is the root: the error names the worktree's workflow list.
    assert.equal(r.code, 1);
    const ok = run(process.execPath, [path.join(wt, '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'small', '--title', 'In worktree', '--session', 'wt-stage'], { cwd: wt, env: { CLAUDE_PROJECT_DIR: repo } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(existsSync(path.join(storeOf(wt), 'tasks', 'in-worktree', 'manifest.json')));
    assert.ok(!existsSync(path.join(storeOf(repo), 'tasks', 'in-worktree')), 'not in the main checkout\'s store');
  });
});
