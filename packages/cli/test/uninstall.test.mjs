// Prepublish plan, section A and Tests: `shipline uninstall [dir] [--yes] [--dry-run] [--purge]`. Runs the real
// bin on temp repos (each with its own SHIPLINE_HOME, from helpers.mjs). Node 18+ (runs in test:hooks).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN, FIXTURES, git, makeRepo, removeDir, run, runInitAll, storeOf, tmpDir } from './helpers.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const dirs = [];
after(() => dirs.forEach(removeDir));

const uninstall = (dir, ...flags) => run(process.execPath, [BIN, 'uninstall', dir, ...flags], { cwd: dir });
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const exists = (dir, rel) => existsSync(path.join(dir, rel));

// { relative path: sha256 } of every file under dir (skipping .git), with empty dirs as markers. null when absent.
function tree(dir) {
  if (!existsSync(dir)) return null;
  const out = {};
  const walk = (d) => {
    const entries = readdirSync(d, { withFileTypes: true });
    if (!entries.length && d !== dir) out[path.relative(dir, d) + '/'] = 'dir';
    for (const e of entries) {
      if (e.name === '.git' && d === dir) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = lstatSync(full).isSymbolicLink() ? 'link' : sha(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

// A git repo with one commit and no Shipline yet; prepare(dir) runs before that commit.
function bareRepo(prepare) {
  const dir = makeRepo({ init: false });
  dirs.push(dir);
  if (prepare) {
    prepare(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'team files');
  }
  return dir;
}

// The full install (every workflow and agent), so uninstall has everything to remove.
function initAndCommit(dir) {
  const r = runInitAll(dir);
  assert.equal(r.code, 0, r.stderr);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'shipline init');
}

const writeFile = (dir, rel, text) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

describe('a fresh init', () => {
  test('--yes removes everything init installed: the repo is back to its files before init', () => {
    const dir = bareRepo();
    const before = tree(dir);
    initAndCommit(dir);
    const recorded = Object.keys(readJson(path.join(dir, '.shipline/bin/VERSION')).files).filter((k) => !k.includes('#'));
    assert.ok(recorded.length > 5);
    // A Shipline agent edited by the team is still Shipline's: removed too.
    appendFileSync(path.join(dir, '.claude/agents/builder.md'), '\nTeam tweak.\n');

    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Will remove\n {2}- \.shipline\/ \(config, workflows, rules and hooks\)/);
    assert.match(r.stdout, /^ {2}- \.claude\/agents\/planner\.md$/m);
    assert.match(r.stdout, /^ {2}- \.claude\/skills\/shipline-workflow\/ \(left empty\)$/m);
    assert.match(r.stdout, /~ CLAUDE\.md: remove the Shipline block \(the file is then empty and is deleted\)/);
    assert.match(r.stdout, /~ \.claude\/settings\.json: remove \d+ Shipline hook entries and rules \(the file is then empty and is deleted\)/);
    assert.match(r.stdout, /Removed\. Commit the deletion so teammates no longer get Shipline\./);
    assert.match(r.stdout, /hook warnings until it is restarted/);

    for (const rel of recorded) assert.ok(!exists(dir, rel), rel);
    assert.ok(!exists(dir, '.shipline'));
    assert.ok(!exists(dir, '.claude'), '.claude/ is left empty and removed');
    assert.ok(!exists(dir, 'CLAUDE.md'));
    assert.deepEqual(tree(dir), before);
  });

  test('only deletes files: nothing is staged or committed', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    const head = git(dir, 'rev-parse', 'HEAD');
    assert.equal(uninstall(dir, '--yes').code, 0);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
    const status = git(dir, 'status', '--porcelain').split('\n');
    assert.ok(status.length > 5);
    for (const line of status) assert.match(line, /^ ?D /, line); // git() trims the first line's leading space
  });
});

describe('the team\'s own files', () => {
  test('a file recorded in VERSION.excluded (an own agent kept on a clash) is kept; other team agents and skills too', () => {
    const dir = bareRepo((d) => {
      writeFile(d, '.claude/agents/planner.md', '# Our planner\n');
      writeFile(d, '.claude/agents/mine.md', '# Our own agent\n');
      writeFile(d, '.claude/skills/deploy/SKILL.md', '# Deploy\n');
    });
    initAndCommit(dir);
    assert.deepEqual(readJson(path.join(dir, '.shipline/bin/VERSION')).excluded, ['.claude/agents/planner.md']);
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Kept \(your own, recorded in VERSION\.excluded\)\n {2}= \.claude\/agents\/planner\.md/);
    assert.ok(!/- \.claude\/agents\/planner\.md/.test(r.stdout));
    assert.equal(read(dir, '.claude/agents/planner.md'), '# Our planner\n');
    assert.equal(read(dir, '.claude/agents/mine.md'), '# Our own agent\n');
    assert.equal(read(dir, '.claude/skills/deploy/SKILL.md'), '# Deploy\n');
    assert.deepEqual(readdirSync(path.join(dir, '.claude/agents')).sort(), ['mine.md', 'planner.md']);
    assert.deepEqual(readdirSync(path.join(dir, '.claude/skills')), ['deploy']);
  });

  test('CLAUDE.md and settings.json keep the team\'s other content', () => {
    const teamMd = '# Team\n\nBe kind to each other.\n';
    const teamSettings = {
      env: { FOO: '1' },
      permissions: { allow: ['Bash(ls:*)'], deny: ['Edit(.env)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo team' }] }] },
    };
    const dir = bareRepo((d) => {
      writeFile(d, 'CLAUDE.md', teamMd);
      writeFile(d, '.claude/settings.json', JSON.stringify(teamSettings, null, 2) + '\n');
    });
    initAndCommit(dir);
    // The team adds more after init, too.
    appendFileSync(path.join(dir, 'CLAUDE.md'), '\n## Later notes\nShip small.\n');
    const s = readJson(path.join(dir, '.claude/settings.json'));
    s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo bye' }] }];
    writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify(s, null, 2));

    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(dir, 'CLAUDE.md'), teamMd + '\n## Later notes\nShip small.\n');
    assert.ok(!read(dir, 'CLAUDE.md').includes('shipline:start'));
    assert.deepEqual(readJson(path.join(dir, '.claude/settings.json')), {
      ...teamSettings,
      hooks: { ...teamSettings.hooks, Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
    });
  });

  test('CLAUDE.md with its markers removed by hand is left alone, and the preview says so', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rewritten by the team\n');
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /CLAUDE\.md has no Shipline markers \(removed by hand\?\); left as it is/);
    assert.equal(read(dir, 'CLAUDE.md'), '# Rewritten by the team\n');
  });
});

