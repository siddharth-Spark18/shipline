// Phase 1 plan, section C and Tests: `shipline upgrade`. Runs the real bin on temp repos. The legacy repos are
// built from test/fixtures/legacy-0.6/ (brown-bg-tracker's vendored Shipline files, byte-identical to 0.6.0 at
// a67ddf6, no task data), with tasks created by that repo's own 0.6.0 stage.mjs, so the migration sees the real
// old layout: docs/shipline/<task>/ and .shipline/.state/ with repo-relative task_dir values. Node 18+.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BIN, CLI_ROOT, FIXTURES, git, makeRepo, removeDir, run, stage, storeOf, tmpDir } from './helpers.mjs';

const LEGACY = path.join(FIXTURES, 'legacy-0.6');
const TEMPLATES_ROOT = path.join(CLI_ROOT, 'templates');
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const dirs = [];
after(() => dirs.forEach(removeDir));

// ---------- helpers ----------

const upgrade = (dir, ...flags) => run(process.execPath, [BIN, 'upgrade', dir, ...flags], { cwd: dir });
const legacyStage = (dir, ...args) => {
  const r = run(process.execPath, [path.join(dir, '.shipline', 'bin', 'stage.mjs'), ...args], { cwd: dir });
  assert.equal(r.code, 0, `0.6.0 stage.mjs ${args.join(' ')}: ${r.stderr}`);
  return r;
};
const read = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const version = (dir) => readJson(path.join(dir, '.shipline', 'bin', 'VERSION'));
const template = (to) =>
  readFileSync(path.join(TEMPLATES_ROOT, to.startsWith('.shipline/') ? 'shipline' : 'claude', to.replace(/^\.(shipline|claude)\//, '')));

// { relative path: sha256 } of every file under dir (skipping .git), plus symlinks and empty dirs as markers.
function tree(dir) {
  const out = {};
  if (!existsSync(dir)) return null;
  const walk = (d) => {
    const entries = readdirSync(d, { withFileTypes: true });
    if (!entries.length) out[path.relative(dir, d) + '/'] = 'dir';
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

// Everything upgrade could touch: the working tree, the index, HEAD, and the store.
function snapshot(dir, { withGit = true } = {}) {
  return {
    files: tree(dir),
    store: tree(storeOf(dir)),
    index: withGit ? git(dir, 'status', '--porcelain', '--untracked-files=all') : null,
    head: withGit ? git(dir, 'rev-parse', 'HEAD') : null,
  };
}

const ago = (file, ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

// A repo with brown-bg-tracker's 0.6.0 Shipline files, plus (by default) task data made by its own stage.mjs:
//   docs/shipline/LL-12-add-export/ (feature, jira done, ticket.md), bound to session s1
//   docs/shipline/fix-crash/        (bugfix), bound to session s2
//   docs/shipline/PROJ-7_custom/    (a folder name an old custom folder_pattern made)
//   docs/shipline/README.md         (not a task folder: left in place)
//   .shipline/.state/ui/{sessions.json, tmp/scratch.txt}, .shipline/.state/ui.log
// Everything except .shipline/.state (gitignored by 0.6.0) is committed. State files are aged past 30 minutes.
function legacyRepo({ withGit = true, tasks = true, prepare } = {}) {
  const dir = tmpDir();
  dirs.push(dir);
  if (withGit) {
    git(dir, 'init', '-q');
    git(dir, 'checkout', '-q', '-b', 'main');
    git(dir, 'config', 'commit.gpgsign', 'false');
  }
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  cpSync(LEGACY, dir, { recursive: true });
  if (prepare) prepare(dir);
  if (tasks) {
    legacyStage(dir, 'start', '--workflow', 'feature', '--title', 'Add export', '--ticket', 'll-12', '--session', 's1');
    const root = readArtifactRoot(dir);
    writeFileSync(path.join(dir, root, 'LL-12-add-export', 'ticket.md'), '# LL-12\n');
    legacyStage(dir, 'advance', '--session', 's1');
    legacyStage(dir, 'start', '--workflow', 'bugfix', '--title', 'Fix crash', '--session', 's2');
    cpSync(path.join(dir, root, 'fix-crash'), path.join(dir, root, 'PROJ-7_custom'), { recursive: true });
    writeFileSync(path.join(dir, root, 'README.md'), 'Task folders live here.\n');
    const ui = path.join(dir, '.shipline', '.state', 'ui');
    mkdirSync(path.join(ui, 'tmp'), { recursive: true });
    writeFileSync(path.join(ui, 'tmp', 'scratch.txt'), 'x\n');
    const now = new Date().toISOString();
    writeFileSync(
      path.join(ui, 'sessions.json'),
      JSON.stringify([
        { id: 'c1', title: 'chat', created: now, last_active: now, task_dir: `${root}/fix-crash`, status: 'ended' },
        { id: 'c2', title: 'no task', created: now, last_active: now, task_dir: null, status: 'ended' },
      ]),
    );
    writeFileSync(path.join(dir, '.shipline', '.state', 'ui.log'), '{"event":"start"}\n');
    for (const f of readdirSync(path.join(dir, '.shipline', '.state'))) {
      const full = path.join(dir, '.shipline', '.state', f);
      if (lstatSync(full).isFile()) ago(full, 2 * 60 * 60 * 1000);
    }
  }
  if (withGit) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'legacy shipline 0.6.0');
  }
  return dir;
}

function readArtifactRoot(dir) {
  const m = /^artifact_root:\s*(\S+)/m.exec(read(dir, '.shipline/config.yml'));
  return m ? m[1] : 'docs/shipline';
}

// ---------- refusals ----------

describe('refusals', () => {
  test('a repo newer than the CLI is refused and nothing changes', () => {
    for (const v of [{ package: '9.9.9', interface: 3 }, { package: '1.0.0', interface: 99 }]) {
      const dir = makeRepo({ commitInit: true });
      dirs.push(dir);
      writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify(v) + '\n');
      const before = snapshot(dir);
      const r = upgrade(dir, '--yes');
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, new RegExp(`set up with Shipline ${v.package.replace(/\./g, '\\.')}, which is newer than this CLI \\(${PACKAGE_VERSION.replace(/\./g, '\\.')}\\)`));
      assert.match(r.stderr, new RegExp(`npx @forgeyard/shipline@${v.package.replace(/\./g, '\\.')}`));
      assert.match(r.stderr, /Nothing was changed/);
      assert.deepEqual(snapshot(dir), before);
    }
  });

  test('no .shipline/ says to run init', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no \.shipline\/ found here\. Run `npx @forgeyard\/shipline init` first\./);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('a target that is not a directory is refused', () => {
    const dir = tmpDir();
    dirs.push(dir);
    const r = run(process.execPath, [BIN, 'upgrade', path.join(dir, 'nope'), '--yes'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a directory/);
  });

  test('without a TTY and without --yes it refuses, and nothing is written', () => {
    const dir = legacyRepo();
    const before = snapshot(dir);
    const r = upgrade(dir); // stdin is a pipe here, not a terminal
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Shipline upgrade for /, 'the preview is still shown');
    assert.match(r.stderr, /not a terminal, so there is nobody to confirm\. Re-run with --yes to apply, or --dry-run to preview\./);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(before.store, null, 'the store was not created');
  });
});

// ---------- already up to date ----------

describe('a fresh interface-3 install', () => {
  test('is "Already up to date." and nothing is written', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const before = snapshot(dir);
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Already up to date.\n');
    assert.deepEqual(snapshot(dir), before);
  });

  test('team additions outside Shipline\'s parts (other hooks, allow rules, CLAUDE.md text) are not edits', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const sf = path.join(dir, '.claude', 'settings.json');
    const s = readJson(sf);
    s.permissions.allow.unshift('Bash(npm test:*)');
    s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo team' }] });
    s.env = { FOO: '1' };
    writeFileSync(sf, JSON.stringify(s, null, 2));
    appendFileSync(path.join(dir, 'CLAUDE.md'), '\n## Team notes\nBe nice.\n');
    git(dir, 'commit', '-q', '-am', 'team edits');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Already up to date.\n');
  });
});

