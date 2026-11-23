// Teams Phase 3 (docs/plans/shipline-teams-phase3.md), D: named actions in stage blocks (`{ actions: [...] }`), which
// the guard matches on the parsed command, so the usual bypasses are caught; `{ bash: regex }` blocks still work; and
// the order the guard decides in (task store, then rails, then protected paths, then stage blocks; strictest wins).
// Runs the vendored guard on a real temp repo. Node 18+ (test:hooks).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, hook, makeRepo, removeDir, run, stage, storeOf } from './helpers.mjs';
import { ACTIONS, makeMatchCtx, matchAction, parseCommand } from '../templates/shipline/bin/lib.mjs';

// `hold` (block) holds back every action until it is done; `soft` (warn) holds back deploys; `regex` (block)
// holds back a legacy regex.
const ACTIONS_WF = `id: acts
name: Acts
stages:
  - id: hold
    name: Hold
    enforcement: block
    blocks:
      - actions: [commit, push, pr, merge, release, deploy, migrate]
  - id: done
    name: Done
    enforcement: guide
`;
const SOFT_WF = `id: soft
name: Soft
stages:
  - id: soft
    name: Soft
    enforcement: warn
    blocks:
      - actions: [deploy, commit]
`;
const REGEX_WF = `id: rx
name: Rx
stages:
  - id: rx
    name: Rx
    enforcement: block
    blocks:
      - bash: '\\bgit\\s+commit\\b|\\bgh\\s+pr\\s+create\\b'
`;
const PACKAGE_JSON = {
  name: 'x',
  scripts: { release: 'node scripts/release.js', go: 'git push origin feature/x', ship: 'sh -c "git commit -m auto"', build: 'tsc', publish: 'echo hi' },
};

let dir;
const bash = (command, session, cwd = dir) => hook(dir, 'guard.mjs', { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const hso = (r) => (r.json && r.json.hookSpecificOutput) || null;
const decision = (r) => (hso(r) ? hso(r).permissionDecision || null : null);
const stageDenied = (r, stageName, slug) => {
  assert.equal(r.code, 0, r.stderr);
  assert.equal(decision(r), 'deny', r.stdout);
  assert.match(hso(r).permissionDecisionReason, new RegExp(`^Shipline \\([\\w ]+ workflow, task ${slug}\\): ".*" needs the "${stageName}" stage to be done first\\.`));
};

before(() => {
  dir = makeRepo({ commitInit: true });
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'acts.yml'), ACTIONS_WF);
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'soft.yml'), SOFT_WF);
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'rx.yml'), REGEX_WF);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2));
  for (const [wf, session] of [
    ['acts', 'act-s'],
    ['soft', 'soft-s'],
    ['rx', 'rx-s'],
    ['small', 'small-s'],
  ]) {
    const r = stage(dir, ['start', '--workflow', wf, '--title', `${wf} task`], session);
    assert.equal(r.code, 0, r.stderr);
  }
});
after(() => removeDir(dir));

