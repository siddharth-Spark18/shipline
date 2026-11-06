// Teams Phase 3 (docs/plans/shipline-teams-phase3.md), D: named actions in stage blocks (`{ actions: [...] }`), which
// the guard matches on the parsed command, so the usual bypasses are caught; `{ bash: regex }` blocks still work; and
// the order the guard decides in (task store, then rails, then protected paths, then stage blocks; strictest wins).
// Runs the vendored guard on a real temp repo. Node 18+ (test:hooks).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hook, makeRepo, removeDir, stage, storeOf } from './helpers.mjs';
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
