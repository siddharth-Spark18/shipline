// Teams Phase 3 (docs/plans/shipline-teams-phase3.md), C: protected_paths in config.yml. A file tool or a Bash write
// (bashWriteTargets) on a matching path asks, in any stage and with or without a task. Runs the vendored guard on a
// real temp repo, plus bashWriteTargets directly. Node 18+ (test:hooks).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hook, makeRepo, removeDir, stage } from './helpers.mjs';
import { bashWriteTargets, loadConfig, makeMatchCtx, parseCommand } from '../templates/shipline/bin/lib.mjs';

// warn on Edit|Write until `draft` is done, then `ship` blocks commits.
const WARN_WORKFLOW = `id: pp
name: PP
stages:
  - id: draft
    name: Draft
    enforcement: warn
    blocks:
      - tools: 'Edit|Write'
  - id: ship
    name: Ship
    enforcement: block
    blocks:
      - actions: [commit]
`;

let dir;
let configText;
const protectedReason = (rel) => `Shipline: ${rel} is protected in this repo (protected_paths in .shipline/config.yml)`;

const edit = (file, session = 'pp-none', tool = 'Edit') =>
  hook(dir, 'guard.mjs', {
    session_id: session,
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { file_path: path.isAbsolute(file) ? file : path.join(dir, file), old_string: 'a', new_string: 'b' },
  });
const bash = (command, session = 'pp-none', cwd = dir) => hook(dir, 'guard.mjs', { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const hso = (r) => (r.json && r.json.hookSpecificOutput) || null;
const asksFor = (r, rel) => {
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(hso(r), { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: protectedReason(rel) });
};
function setProtected(list) {
  const re = /\nprotected_paths:\n(?: {2}- [^\n]*\n)+/;
  assert.match(configText, re, 'the shipped config has a protected_paths block list');
  const body = list === null ? '' : list.length ? `\nprotected_paths:\n${list.map((g) => `  - '${g}'`).join('\n')}\n` : '\nprotected_paths: []\n';
  writeFileSync(path.join(dir, '.shipline', 'config.yml'), configText.replace(re, body || '\n'));
}

before(() => {
  dir = makeRepo({ commitInit: true });
  configText = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
  writeFileSync(path.join(dir, '.shipline', 'workflows', 'pp.yml'), WARN_WORKFLOW);
  assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'pp small'], 'pp-small').code, 0);
  assert.equal(stage(dir, ['start', '--workflow', 'pp', '--title', 'pp warn'], 'pp-warn').code, 0);
});
after(() => removeDir(dir));

describe('file tools', () => {
  test('the shipped list: Edit on migrations/001.sql asks with no task', () => {
    setProtected(loadDefaults());
    assert.ok(loadDefaults().includes('migrations/**'));
    asksFor(edit('migrations/001.sql'), 'migrations/001.sql');
  });

  test('in any stage: a task in a guide stage, and a warn stage (the ask wins over the warning)', () => {
    asksFor(edit('migrations/001.sql', 'pp-small'), 'migrations/001.sql');
    const r = edit('migrations/001.sql', 'pp-warn');
    asksFor(r, 'migrations/001.sql');
    assert.equal(r.json.systemMessage, undefined, 'a stage warning never weakens the ask');
    // The same stage's warning still shows for an unprotected file.
    assert.match(edit('src/a.js', 'pp-warn').json.systemMessage, /^Shipline reminder: /);
  });

  test('Write, MultiEdit and NotebookEdit too; globs from the shipped list', () => {
    for (const [tool, rel] of [
      ['Write', '.github/workflows/ci.yml'],
      ['MultiEdit', 'infra/main.tf'],
      ['NotebookEdit', 'terraform/x.ipynb'],
      ['Write', 'modules/net/vpc.tf'],
      ['Write', 'services/api/Dockerfile.prod'],
      ['Write', 'docker-compose.yml'],
      ['Write', 'pnpm-lock.yaml'],
      ['Write', 'db/migrate/20240101_add.rb'],
    ]) {
      asksFor(edit(rel, 'pp-none', tool), rel);
    }
  });

  test('a path given relative to the hook cwd is matched repo-relative', () => {
    const r = hook(dir, 'guard.mjs', { session_id: 'pp-none', cwd: path.join(dir, 'migrations'), tool_name: 'Edit', tool_input: { file_path: '002.sql' } });
    asksFor(r, 'migrations/002.sql');
  });

  test('non-matching paths are untouched', () => {
    for (const rel of ['src/a.js', 'src/migrations.js', 'docs/infra.md', 'README.md', 'package.json']) {
      assert.equal(edit(rel).stdout, '', rel);
    }
  });

  test('.claude/ and .shipline/ belong to the agent_config rail, not protected_paths', () => {
    setProtected(['**']);
    const r = edit('.claude/settings.json');
    assert.equal(hso(r).permissionDecision, 'ask');
    assert.match(hso(r).permissionDecisionReason, /^Shipline rail agent_config: /);
    setProtected(loadDefaults());
  });

  test('files outside the repo are never protected paths', () => {
    setProtected(['**']);
    assert.equal(edit(path.join(os.tmpdir(), 'outside', 'migrations', 'x.sql')).stdout, '');
    setProtected(loadDefaults());
  });
});