describe('actions blocks catch the bypasses', () => {
  test('the shipped verify block [commit, pr]: git -c x commit, cd sub && git commit, env/sudo wrappers, sh -c', () => {
    for (const command of [
      'git commit -m y',
      'git -c user.name=x commit -m y',
      'git -C . commit -m y',
      'cd packages/a && git commit -m y',
      'FOO=1 git commit -m y',
      'env GIT_AUTHOR_NAME=x git commit -m y',
      `sh -c 'git add . && git commit -m y'`,
      'gh pr create --fill',
      'git status; gh pr create --fill',
    ]) {
      stageDenied(bash(command, 'small-s'), 'Verify', 'small-task');
    }
  });

  test('not held back by [commit, pr]: other git commands, a push, a commit message mentioning commit', () => {
    for (const command of ['git status', 'git add -A', 'git log --grep commit', 'echo "git commit"', 'git cherry-pick -n abc', 'gh pr view']) {
      assert.equal(bash(command, 'small-s').stdout, '', command);
    }
  });

  test('npm run release is caught by the script name', () => {
    stageDenied(bash('npm run release', 'act-s'), 'Hold', 'acts-task');
    stageDenied(bash('pnpm release', 'act-s'), 'Hold', 'acts-task');
  });

  test('a script whose body runs git push (or a commit through sh -c) is caught', () => {
    stageDenied(bash('npm run go', 'act-s'), 'Hold', 'acts-task');
    stageDenied(bash('npm run ship', 'act-s'), 'Hold', 'acts-task');
    assert.equal(bash('npm run build', 'act-s').stdout, '');
    assert.equal(bash('npm test', 'act-s').stdout, '');
  });

  test('every action', () => {
    for (const command of ['git push origin feature/x', 'gh pr merge 3', 'git merge feature/x', 'gh release create v1', 'npm publish', 'cargo publish', 'twine upload dist/*', 'git tag -a v1.2.0 -m x', 'git tag v1.2.0', 'fly deploy', 'npx prisma migrate deploy']) {
      const r = bash(command, 'act-s');
      assert.equal(decision(r), 'deny', command);
      assert.match(hso(r).permissionDecisionReason, /needs the "Hold" stage to be done first/, command);
    }
    assert.equal(bash('git tag', 'act-s').stdout, '', 'listing tags is not a release');
  });

  test('matchAction: each action on its own, and an unknown action never matches', () => {
    const ctx = makeMatchCtx(dir, dir, { rails_commands: { deploy: [], migrate: [] } });
    const parts = (text) => parseCommand(text);
    const actionsOf = (text) => ACTIONS.filter((a) => parts(text).some((p) => matchAction(p, a, ctx)));
    assert.deepEqual(actionsOf('git -c x=y commit -m a'), ['commit']);
    assert.deepEqual(actionsOf('git push origin x'), ['push']);
    assert.deepEqual(actionsOf('gh pr create'), ['pr']);
    assert.deepEqual(actionsOf('gh pr merge 1'), ['pr', 'merge']);
    assert.deepEqual(actionsOf('glab mr merge 1'), ['merge']);
    assert.deepEqual(actionsOf('hub pull-request'), ['pr']);
    assert.deepEqual(actionsOf('npm run release'), ['release', 'deploy']);
    assert.deepEqual(actionsOf('npm run publish'), ['release']);
    assert.deepEqual(actionsOf('git revert HEAD'), ['commit']);
    assert.deepEqual(actionsOf('git revert --no-commit HEAD'), []);
    assert.ok(!parts('git commit').some((p) => matchAction(p, 'squash', ctx)));
  });

  test('an unknown action in a block is ignored, the known ones still apply', () => {
    const wf = ACTIONS_WF.replace('actions: [commit, push, pr, merge, release, deploy, migrate]', 'actions: [squash, commit]');
    writeFileSync(path.join(dir, '.shipline', 'workflows', 'acts.yml'), wf);
    try {
      assert.equal(bash('git push origin feature/x', 'act-s').stdout, '');
      assert.equal(decision(bash('git commit -m x', 'act-s')), 'deny');
    } finally {
      writeFileSync(path.join(dir, '.shipline', 'workflows', 'acts.yml'), ACTIONS_WF);
    }
  });

  test('stage blocks need a task: a session with no task is not held back', () => {
    assert.equal(bash('git -c x=y commit -m y', 'no-task').stdout, '');
  });
});

describe('regex blocks still work', () => {
  test('the old regex denies what it matches, and only that', () => {
    stageDenied(bash('git commit -m y', 'rx-s'), 'Rx', 'rx-task');
    stageDenied(bash('gh pr create', 'rx-s'), 'Rx', 'rx-task');
    // The regex was never parsed: the bypasses that actions catch still get through a regex block.
    assert.equal(bash('git -c x=y commit -m y', 'rx-s').stdout, '');
  });
});