describe('--dry-run', () => {
  test('previews and writes nothing (repo or store)', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    const before = { files: tree(dir), store: tree(storeOf(dir)) };
    const r = uninstall(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Will remove/);
    assert.match(r.stdout, /Task data for this repo \(asked about separately\): .+ \(\d+(\.\d+)? (B|KB|MB)\)/);
    assert.match(r.stdout, /Dry run, nothing written\./);
    assert.deepEqual({ files: tree(dir), store: tree(storeOf(dir)) }, before);
    // --yes with --dry-run still writes nothing.
    assert.equal(uninstall(dir, '--dry-run', '--yes', '--purge').code, 0);
    assert.deepEqual({ files: tree(dir), store: tree(storeOf(dir)) }, before);
  });
});

describe('the task data (store)', () => {
  test('--yes keeps it and says where', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    const store = storeOf(dir);
    assert.ok(existsSync(store));
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(store));
    assert.ok(r.stdout.includes(`Task data was kept at ${store}.`), r.stdout);
  });

  test('--yes --purge removes it', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    const store = storeOf(dir);
    const r = uninstall(dir, '--yes', '--purge');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(store));
    assert.ok(!r.stdout.includes('Task data was kept'));
  });
});

describe('refusals (nothing is changed)', () => {
  test('no terminal and no --yes', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    const before = { files: tree(dir), store: tree(storeOf(dir)) };
    const r = uninstall(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a terminal.*--yes/s);
    assert.deepEqual({ files: tree(dir), store: tree(storeOf(dir)) }, before);
  });

  test('a live UI lock on this host', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    // This test process is alive, so the lock counts as held.
    writeFile(storeOf(dir), 'ui/lock.json', JSON.stringify({ pid: process.pid, hostname: os.hostname(), port: 4321 }));
    const before = { files: tree(dir), store: tree(storeOf(dir)) };
    const r = uninstall(dir, '--yes', '--purge');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Stop the Shipline UI for this repo first \(port 4321\)/);
    assert.deepEqual({ files: tree(dir), store: tree(storeOf(dir)) }, before);
  });

  test('a stale lock (dead process, or another host) is only noted', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFile(storeOf(dir), 'ui/lock.json', JSON.stringify({ pid: dead, hostname: os.hostname(), port: 4321 }));
    const r = uninstall(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /a stale UI lock was found/);
    writeFile(storeOf(dir), 'ui/lock.json', JSON.stringify({ pid: process.pid, hostname: `not-${os.hostname()}`, port: 4321 }));
    const r2 = uninstall(dir, '--yes');
    assert.equal(r2.code, 0, r2.stderr);
    assert.ok(!exists(dir, '.shipline'));
  });

  test('Shipline is not installed', () => {
    const dir = bareRepo();
    const before = tree(dir);
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Shipline is not installed here/);
    assert.deepEqual(tree(dir), before);
  });

  test('a .claude/settings.json that is not valid JSON', () => {
    const dir = bareRepo();
    initAndCommit(dir);
    writeFileSync(path.join(dir, '.claude/settings.json'), '{ not json');
    const before = tree(dir);
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Fix \.claude\/settings\.json first/);
    assert.deepEqual(tree(dir), before);
  });
});