describe('Bash writes', () => {
  test('echo x > .github/workflows/a.yml and sed -i … go.sum ask', () => {
    asksFor(bash('echo x > .github/workflows/a.yml'), '.github/workflows/a.yml');
    asksFor(bash("sed -i 's/a/b/' go.sum"), 'go.sum');
    asksFor(bash("sed -i.bak -e 's/a/b/' go.sum"), 'go.sum');
  });

  test('>>, tee, mv, cp and rm targets; a cd before the write is followed', () => {
    asksFor(bash('echo x >> yarn.lock'), 'yarn.lock');
    asksFor(bash('echo x | tee -a k8s/deploy.yml'), 'k8s/deploy.yml');
    asksFor(bash('mv tmp.sql migrations/003.sql'), 'migrations/003.sql');
    asksFor(bash('mv migrations/003.sql tmp.sql'), 'migrations/003.sql');
    asksFor(bash('cp tmp.sql migrations/004.sql'), 'migrations/004.sql');
    asksFor(bash('rm -rf helm/charts'), 'helm/charts');
    asksFor(bash('cd migrations && echo x > 005.sql'), 'migrations/005.sql');
    asksFor(bash('echo x > 006.sql', 'pp-none', path.join(dir, 'migrations')), 'migrations/006.sql');
  });

  test('reads and unrelated writes are untouched', () => {
    for (const command of ['cat migrations/001.sql', 'cp migrations/001.sql /tmp/x.sql', 'echo x > src/b.js', 'git diff go.sum', 'ls infra', 'echo x 2>&1']) {
      assert.equal(bash(command).stdout, '', command);
    }
  });
});

describe('the list', () => {
  test('an empty list does nothing', () => {
    setProtected([]);
    assert.deepEqual(loadConfig(dir).protected_paths, []);
    assert.equal(edit('migrations/001.sql').stdout, '');
    assert.equal(bash('echo x > .github/workflows/a.yml').stdout, '');
  });

  test('no protected_paths key does nothing either', () => {
    setProtected(null);
    assert.ok(!/^protected_paths:/m.test(readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8')));
    assert.equal(edit('migrations/001.sql').stdout, '');
  });

  test('a team glob', () => {
    setProtected(['src/generated/**', '**/*.sql']);
    asksFor(edit('src/generated/api.ts'), 'src/generated/api.ts');
    asksFor(edit('db/seed.sql'), 'db/seed.sql');
    assert.equal(edit('src/a.js').stdout, '');
    setProtected(loadDefaults());
  });
});

describe('bashWriteTargets(parts, ctx)', () => {
  test('repo-relative targets with forward slashes; outside the repo absolute; /dev/* ignored', () => {
    const ctx = makeMatchCtx(dir, dir, loadConfig(dir));
    const t = (command) => bashWriteTargets(parseCommand(command), ctx);
    assert.deepEqual(t('echo a > x.txt; echo b >> sub/y.txt'), ['x.txt', 'sub/y.txt']);
    assert.deepEqual(t('cmd > /dev/null 2>&1'), []);
    assert.deepEqual(t('tee a b'), ['a', 'b']);
    assert.deepEqual(t("sed -i 's/x/y/' a.txt b.txt"), ['a.txt', 'b.txt']);
    assert.deepEqual(t("sed -e 's/x/y/' a.txt"), [], 'sed without -i writes nothing');
    assert.deepEqual(t('mv -f a b'), ['a', 'b']);
    assert.deepEqual(t('cp a b c dest'), ['dest']);
    assert.deepEqual(t('cp -t dest a b'), ['dest']);
    assert.deepEqual(t('rm -r a b'), ['a', 'b']);
    assert.deepEqual(t('cd sub && rm x'), ['sub/x']);
    const outside = path.join(os.tmpdir(), 'elsewhere.txt');
    assert.deepEqual(t(`echo x > "${outside}"`), [path.resolve(outside)]);
  });
});

// The shipped default list, read from the template config.
function loadDefaults() {
  const m = /\nprotected_paths:\n((?: {2}- [^\n]*\n)+)/.exec(configText);
  return m[1]
    .trim()
    .split('\n')
    .map((l) => l.replace(/^ *- /, '').replace(/^'(.*)'$/, '$1'));
}