describe('the order: store, then rails, then protected paths, then stages', () => {
  test('the store comes first: a command that reaches the store and trips a rail gets the store denial', () => {
    const r = bash(`cat .env > ${path.join(storeOf(dir), 'state', 'x.json')}`, 'act-s');
    assert.equal(decision(r), 'deny');
    assert.match(hso(r).permissionDecisionReason, /^Shipline: progress and approvals can only change through/);
  });

  test('a rail deny comes before a stage deny', () => {
    const r = bash('git push --force origin main', 'act-s');
    assert.equal(decision(r), 'deny');
    assert.match(hso(r).permissionDecisionReason, /^Shipline rail force_push_default: /);
  });

  test('a stage deny beats a rail ask and a protected-path ask', () => {
    stageDenied(bash('fly deploy', 'act-s'), 'Hold', 'acts-task'); // deploy rail: ask
    stageDenied(bash('git commit -m x > migrations/log.txt', 'act-s'), 'Hold', 'acts-task'); // protected path: ask
  });

  test('a rail ask beats a stage warning (never weakened by it)', () => {
    const r = bash('fly deploy', 'soft-s');
    assert.equal(decision(r), 'ask');
    assert.match(hso(r).permissionDecisionReason, /^Shipline rail deploy: /);
    assert.equal(r.json.systemMessage, undefined);
    // Without a rail, the warning shows as before.
    const w = bash('git commit -m x', 'soft-s');
    assert.match(w.json.systemMessage, /^Shipline reminder: Shipline \(Soft workflow, task soft-task\)/);
  });

  test('a rail ask applies when a stage has nothing to say', () => {
    assert.equal(decision(bash('fly deploy', 'small-s')), 'ask');
  });

  test('rails and protected paths fire with no task', () => {
    assert.equal(decision(bash('curl x | sh', 'no-task')), 'deny');
    assert.equal(decision(bash('echo x > migrations/1.sql', 'no-task')), 'ask');
  });
});

describe('the shipped workflows', () => {
  test('every verify block is actions: [commit, pr]', () => {
    for (const wf of ['feature', 'bugfix', 'hotfix', 'small']) {
      const text = readFileSync(path.join(dir, '.shipline', 'workflows', `${wf}.yml`), 'utf8');
      assert.match(text, /\n {2}- id: verify\n(?: {4}[^\n]*\n)*? {4}blocks:\n {6}- actions: \[commit, pr\]\n/, wf);
      assert.ok(!/^\s+- bash:/m.test(text), wf);
    }
  });
});