// Prepublish plan: VERSION.excluded lists Shipline agent paths the team doesn't have from Shipline (deselected,
// skipped, or their own file kept on a name clash). upgrade never adds, replaces or removes them, and keeps the list.
describe('VERSION.excluded', () => {
  // A fresh install where researcher was deselected (no file) and planner.md is the team's own (kept on a clash).
  function excludedRepo() {
    const dir = makeRepo();
    dirs.push(dir);
    rmSync(path.join(dir, '.claude/agents/researcher.md'));
    writeFileSync(path.join(dir, '.claude/agents/planner.md'), '# Our own planner\n');
    const v = version(dir);
    delete v.files['.claude/agents/researcher.md'];
    delete v.files['.claude/agents/planner.md'];
    v.excluded = ['.claude/agents/planner.md', '.claude/agents/researcher.md'];
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'shipline init (with exclusions)');
    return dir;
  }

  test('an excluded path is never added or replaced, even with --force: "Already up to date."', () => {
    const dir = excludedRepo();
    const before = snapshot(dir);
    for (const flags of [['--yes'], ['--yes', '--force']]) {
      const r = upgrade(dir, ...flags);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'Already up to date.\n', flags.join(' '));
    }
    assert.deepEqual(snapshot(dir), before);
    assert.ok(!existsSync(path.join(dir, '.claude/agents/researcher.md')));
    assert.equal(read(dir, '.claude/agents/planner.md'), '# Our own planner\n');
  });

  test('a real upgrade keeps excluded in the new VERSION and still skips those paths', () => {
    const dir = excludedRepo();
    const old = '// stage.mjs from an older release\n';
    writeFileSync(path.join(dir, '.shipline/bin/stage.mjs'), old);
    const v = version(dir);
    v.files['.shipline/bin/stage.mjs'] = sha(old);
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const r = upgrade(dir, '--yes', '--force');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('  ~ replace  .shipline/bin/stage.mjs\n'), r.stdout);
    assert.ok(!r.stdout.includes('researcher.md'), r.stdout);
    assert.ok(!r.stdout.includes('planner.md'), r.stdout);
    assert.equal(read(dir, '.claude/agents/planner.md'), '# Our own planner\n');
    assert.ok(!existsSync(path.join(dir, '.claude/agents/researcher.md')));
    const after = version(dir);
    assert.deepEqual(after.excluded, ['.claude/agents/planner.md', '.claude/agents/researcher.md']);
    assert.ok(!('.claude/agents/planner.md' in after.files));
    assert.ok(!('.claude/agents/researcher.md' in after.files));
    assert.equal(after.files['.shipline/bin/stage.mjs'], sha(template('.shipline/bin/stage.mjs')));
  });

  test('an excluded path that a VERSION.files record still lists is not removed as "no longer shipped"', () => {
    const dir = excludedRepo();
    const v = version(dir);
    writeFileSync(path.join(dir, '.claude/agents/retired.md'), 'team agent\n');
    v.files['.claude/agents/retired.md'] = sha('team agent\n');
    v.excluded = [...v.excluded, '.claude/agents/retired.md'];
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('remove   .claude/agents/retired.md'), r.stdout);
    assert.equal(read(dir, '.claude/agents/retired.md'), 'team agent\n');
  });

  test('a config.yml with skills is left alone by upgrade', () => {
    const dir = makeRepo();
    dirs.push(dir);
    const cfg = read(dir, '.shipline/config.yml').replace('skills: []', 'skills: [deploy]');
    writeFileSync(path.join(dir, '.shipline/config.yml'), cfg);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const r = upgrade(dir, '--yes', '--force');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Already up to date.\n');
    assert.equal(read(dir, '.shipline/config.yml'), cfg);
  });
});