describe('a legacy install', () => {
  // brown-bg-tracker's 0.6.0 files (test/fixtures/legacy-0.6), team content in CLAUDE.md (@AGENTS.md) and
  // settings.json (deny rules) included.
  function legacy({ keepVersion = false } = {}) {
    const dir = tmpDir();
    dirs.push(dir);
    writeFileSync(path.join(dir, 'README.md'), '# app\n');
    cpSync(path.join(FIXTURES, 'legacy-0.6'), dir, { recursive: true });
    if (!keepVersion) rmSync(path.join(dir, '.shipline/bin/VERSION'));
    return dir;
  }
  const legacySettings = () => readJson(path.join(FIXTURES, 'legacy-0.6', '.claude/settings.json'));

  test('with no VERSION: uses the template inventory plus .claude/skills/shipline-*', () => {
    const dir = legacy();
    writeFile(dir, '.claude/agents/mine.md', '# ours\n');
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no \.shipline\/bin\/VERSION: using Shipline's template inventory/);
    assert.ok(!exists(dir, '.shipline'));
    assert.deepEqual(readdirSync(path.join(dir, '.claude/agents')), ['mine.md']);
    assert.ok(!exists(dir, '.claude/skills'));
    assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    assert.deepEqual(readJson(path.join(dir, '.claude/settings.json')), { permissions: legacySettings().permissions });
    assert.equal(read(dir, 'README.md'), '# app\n');
  });

  test('a 0.6.0 VERSION (no files map) removes the agents and skills too', () => {
    const dir = legacy({ keepVersion: true });
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!exists(dir, '.shipline'));
    assert.ok(!exists(dir, '.claude/agents/planner.md'), 'Shipline agent left behind');
    assert.ok(!exists(dir, '.claude/skills/shipline-workflow'), 'Shipline skill left behind');
  });
});

// Trust plan, Surface Area: uninstall removes .github/workflows/shipline.yml only when VERSION.files recorded it
// and the file is still what Shipline wrote.
describe('the CI workflow', () => {
  const CI = '.github/workflows/shipline.yml';
  const template = () => readFileSync(path.join(FIXTURES, '..', '..', 'templates', 'github', 'shipline.yml'));

  // init with the CI opt-in, as interactive init writes it: the template file plus its hash in VERSION.files.
  function ciRepo({ record = true, other = false } = {}) {
    const dir = bareRepo(other ? (d) => writeFile(d, '.github/workflows/test.yml', 'name: tests\n') : undefined);
    initAndCommit(dir);
    writeFile(dir, CI, template());
    if (record) {
      const vf = path.join(dir, '.shipline/bin/VERSION');
      const v = readJson(vf);
      v.files[CI] = sha(template());
      writeFileSync(vf, JSON.stringify(v, null, 2) + '\n');
    }
    return dir;
  }

  test('recorded and unedited: removed, with the empty .github/ folders', () => {
    const dir = ciRepo();
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}- \.github\/workflows\/shipline\.yml$/m);
    assert.ok(!exists(dir, CI));
    assert.ok(!exists(dir, '.github'));
  });

  test('recorded, next to the team\'s own workflows: only Shipline\'s file goes', () => {
    const dir = ciRepo({ other: true });
    assert.equal(uninstall(dir, '--yes').code, 0);
    assert.ok(!exists(dir, CI));
    assert.equal(read(dir, '.github/workflows/test.yml'), 'name: tests\n');
  });

  test('recorded but edited by the team: kept, and the preview says so', () => {
    const dir = ciRepo();
    appendFileSync(path.join(dir, CI), '      - run: npm test\n');
    const edited = read(dir, CI);
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/- \.github\/workflows\/shipline\.yml/.test(r.stdout));
    assert.match(r.stdout, /! \.github\/workflows\/shipline\.yml was edited since Shipline wrote it; left as it is/);
    assert.equal(read(dir, CI), edited);
  });

  test('not recorded in VERSION.files (the team\'s own file with the same name): kept', () => {
    const dir = ciRepo({ record: false });
    const r = uninstall(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('.github/workflows/shipline.yml'));
    assert.ok(read(dir, CI).length > 0);
  });

  test('--dry-run lists it and removes nothing', () => {
    const dir = ciRepo();
    const r = uninstall(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}- \.github\/workflows\/shipline\.yml$/m);
    assert.ok(exists(dir, CI));
  });
});