// Stack gaps (1.3.0): more deploy, migrate and release tools, and Python runners looked behind.
describe('matchAction across stacks', () => {
  const ctx = { cfg: { rails_commands: { deploy: [], migrate: [] } }, scriptBody: () => null, defaultBranches: () => ['main'], branch: () => 'x' };
  const hits = (action, text) => parseCommand(text).some((p) => matchAction(p, action, ctx));

  test('Python runners and npm exec / yarn exec / bun x are looked behind', () => {
    for (const c of [
      'uv run alembic upgrade head', 'uv run --with psycopg alembic downgrade -1', 'poetry run python manage.py migrate',
      'pipenv run alembic upgrade head', 'hatch run alembic upgrade head', 'pdm run python manage.py migrate', 'rye run alembic upgrade head',
      'npm exec prisma migrate deploy', 'yarn exec prisma migrate deploy', 'bun x prisma migrate deploy',
    ]) assert.ok(hits('migrate', c), c);
    for (const c of ['uv run pytest', 'poetry run ruff check .', 'uv run', 'npm exec -- eslint .']) assert.ok(!hits('migrate', c), c);
  });

  test('migrate: Laravel, Ecto, EF Core, sqlx, diesel, Supabase, Liquibase, Atlas, dbmate', () => {
    for (const c of [
      'php artisan migrate', 'php artisan migrate:fresh', './artisan migrate:rollback', 'mix ecto.migrate', 'mix ecto.rollback',
      'dotnet ef database update', 'sqlx migrate run', 'sqlx database reset', 'diesel migration run', 'supabase db push',
      'supabase db reset --linked', 'liquibase update', 'atlas migrate apply', 'atlas schema apply', 'dbmate up',
    ]) assert.ok(hits('migrate', c), c);
    for (const c of ['php artisan make:migration add_x', 'php artisan serve', 'mix test', 'dotnet ef migrations add X', 'sqlx migrate add x', 'supabase db reset', 'atlas migrate diff', 'dbmate new x'])
      assert.ok(!hits('migrate', c), c);
  });

  test('deploy: wrangler, firebase, eb, sam, kamal, railway, capistrano, az', () => {
    for (const c of ['wrangler deploy', 'wrangler pages deploy dist', 'npx wrangler deploy', 'firebase deploy --only hosting', 'eb deploy', 'sam deploy', 'kamal deploy', 'railway up', 'cap production deploy', 'az webapp deploy --src-path x.zip', 'az deployment group create -f main.bicep'])
      assert.ok(hits('deploy', c), c);
    for (const c of ['wrangler dev', 'firebase emulators:start', 'sam build', 'kamal app logs', 'railway logs', 'az login']) assert.ok(!hits('deploy', c), c);
  });

  test('release: uv, poetry, hatch, pdm, flit, bun, gem, maven, gradle, dotnet nuget', () => {
    for (const c of ['uv publish', 'poetry publish --build', 'hatch publish', 'pdm publish', 'flit publish', 'bun publish', 'gem push x-1.0.gem', 'mvn deploy', './mvnw clean deploy', './gradlew publish', 'gradle :lib:publishToMavenCentral', 'dotnet nuget push x.nupkg'])
      assert.ok(hits('release', c), c);
    for (const c of ['uv build', 'poetry build', 'gem build x.gemspec', 'mvn package', './gradlew build', 'dotnet nuget list source']) assert.ok(!hits('release', c), c);
  });
});