// ---------- the main legacy migration ----------

describe('upgrading a 0.6.0 repo (no VERSION.files: matched through known-hashes.json)', () => {
  let dir;
  let r;
  let store;
  let orig; // task trees and committed text before the upgrade
  const TASKS = ['LL-12-add-export', 'PROJ-7_custom', 'fix-crash'];

  before(() => {
    dir = legacyRepo({
      prepare: (d) => {
        // Team content that must survive the config and workflow edits.
        const cfg = read(d, '.shipline/config.yml').replace('  test: ""', '  test: pnpm test');
        writeFileSync(path.join(d, '.shipline/config.yml'), cfg + '\n# team: keep this repo tidy\nteam_owner: platform\n');
        const wf = read(d, '.shipline/workflows/feature.yml')
          .replace('allow_paths: ["{artifact_root}/**"]', 'allow_paths: ["{artifact_root}/**", "docs/**"]')
          .replace('name: Feature\n', 'name: Feature\nowner: platform\n');
        writeFileSync(path.join(d, '.shipline/workflows/feature.yml'), wf);
      },
    });
    store = storeOf(dir);
    orig = {
      tasks: Object.fromEntries(TASKS.map((t) => [t, tree(path.join(dir, 'docs/shipline', t))])),
      rules: tree(path.join(dir, '.shipline/rules')),
      hotfix: read(dir, '.shipline/workflows/hotfix.yml'),
      head: git(dir, 'rev-parse', 'HEAD'),
      settings: readJson(path.join(dir, '.claude/settings.json')),
    };
    r = upgrade(dir, '--yes');
  });

  test('exits 0 and prints the preview, then the next steps', () => {
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const out = r.stdout;
    assert.match(out, new RegExp(`^Shipline upgrade for ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(out, new RegExp(`repo: 0\\.6\\.0 \\(interface 2\\) -> ${PACKAGE_VERSION.replace(/\./g, '\\.')} \\(interface 3\\)`));
    for (const f of ['.shipline/bin/guard.mjs', '.shipline/bin/lib.mjs', '.shipline/bin/stage.mjs', '.shipline/bin/session-start.mjs', '.claude/agents/planner.md', '.claude/skills/shipline-workflow/SKILL.md']) {
      assert.ok(out.includes(`  ~ replace  ${f}\n`), f);
    }
    assert.ok(!out.includes('! skip'), 'a 0.6.0 file is never treated as edited');
    assert.ok(!out.includes('(edited, --force)'));
    assert.match(out, /CLAUDE\.md block: replace/);
    assert.match(out, /\.claude\/settings\.json \(hook entries, allow rules for ~\/\.shipline\): replace/);
    assert.match(out, /~ \.shipline\/config\.yml: remove artifact_root, folder_pattern/);
    assert.match(out, /~ \.shipline\/workflows\/feature\.yml: remove 1 \{artifact_root\} allow_paths entry/);
    assert.match(out, /~ \.shipline\/workflows\/bugfix\.yml: remove 1 \{artifact_root\} allow_paths entry/);
    assert.ok(!out.includes('hotfix.yml'));
    assert.ok(out.includes(`Task data -> ${store}`));
    for (const t of TASKS) assert.ok(out.includes(`  move task docs/shipline/${t}/ -> tasks/${t}/ (git rm staged afterwards)`), t);
    assert.match(out, /move \d+ item\(s\) from \.shipline\/\.state\/ \(session state, UI data\); the folder is then removed/);
    assert.match(out, /left in place \(not task folders\): docs\/shipline\/README\.md/);
    assert.ok(!out.includes('Warnings'), 'the aged sessions are not reported as running');
    assert.ok(out.includes(`Upgraded to ${PACKAGE_VERSION} (interface 3). Moved 3 task(s) to ${store}.`));
    assert.match(out, /review and commit the changes \(the removal of the old task folders is staged, not committed\)/);
    assert.match(out, /restart any running Claude Code sessions/);
  });

  test('tasks are copied to the store byte-for-byte, folder names unchanged (custom ones too)', () => {
    assert.deepEqual(readdirSync(path.join(store, 'tasks')).sort(), [...TASKS].sort());
    for (const t of TASKS) assert.deepEqual(tree(path.join(store, 'tasks', t)), orig.tasks[t], t);
    assert.equal(readJson(path.join(store, 'repo.json')).root, dir);
  });

  test('the old task folders are gone from disk and their removal is staged, not committed; README.md stays', () => {
    for (const t of TASKS) assert.ok(!existsSync(path.join(dir, 'docs/shipline', t)), t);
    assert.equal(read(dir, 'docs/shipline/README.md'), 'Task folders live here.\n');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), orig.head, 'upgrade never commits');
    const staged = git(dir, 'diff', '--cached', '--name-status').split('\n');
    const deleted = staged.filter((l) => l.startsWith('D\t')).map((l) => l.slice(2)).sort();
    const expected = TASKS.flatMap((t) => Object.keys(orig.tasks[t]).map((f) => `docs/shipline/${t}/${f}`)).sort();
    assert.deepEqual(deleted, expected);
    assert.ok(staged.every((l) => l.startsWith('D\t')), `only the removals are staged: ${staged.join(', ')}`);
  });

  test('.shipline/.state is moved (state/, ui/) and removed; ui/tmp is not moved; .shipline/.gitignore is left alone', () => {
    assert.ok(!existsSync(path.join(dir, '.shipline', '.state')));
    assert.ok(existsSync(path.join(store, 'state', 's1.json')));
    assert.ok(existsSync(path.join(store, 'state', 's2.json')));
    assert.ok(existsSync(path.join(store, 'ui', 'sessions.json')));
    assert.equal(readFileSync(path.join(store, 'ui', 'ui.log'), 'utf8'), '{"event":"start"}\n');
    assert.ok(!existsSync(path.join(store, 'ui', 'tmp')));
    assert.equal(read(dir, '.shipline/.gitignore'), '.state/\n');
  });

  test('task_dir in migrated state files and sessions.json becomes the absolute store path', () => {
    assert.equal(readJson(path.join(store, 'state', 's1.json')).task_dir, path.join(store, 'tasks', 'LL-12-add-export'));
    assert.equal(readJson(path.join(store, 'state', 's2.json')).task_dir, path.join(store, 'tasks', 'fix-crash'));
    const sessions = readJson(path.join(store, 'ui', 'sessions.json'));
    assert.deepEqual(sessions.map((c) => c.task_dir), [path.join(store, 'tasks', 'fix-crash'), null]);
  });

  test('a session bound to a task still finds it: stage.mjs status, the guard and session-start use the store', () => {
    const st = stage(dir, ['status'], 's1');
    assert.equal(st.code, 0, st.stderr);
    assert.ok(st.stdout.startsWith(`Task ${path.join(store, 'tasks', 'LL-12-add-export')} (feature)`), st.stdout);
    assert.match(st.stdout, /\[x\] jira/);
    const r2 = run(process.execPath, [path.join(dir, '.shipline', 'bin', 'session-start.mjs')], { cwd: dir, input: JSON.stringify({ session_id: 's2', cwd: dir }) });
    assert.ok(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext.includes(`already working on task ${path.join(store, 'tasks', 'fix-crash')} (bugfix workflow)`));
    // A new task now goes to the store as {key}-{slug}.
    const s = stage(dir, ['start', '--workflow', 'hotfix', '--title', 'New one', '--ticket', 'x-1'], 's9');
    assert.equal(s.code, 0, s.stderr);
    assert.ok(existsSync(path.join(store, 'tasks', 'X-1-new-one', 'manifest.json')));
    rmSync(path.join(store, 'tasks', 'X-1-new-one'), { recursive: true });
    rmSync(path.join(store, 'state', 's9.json'));
  });

  test('every Shipline-owned file now matches the template', () => {
    for (const to of Object.keys(version(dir).files)) {
      if (to.includes('#')) continue;
      assert.equal(sha(readFileSync(path.join(dir, to))), sha(template(to)), to);
    }
  });

  test('VERSION is interface 3 with a files map of what is on disk; team files are not in it', () => {
    const v = version(dir);
    assert.equal(v.package, PACKAGE_VERSION);
    assert.equal(v.interface, 3);
    for (const [to, hash] of Object.entries(v.files)) {
      assert.ok(!/^\.shipline\/(config\.yml|workflows\/|rules\/)/.test(to), `${to} is team-owned`);
      if (to === 'CLAUDE.md#shipline' || to === '.claude/settings.json#shipline') continue;
      assert.equal(sha(readFileSync(path.join(dir, to))), hash, to);
    }
    assert.ok(v.files['CLAUDE.md#shipline'] && v.files['.claude/settings.json#shipline']);
    // The same files map a fresh init writes.
    const fresh = makeRepo();
    dirs.push(fresh);
    assert.deepEqual(v.files, version(fresh).files);
  });

  test('config.yml loses artifact_root and folder_pattern, keeping the team\'s other content', () => {
    const cfg = read(dir, '.shipline/config.yml');
    assert.ok(!/artifact_root|folder_pattern/.test(cfg), cfg);
    assert.match(cfg, /^branch_pattern: "\{type\}\/\{key\}-\{slug\}"$/m);
    assert.match(cfg, /^tracker: jira$/m);
    assert.match(cfg, /^ {2}test: pnpm test$/m);
    assert.match(cfg, /^team_owner: platform$/m);
  });

  test('workflows lose only their {artifact_root} allow_paths entries; rules and hotfix.yml are untouched', () => {
    const feature = read(dir, '.shipline/workflows/feature.yml');
    assert.ok(!feature.includes('{artifact_root}'));
    assert.match(feature, /^ {8}allow_paths: \[("?)docs\/\*\*\1\]$/m, 'the team\'s own entry stays (re-emitted, so its quoting may change)');
    assert.match(feature, /^owner: platform$/m);
    const bugfix = read(dir, '.shipline/workflows/bugfix.yml');
    assert.ok(!bugfix.includes('{artifact_root}'));
    assert.ok(!/^\s+allow_paths:/m.test(bugfix), 'an entry list left empty is removed');
    assert.match(bugfix, /^ {6}- tools: 'Edit\|Write\|MultiEdit\|NotebookEdit'$/m, 'the block itself stays');
    assert.equal(read(dir, '.shipline/workflows/hotfix.yml'), orig.hotfix);
    assert.deepEqual(tree(path.join(dir, '.shipline/rules')), orig.rules);
    // The hooks still load every workflow.
    assert.match(stage(dir, ['workflows']).stdout, /^bugfix: .*\n^feature: .*\n^hotfix: /m);
  });

  test('settings.json: Shipline hook entries replaced, ~/.shipline allow rules added, the team\'s deny rules kept', () => {
    const s = readJson(path.join(dir, '.claude/settings.json'));
    assert.deepEqual(s.permissions.deny, orig.settings.permissions.deny);
    assert.deepEqual(s.permissions.allow, ['Read(~/.shipline/**)', 'Edit(~/.shipline/**)']);
    assert.deepEqual(s.hooks, readJson(path.join(TEMPLATES_ROOT, 'settings-hooks.json')).hooks);
  });

  test('CLAUDE.md: the block is replaced in place and the line above it is kept', () => {
    const md = read(dir, 'CLAUDE.md');
    assert.ok(md.startsWith('@AGENTS.md\n\n<!-- shipline:start -->'), md);
    assert.ok(md.includes(readFileSync(path.join(TEMPLATES_ROOT, 'claude-md-section.md'), 'utf8').trimEnd()));
    assert.ok(!md.includes('npx shipline ui'));
    assert.equal(md.split('<!-- shipline:start -->').length, 2);
  });

  test('a second run reports "Already up to date." and changes nothing', () => {
    const snap = snapshot(dir);
    const again = upgrade(dir, '--yes');
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, 'Already up to date.\n');
    assert.deepEqual(snapshot(dir), snap);
  });
});

// ---------- edited files ----------

describe('edited files', () => {
  test('legacy repo: an edited file is shown as a diff and skipped on every run; --force replaces it', () => {
    const dir = legacyRepo({
      tasks: false,
      prepare: (d) => {
        appendFileSync(path.join(d, '.shipline/bin/guard.mjs'), '// team tweak\n');
        appendFileSync(path.join(d, '.claude/agents/planner.md'), '\nAlways ask about the database.\n');
      },
    });
    const guard = read(dir, '.shipline/bin/guard.mjs');
    const planner = read(dir, '.claude/agents/planner.md');

    const first = upgrade(dir, '--yes');
    assert.equal(first.code, 0, first.stderr);
    assert.ok(first.stdout.includes('  ! skip     .shipline/bin/guard.mjs: edited by your team; use --force to replace. Changes it would get:'), first.stdout);
    assert.ok(first.stdout.includes('    - // team tweak'), 'the diff shows the team line going away');
    assert.ok(first.stdout.includes('  ! skip     .claude/agents/planner.md: edited by your team'));
    assert.match(first.stdout, /Task data -> .*\n {2}\(nothing to move\)/);
    assert.equal(read(dir, '.shipline/bin/guard.mjs'), guard);
    assert.equal(read(dir, '.claude/agents/planner.md'), planner);
    // Everything else was replaced, and the edited files have no hash in VERSION.files.
    assert.equal(read(dir, '.shipline/bin/lib.mjs'), template('.shipline/bin/lib.mjs').toString());
    const v = version(dir);
    assert.equal(v.interface, 3);
    assert.ok(!('.shipline/bin/guard.mjs' in v.files));
    assert.ok(!('.claude/agents/planner.md' in v.files));

    const second = upgrade(dir, '--yes');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, 'Already up to date.\nSkipped (edited by your team; use --force to replace): .shipline/bin/guard.mjs, .claude/agents/planner.md\n');
    assert.equal(read(dir, '.shipline/bin/guard.mjs'), guard);

    const forced = upgrade(dir, '--yes', '--force');
    assert.equal(forced.code, 0, forced.stderr);
    assert.ok(forced.stdout.includes('  ~ replace  .shipline/bin/guard.mjs (edited, --force)'), forced.stdout);
    assert.equal(read(dir, '.shipline/bin/guard.mjs'), template('.shipline/bin/guard.mjs').toString());
    assert.equal(version(dir).files['.shipline/bin/guard.mjs'], sha(template('.shipline/bin/guard.mjs')));
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('with a VERSION.files record: an unedited older file is replaced, an edited one keeps its recorded hash', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    // As if a previous release had written different content for stage.mjs (and recorded its hash).
    const old = '// stage.mjs from an older release\n';
    writeFileSync(path.join(dir, '.shipline/bin/stage.mjs'), old);
    const v = version(dir);
    v.files['.shipline/bin/stage.mjs'] = sha(old);
    // And the team edited planner.md after init.
    appendFileSync(path.join(dir, '.claude/agents/planner.md'), '\nTeam rule.\n');
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const recordedPlanner = v.files['.claude/agents/planner.md'];

    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('  ~ replace  .shipline/bin/stage.mjs\n'), r.stdout);
    assert.ok(r.stdout.includes('  ! skip     .claude/agents/planner.md: edited by your team'));
    assert.ok(!r.stdout.includes('Task data ->'), 'no migration on an interface-3 repo');
    assert.equal(read(dir, '.shipline/bin/stage.mjs'), template('.shipline/bin/stage.mjs').toString());
    assert.match(read(dir, '.claude/agents/planner.md'), /Team rule\.\n$/);
    const after = version(dir);
    assert.equal(after.files['.shipline/bin/stage.mjs'], sha(template('.shipline/bin/stage.mjs')));
    assert.equal(after.files['.claude/agents/planner.md'], recordedPlanner, 'the previous hash is kept, so the edit is seen again next time');

    const again = upgrade(dir, '--yes');
    assert.equal(again.stdout, 'Already up to date.\nSkipped (edited by your team; use --force to replace): .claude/agents/planner.md\n');
    const forced = upgrade(dir, '--yes', '--force');
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(read(dir, '.claude/agents/planner.md'), template('.claude/agents/planner.md').toString());
    assert.equal(version(dir).files['.claude/agents/planner.md'], sha(template('.claude/agents/planner.md')));
  });

  test('a recorded Shipline file this version no longer ships is removed when unedited, kept when edited', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const v = version(dir);
    writeFileSync(path.join(dir, '.claude/agents/retired.md'), 'old agent\n');
    v.files['.claude/agents/retired.md'] = sha('old agent\n');
    writeFileSync(path.join(dir, '.claude/agents/retired-edited.md'), 'old agent, edited\n');
    v.files['.claude/agents/retired-edited.md'] = sha('old agent\n');
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('  - remove   .claude/agents/retired.md'), r.stdout);
    assert.ok(r.stdout.includes('  ! skip     .claude/agents/retired-edited.md: edited by your team (no longer shipped)'));
    assert.ok(!existsSync(path.join(dir, '.claude/agents/retired.md')));
    assert.ok(existsSync(path.join(dir, '.claude/agents/retired-edited.md')));
    const after = version(dir).files;
    assert.ok(!('.claude/agents/retired.md' in after));
    assert.equal(after['.claude/agents/retired-edited.md'], sha('old agent\n'));
  });

  test('settings.json: a team edit to a Shipline hook entry skips the whole virtual entry; --force restores it', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const sf = path.join(dir, '.claude/settings.json');
    const s = readJson(sf);
    s.hooks.PreToolUse[0].matcher = 'Edit|Write';
    s.permissions.allow = s.permissions.allow.filter((x) => x !== 'Edit(~/.shipline/**)');
    s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo team' }] }];
    writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
    const text = readFileSync(sf, 'utf8');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Already up to date\.\nSkipped \(edited by your team; use --force to replace\): \.claude\/settings\.json \(Shipline hook entries and allow rules\)\n$/);
    assert.equal(readFileSync(sf, 'utf8'), text);

    const forced = upgrade(dir, '--yes', '--force');
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /\.claude\/settings\.json \(hook entries, allow rules for ~\/\.shipline\): replace/);
    const after = readJson(sf);
    assert.equal(after.hooks.PreToolUse[0].matcher, readJson(path.join(TEMPLATES_ROOT, 'settings-hooks.json')).hooks.PreToolUse[0].matcher);
    assert.deepEqual(after.hooks.Stop, s.hooks.Stop, 'the team\'s own hook stays');
    assert.ok(after.permissions.allow.includes('Edit(~/.shipline/**)'));
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('CLAUDE.md: an edit inside the Shipline block is skipped with a diff; --force replaces only the block', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const f = path.join(dir, 'CLAUDE.md');
    writeFileSync(f, '# Team\n\n' + readFileSync(f, 'utf8').replace('<!-- shipline:end -->', '- Team line inside the block.\n<!-- shipline:end -->') + '\nAfter.\n');
    const text = readFileSync(f, 'utf8');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Skipped \(edited by your team; use --force to replace\): CLAUDE\.md \(Shipline block\)/);
    assert.equal(readFileSync(f, 'utf8'), text);
    const forced = upgrade(dir, '--yes', '--force');
    assert.equal(forced.code, 0, forced.stderr);
    const md = readFileSync(f, 'utf8');
    assert.ok(!md.includes('Team line inside the block.'));
    assert.ok(md.startsWith('# Team\n\n<!-- shipline:start -->'));
    assert.ok(md.endsWith('\nAfter.\n'));
  });
});

// ---------- dry run ----------

describe('--dry-run', () => {
  test('shows the full preview, exits 0 and writes nothing (repo, index or store)', () => {
    const dir = legacyRepo();
    const before = snapshot(dir);
    const r = upgrade(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /~ replace {2}\.shipline\/bin\/guard\.mjs/);
    assert.match(r.stdout, /move task docs\/shipline\/fix-crash\/ -> tasks\/fix-crash\//);
    assert.match(r.stdout, /~ \.shipline\/config\.yml: remove artifact_root, folder_pattern/);
    assert.match(r.stdout, /\nDry run, nothing written\.\n$/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(before.store, null);
    // --yes does not override it.
    assert.equal(upgrade(dir, '--dry-run', '--yes').code, 0);
    assert.deepEqual(snapshot(dir), before);
  });
});

// ---------- preflight problems ----------

describe('preflight stops with nothing changed', () => {
  test('a task folder with uncommitted changes', () => {
    const dir = legacyRepo();
    appendFileSync(path.join(dir, 'docs/shipline/fix-crash/manifest.json'), '\n');
    const before = snapshot(dir);
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Cannot upgrade yet\. Nothing was changed:\n {2}- docs\/shipline\/fix-crash: has uncommitted or untracked changes; commit or stash them first/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(before.store, null);
  });

  test('an untracked task folder', () => {
    const dir = legacyRepo();
    cpSync(path.join(dir, 'docs/shipline/fix-crash'), path.join(dir, 'docs/shipline/brand-new'), { recursive: true });
    const before = snapshot(dir);
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /- docs\/shipline\/brand-new: has uncommitted or untracked changes/);
    assert.ok(!r.stdout.includes('- docs/shipline/fix-crash:'));
    assert.deepEqual(snapshot(dir), before);
  });

  test('a task name that already exists in the store (any existing target stops it)', () => {
    const dir = legacyRepo();
    const clash = path.join(storeOf(dir), 'tasks', 'fix-crash');
    mkdirSync(clash, { recursive: true });
    writeFileSync(path.join(clash, 'mine.md'), 'already here\n');
    const stateClash = path.join(storeOf(dir), 'state', 's1.json');
    mkdirSync(path.dirname(stateClash), { recursive: true });
    writeFileSync(stateClash, '{}');
    const before = snapshot(dir);
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes(`- docs/shipline/fix-crash: a task named "fix-crash" already exists in the store (${clash})`), r.stdout);
    assert.ok(r.stdout.includes(`- .shipline/.state/s1.json: ${stateClash} already exists in the store`));
    assert.deepEqual(snapshot(dir), before);
  });
});

// ---------- warnings ----------

describe('running sessions', () => {
  test('a session active in the last 30 minutes and a held UI lock are warned about, and the upgrade still runs', () => {
    const dir = legacyRepo({ withGit: true });
    const state = path.join(dir, '.shipline', '.state');
    ago(path.join(state, 's1.json'), 60 * 1000); // one minute ago
    writeFileSync(path.join(state, 'ui', 'lock.json'), JSON.stringify({ pid: 1, hostname: 'h', port: 1 }));
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Warnings\n {2}! Claude session s1 was active in the last 30 minutes; restart it after the upgrade/);
    assert.ok(!r.stdout.includes('Claude session s2 was active'));
    assert.match(r.stdout, /! a Shipline UI chat lock is held \(\.shipline\/\.state\/ui\/lock\.json\); stop the UI chat first/);
    assert.equal(version(dir).interface, 3);
    assert.ok(existsSync(path.join(storeOf(dir), 'tasks', 'fix-crash')));
  });
});

// ---------- other layouts ----------

describe('other layouts', () => {
  test('a custom artifact_root is read from config.yml before it is removed', () => {
    const dir = legacyRepo({
      prepare: (d) => {
        writeFileSync(path.join(d, '.shipline/config.yml'), read(d, '.shipline/config.yml').replace('artifact_root: docs/shipline', 'artifact_root: work/tasks'));
      },
    });
    assert.ok(existsSync(path.join(dir, 'work/tasks/fix-crash/manifest.json')));
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /move task work\/tasks\/fix-crash\/ -> tasks\/fix-crash\//);
    const store = storeOf(dir);
    assert.ok(existsSync(path.join(store, 'tasks', 'fix-crash', 'manifest.json')));
    assert.ok(!existsSync(path.join(dir, 'work/tasks/fix-crash')));
    assert.equal(readJson(path.join(store, 'state', 's2.json')).task_dir, path.join(store, 'tasks', 'fix-crash'));
    assert.ok(!read(dir, '.shipline/config.yml').includes('artifact_root'));
  });

  test('no docs/shipline and no .state: the migration step has nothing to move', () => {
    const dir = legacyRepo({ tasks: false });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Task data -> .*\n {2}\(nothing to move\)/);
    assert.match(r.stdout, /Upgraded to [\d.]+ \(interface 3\)\.\n/);
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
    assert.ok(!existsSync(path.join(storeOf(dir), 'tasks')) || readdirSync(path.join(storeOf(dir), 'tasks')).length === 0);
  });

  test('a non-git repo: no git rm; the old folders are deleted after the verified copy, and the preview says so', () => {
    const dir = legacyRepo({ withGit: false });
    const fixCrash = tree(path.join(dir, 'docs/shipline/fix-crash'));
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /not a git repository: the old task folders are deleted from disk after the copies are verified, with no git rm/);
    assert.ok(!r.stdout.includes('(git rm staged afterwards)'));
    assert.ok(!existsSync(path.join(dir, 'docs/shipline/fix-crash')));
    assert.deepEqual(tree(path.join(storeOf(dir), 'tasks', 'fix-crash')), fixCrash);
    assert.ok(!existsSync(path.join(dir, '.git')));
  });

  test('a repo with no VERSION (interface 1) is migrated like 0.6.0', () => {
    const dir = legacyRepo({ prepare: (d) => rmSync(path.join(d, '.shipline/bin/VERSION')) });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /repo: unknown \(interface 1\) -> /);
    assert.equal(version(dir).interface, 3);
    assert.ok(existsSync(path.join(storeOf(dir), 'tasks', 'LL-12-add-export')));
  });
});

// ---------- failure safety ----------

describe('an unwritable store', () => {
  test('upgrade exits 1 with "Shipline can\'t write its task store" and changes nothing', { skip: process.platform === 'win32' ? 'POSIX paths' : false }, () => {
    const dir = legacyRepo();
    const blocker = path.join(tmpDir(), 'a-file');
    dirs.push(path.dirname(blocker));
    writeFileSync(blocker, 'x');
    const before = snapshot(dir);
    const r = run(process.execPath, [BIN, 'upgrade', dir, '--yes'], { cwd: dir, env: { SHIPLINE_HOME: path.join(blocker, 'home') } });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /upgrade failed while preparing the store: Shipline can't write its task store at /);
    assert.deepEqual(snapshot(dir), before);
  });
});

describe('a failure before VERSION is written', () => {
  test('while writing files: VERSION, the task folders and .state stay; the store copies stay; the step is named', { skip: isRoot || process.platform === 'win32' ? 'needs a non-root POSIX user' : false }, () => {
    const dir = legacyRepo();
    const builder = path.join(dir, '.claude', 'agents', 'builder.md');
    const versionText = read(dir, '.shipline/bin/VERSION');
    const taskTree = tree(path.join(dir, 'docs/shipline'));
    const stateTree = tree(path.join(dir, '.shipline/.state'));
    chmodSync(builder, 0o444); // builder.md can't be replaced
    let r;
    try {
      r = upgrade(dir, '--yes');
    } finally {
      chmodSync(builder, 0o644);
    }
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /shipline: upgrade failed while writing files: /);
    assert.match(r.stderr, /Copies already made in the store were left in place .*; remove them before running upgrade again\./);
    assert.match(r.stderr, /\.shipline\/bin\/VERSION was not rewritten, so the repo still reports its old version\./);
    assert.ok(!r.stderr.includes('git restore --staged'), 'nothing was staged yet');
    assert.equal(read(dir, '.shipline/bin/VERSION'), versionText);
    assert.deepEqual(tree(path.join(dir, 'docs/shipline')), taskTree, 'no task file was deleted');
    assert.deepEqual(tree(path.join(dir, '.shipline/.state')), stateTree);
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
    assert.ok(existsSync(path.join(storeOf(dir), 'tasks', 'fix-crash', 'manifest.json')), 'the verified copies are kept');
    // The next run stops on those copies (any existing store target stops the upgrade).
    const again = upgrade(dir, '--yes');
    assert.equal(again.code, 1);
    assert.match(again.stdout, /a task named "fix-crash" already exists in the store/);
  });

  test('after git rm (VERSION can\'t be written): the removal stays staged and the error says how to undo it', () => {
    const dir = legacyRepo({
      prepare: (d) => {
        rmSync(path.join(d, '.shipline/bin/VERSION'));
        mkdirSync(path.join(d, '.shipline/bin/VERSION')); // writing VERSION will fail with EISDIR
        writeFileSync(path.join(d, '.shipline/bin/VERSION/.keep'), '');
      },
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /shipline: upgrade failed while writing \.shipline\/bin\/VERSION: /);
    assert.match(r.stderr, /stays staged; to undo it run: git restore --staged docs\/shipline\/\S+/);
    for (const t of ['LL-12-add-export', 'PROJ-7_custom', 'fix-crash']) assert.ok(r.stderr.includes(`docs/shipline/${t}`), t);
    assert.ok(lstatSync(path.join(dir, '.shipline/bin/VERSION')).isDirectory());
    assert.match(git(dir, 'diff', '--cached', '--name-status'), /^D\tdocs\/shipline\/fix-crash\/manifest\.json$/m);
    assert.ok(existsSync(path.join(storeOf(dir), 'tasks', 'fix-crash', 'manifest.json')), 'the store copy exists before the folder was removed');
  });
});