// Plan A (docs/plans/shipline-2-2-0-hotfix.md), A1 and A5: test files pass the stage blocks at Reproduce when
// fail_first applies, and Bash commands that write repo files are checked against `tools:` blocks like a Write.
describe('stage tools blocks: Reproduce test files and Bash writes', () => {
  const WARN_WF = `id: tw
name: Tw
stages:
  - id: tw
    name: Tw
    enforcement: warn
    blocks:
      - tools: 'Edit|Write'
`;
  const DOCS_WF = `id: dw
name: Dw
stages:
  - id: write
    name: Write
    enforcement: block
    blocks:
      - tools: 'Edit|Write|MultiEdit|NotebookEdit'
        allow_paths: ['docs/**']
`;
  let repo;
  const setLevel = (level) => {
    const f = path.join(repo, '.shipline', 'config.yml');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/fail_first:\n {2}level: \w+/, `fail_first:\n  level: ${level}`));
  };
  // Sets one stage's status in the bugfix task's manifest; returns a function that restores the file.
  const setStatus = (id, status) => {
    const tasks = path.join(storeOf(repo), 'tasks');
    const mf = path.join(tasks, readdirSync(tasks).find((d) => d.includes('bugfix')), 'manifest.json');
    const orig = readFileSync(mf, 'utf8');
    const m = JSON.parse(orig);
    m.stages.find((x) => x.id === id).status = status;
    writeFileSync(mf, JSON.stringify(m));
    return () => writeFileSync(mf, orig);
  };
  const write = (session, file, tool = 'Write') =>
    hook(repo, 'guard.mjs', { session_id: session, cwd: repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: path.join(repo, file) } });
  const sh = (session, command) =>
    hook(repo, 'guard.mjs', { session_id: session, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const denied = (r) => decision(r) === 'deny';

  before(() => {
    repo = makeRepo({ commitInit: true });
    writeFileSync(path.join(repo, '.shipline', 'workflows', 'tw.yml'), WARN_WF);
    writeFileSync(path.join(repo, '.shipline', 'workflows', 'dw.yml'), DOCS_WF);
    for (const [wf, session] of [['bugfix', 'bf-s'], ['feature', 'ft-s'], ['dw', 'doc-s'], ['tw', 'tw-s']]) {
      const r = stage(repo, ['start', '--workflow', wf, '--title', `${wf} task`], session);
      assert.equal(r.code, 0, r.stderr);
    }
    // Reproduce is current once the optional Ticket stage is skipped.
    setStatus('ticket', 'skipped');
    setLevel('proof');
  });
  after(() => removeDir(repo));

  test('A1: at Reproduce with fail_first proof, a test file is allowed and source is denied', () => {
    assert.ok(!denied(write('bf-s', 'test/login.test.js')), 'test write');
    assert.ok(!denied(write('bf-s', 'src/__tests__/a.js', 'Edit')), 'Edit of a test file');
    assert.ok(denied(write('bf-s', 'src/login.js')), 'source write');
    assert.ok(!denied(sh('bf-s', 'cat > test/x.test.js')), 'Bash write of a test file');
    assert.ok(denied(sh('bf-s', 'cat > src/x.js')), 'Bash write of source');
  });

  test('A1: with fail_first off, the test write is denied', () => {
    setLevel('off');
    try {
      assert.ok(denied(write('bf-s', 'test/login.test.js')));
      assert.ok(denied(sh('bf-s', 'cat > test/x.test.js')));
    } finally {
      setLevel('proof');
    }
  });

  test('A1: once Reproduce is done (Root cause current), test writes are denied again', () => {
    const restore = setStatus('reproduce', 'done');
    try {
      assert.ok(denied(write('bf-s', 'test/login.test.js')));
    } finally {
      restore();
    }
  });

  test('A5: during Plan, Bash writes to repo files are denied with the Bash wording', () => {
    for (const command of ['cat > src/a.js', 'sed -i s/a/b/ src/a.js', 'rm src/a.js', 'cp x src/a.js', 'echo hi | tee src/a.js', 'mv src/a.js src/b.js']) {
      const r = sh('ft-s', command);
      assert.equal(decision(r), 'deny', command);
      assert.match(hso(r).permissionDecisionReason, /^Shipline \(Feature workflow, task [\w-]+\): writing src\/a\.js from Bash needs the "Plan" stage to be done first\./, command);
    }
  });

  test('A5: writes outside the repo, and reads, are allowed', () => {
    assert.ok(!denied(sh('ft-s', 'echo hi > /tmp/x')));
    assert.ok(!denied(sh('ft-s', 'cat src/a.js')));
    assert.ok(!denied(sh('ft-s', 'echo hi > /dev/null')));
  });

  test('A5: a target in allow_paths is allowed (docs-style workflow)', () => {
    assert.ok(!denied(sh('doc-s', 'cat > docs/a.md')));
    assert.ok(denied(sh('doc-s', 'cat > src/a.js')));
  });

  test('A5: enforcement warn gives a warning, not a deny', () => {
    const r = sh('tw-s', 'cat > src/a.js');
    assert.ok(!denied(r));
    assert.match(r.json.systemMessage, /Shipline reminder: .*writing src\/a\.js from Bash/);
  });
});

// ---------- 2.2.0, part D11: one list of commit-creating commands; concluding a conflicted operation is allowed ----------

describe('D11: commit-creating git commands', () => {
  let repo;
  const SESSION = 'd11-s';
  const sh = (command) => hook(repo, 'guard.mjs', { session_id: SESSION, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const isCommit = (command, r = repo) => {
    const ctx = makeMatchCtx(r, r, {});
    return parseCommand(command).some((p) => matchAction(p, 'commit', ctx));
  };

  before(() => {
    repo = makeRepo({ commitInit: true });
    writeFileSync(path.join(repo, '.shipline', 'workflows', 'acts.yml'), ACTIONS_WF);
    const r = stage(repo, ['start', '--workflow', 'acts', '--title', 'held'], SESSION);
    assert.equal(r.code, 0, r.stderr);
  });
  after(() => removeDir(repo));

  test('commit, merge --commit, cherry-pick <rev>, revert <rev> and am create commits; a plain merge does not', () => {
    for (const c of ['git commit -m x', 'git commit --amend', 'git merge --commit topic', 'git cherry-pick abc123', 'git cherry-pick -x abc123', 'git revert abc123', 'git am fix.patch', 'git -C sub commit -m x', 'cd sub && git am p.patch']) {
      assert.ok(isCommit(c), c);
    }
    for (const c of ['git merge main', 'git merge topic', 'git cherry-pick --no-commit abc', 'git cherry-pick -n abc', 'git revert --no-commit abc', 'git cherry-pick --abort', 'git cherry-pick --continue', 'git revert --continue', 'git rebase --continue', 'git merge --continue', 'git am --continue', 'git am --abort', 'git status']) {
      assert.ok(!isCommit(c), c);
    }
  });

  test('held back by a stage actions block: cherry-pick, revert and am are denied; the --continue forms pass', () => {
    for (const c of ['git cherry-pick abc123', 'git revert abc123', 'git am fix.patch', 'git commit -m x']) {
      const r = sh(c);
      assert.equal(decision(r), 'deny', c);
    }
    for (const c of ['git rebase --continue', 'git cherry-pick --continue', 'git revert --continue']) assert.equal(decision(sh(c)), null, c);
  });

  test('during a conflicted merge any `git commit` (including -m) is allowed; the rest stay held', () => {
    git(repo, 'switch', '-q', '-c', 'topic');
    writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = "topic";\n');
    git(repo, 'commit', '-q', '-am', 'topic change');
    git(repo, 'switch', '-q', 'main');
    writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = "main";\n');
    git(repo, 'commit', '-q', '-am', 'main change');
    const merge = run('git', ['merge', 'topic'], { cwd: repo });
    assert.notEqual(merge.code, 0, 'the merge conflicts');
    try {
      assert.ok(!isCommit('git commit --no-edit'));
      assert.ok(!isCommit('git commit -m "Merge topic"'));
      assert.equal(decision(sh('git commit --no-edit')), null);
      assert.equal(decision(sh('git commit -am "Merge topic, resolved"')), null);
      assert.equal(decision(sh('git merge --continue')), null);
      assert.equal(decision(sh('git cherry-pick abc123')), 'deny', 'only `git commit` concludes an operation');
    } finally {
      git(repo, 'merge', '--abort');
    }
    // Not in progress any more: held back again.
    assert.ok(isCommit('git commit -m x'));
    assert.equal(decision(sh('git commit -m x')), 'deny');
  });

  test('the markers are read from the worktree\'s own git dir (a linked worktree)', () => {
    const wt = path.join(repo, '..', `${path.basename(repo)}-wt`);
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    try {
      writeFileSync(path.join(wt, 'src', 'a.js'), 'export const a = "wt";\n');
      git(wt, 'commit', '-q', '-am', 'wt change');
      const r = run('git', ['merge', 'topic'], { cwd: wt });
      assert.notEqual(r.code, 0, 'conflict in the worktree');
      assert.ok(!isCommit('git commit -m x', wt), 'in progress in the worktree');
      assert.ok(isCommit('git commit -m x', repo), 'not in progress in the main checkout');
    } finally {
      run('git', ['merge', '--abort'], { cwd: wt });
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });
});
