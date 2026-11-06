// `shipline upgrade` at 1.0 (docs/plans/shipline-1.0.md, item 3): the generic mechanism only (the version check, the
// refresh of unedited Shipline files by hash, --force, preview and apply). Every pre-1.0 migration is gone, and a repo
// set up with a pre-1.0 Shipline (or with no VERSION) is refused with nothing written. Runs the real bin on temp repos
// made by a fresh 1.0 init; an "older 1.x" file is simulated by writing other content and recording its hash in
// VERSION.files, as a previous release would have. Node 18+.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BIN, CLI_ROOT, git, makeRepo, removeDir, run, storeOf, tmpDir } from './helpers.mjs';
import { SETTINGS_KEY, canonicalSettingsPart } from '../src/hashes.mjs';
import { INTERFACE } from '../src/interface.mjs';

const TEMPLATES_ROOT = path.join(CLI_ROOT, 'templates');
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const dirs = [];
after(() => dirs.forEach(removeDir));

// ---------- helpers ----------

const upgrade = (dir, ...flags) => run(process.execPath, [BIN, 'upgrade', '--dir', dir, ...flags], { cwd: dir });
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


// ---------- refusals ----------

// An older 1.x install with one unedited Shipline file to refresh (as a previous release would have left it).
function olderRepo() {
  const dir = makeRepo({ commitInit: true });
  dirs.push(dir);
  const old = '// stage.mjs from an older 1.x release\n';
  writeFileSync(path.join(dir, '.shipline/bin/stage.mjs'), old);
  const v = version(dir);
  v.files['.shipline/bin/stage.mjs'] = sha(old);
  writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
  git(dir, 'commit', '-q', '-am', 'as an older 1.x left it');
  return dir;
}

describe('refusals', () => {
  test('a repo newer than the CLI is refused and nothing changes', () => {
    // Same interface as this CLI but a newer package, then a newer interface.
    for (const v of [{ package: '9.9.9', interface: INTERFACE }, { package: '1.0.0', interface: 99 }]) {
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

  // 1.0 plan, item 3: a repo whose VERSION package is below 1.0.0 (or that has no VERSION) starts over.
  test('a pre-1.0 repo (0.14.0, 0.6.0, no package, no VERSION) is refused with the uninstall-then-init message; nothing is written', () => {
    const cases = [
      ['0.14.0', (d) => writeFileSync(path.join(d, '.shipline/bin/VERSION'), JSON.stringify({ package: '0.14.0', interface: 7, files: {} }) + '\n')],
      ['0.6.0', (d) => writeFileSync(path.join(d, '.shipline/bin/VERSION'), JSON.stringify({ package: '0.6.0', interface: 2 }) + '\n')],
      ['unknown version', (d) => writeFileSync(path.join(d, '.shipline/bin/VERSION'), JSON.stringify({ interface: 1 }) + '\n')],
      ['unknown version', (d) => rmSync(path.join(d, '.shipline/bin/VERSION'))],
      ['unknown version', (d) => writeFileSync(path.join(d, '.shipline/bin/VERSION'), 'not json\n')],
    ];
    for (const [shown, prepare] of cases) {
      const dir = makeRepo({ commitInit: true });
      dirs.push(dir);
      prepare(dir);
      // Something upgrade would otherwise refresh, so a refusal is the only reason nothing changes.
      writeFileSync(path.join(dir, '.shipline/bin/guard.mjs'), '// old guard\n');
      const before = snapshot(dir);
      for (const flags of [['--yes'], ['--yes', '--force'], ['--dry-run']]) {
        const r = upgrade(dir, ...flags);
        assert.equal(r.code, 1, `${shown} ${flags.join(' ')}: ${r.stdout}`);
        assert.equal(r.stdout, '', `${shown}: no preview`);
        assert.equal(
          r.stderr,
          `shipline: This repo was set up with a pre-1.0 Shipline (${shown}). Run \`npx @forgeyard/shipline uninstall --yes\` then \`init\`; task data in ~/.shipline is kept. Nothing was changed.\n`,
        );
        assert.deepEqual(snapshot(dir), before, `${shown} ${flags.join(' ')}`);
      }
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
    const r = run(process.execPath, [BIN, 'upgrade', '--dir', path.join(dir, 'nope'), '--yes'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a directory/);
  });

  test('without a TTY and without --yes it refuses, and nothing is written', () => {
    const dir = olderRepo();
    const before = snapshot(dir);
    const r = upgrade(dir); // stdin is a pipe here, not a terminal
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Shipline upgrade for /, 'the preview is still shown');
    assert.match(r.stderr, /not a terminal, so there is nobody to confirm\. Re-run with --yes to apply, or --dry-run to preview\./);
    assert.deepEqual(snapshot(dir), before);
  });
});

// ---------- already up to date ----------

describe('a fresh 1.0 install', () => {
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

// ---------- edited files ----------

describe('edited files', () => {
  test('an edited file is shown as a diff and skipped on every run; --force replaces it', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    appendFileSync(path.join(dir, '.shipline/bin/guard.mjs'), '// team tweak\n');
    // An unedited file from an older 1.x (recorded in VERSION.files) next to it, so there is something to apply.
    const old = '// lib.mjs from an older 1.x release\n';
    writeFileSync(path.join(dir, '.shipline/bin/lib.mjs'), old);
    const v = version(dir);
    v.files['.shipline/bin/lib.mjs'] = sha(old);
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const guard = read(dir, '.shipline/bin/guard.mjs');

    const first = upgrade(dir, '--yes');
    assert.equal(first.code, 0, first.stderr);
    assert.ok(first.stdout.includes('  ! skip     .shipline/bin/guard.mjs: edited by your team; use --force to replace. Changes it would get:'), first.stdout);
    assert.ok(first.stdout.includes('    - // team tweak'), 'the diff shows the team line going away');
    assert.ok(first.stdout.includes('  ~ replace  .shipline/bin/lib.mjs\n'), first.stdout);
    assert.match(first.stdout, /\nUpgraded to 1\.0\.0 \(interface 1\)\.\n/);
    assert.equal(read(dir, '.shipline/bin/guard.mjs'), guard);
    assert.equal(read(dir, '.shipline/bin/lib.mjs'), template('.shipline/bin/lib.mjs').toString());
    assert.equal(version(dir).interface, 1);

    const second = upgrade(dir, '--yes');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, 'Already up to date.\nSkipped (edited by your team; use --force to replace): .shipline/bin/guard.mjs\n');
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
    assert.ok(!r.stdout.includes('Task data ->'), 'no task data migration at 1.0');
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
  test('shows the full preview, exits 0 and writes nothing (repo, index or store); -y does not override it', () => {
    const dir = olderRepo();
    const before = snapshot(dir);
    const r = upgrade(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /~ replace {2}\.shipline\/bin\/stage\.mjs/);
    assert.ok(!r.stdout.includes('Config and workflows'), 'no config or workflow migration at 1.0');
    assert.ok(!r.stdout.includes('Task data ->'));
    assert.match(r.stdout, /\nDry run, nothing written\.\n$/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(upgrade(dir, '--dry-run', '-y').code, 0);
    assert.deepEqual(snapshot(dir), before);
  });
});

// ---------- a team-owned file stays the team's ----------

describe('team-owned files', () => {
  test('config.yml, workflows and rules are never touched, even when they differ from the template', () => {
    const dir = olderRepo();
    const cfg = read(dir, '.shipline/config.yml').replace('tracker: none', 'tracker: jira');
    writeFileSync(path.join(dir, '.shipline/config.yml'), cfg);
    writeFileSync(path.join(dir, '.shipline/workflows/small.yml'), read(dir, '.shipline/workflows/small.yml') + '# ours\n');
    writeFileSync(path.join(dir, '.shipline/rules/plan.md'), '# Our plan rules\n');
    const r = upgrade(dir, '--yes', '--force');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\nRules\n {2}\(no changes\)\n/);
    assert.equal(read(dir, '.shipline/config.yml'), cfg);
    assert.match(read(dir, '.shipline/workflows/small.yml'), /# ours\n$/);
    assert.equal(read(dir, '.shipline/rules/plan.md'), '# Our plan rules\n');
  });

  test('edited hook entries without Grep: left alone, with the warning that Read and Grep are not guarded', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const sf = path.join(dir, '.claude', 'settings.json');
    const s = readJson(sf);
    s.hooks.PreToolUse[0].matcher = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read';
    writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
    // Something else to do, so the full preview (with its warnings) is printed.
    writeFileSync(path.join(dir, '.shipline/bin/stage.mjs'), '// older\n');
    const v = version(dir);
    v.files['.shipline/bin/stage.mjs'] = sha('// older\n');
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('  ! Your Shipline hook entries in .claude/settings.json were edited, so reading credential files (the Read and Grep tools) is not guarded. Add Read and Grep to the PreToolUse matcher to enable it.'), r.stdout);
    assert.equal(readJson(sf).hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read');
  });
});

// ---------- failure safety ----------

describe('a failure before VERSION is written', () => {
  test('while writing files: VERSION stays, the step is named', { skip: isRoot ? 'needs a non-root user' : process.platform === 'win32' && 'relies on POSIX file modes to make a write fail; no Windows test covers the failed-write path (its logic is platform-neutral)' }, () => {
    const dir = olderRepo();
    const stageFile = path.join(dir, '.shipline', 'bin', 'stage.mjs');
    const versionText = read(dir, '.shipline/bin/VERSION');
    chmodSync(stageFile, 0o444); // stage.mjs can't be replaced
    let r;
    try {
      r = upgrade(dir, '--yes');
    } finally {
      chmodSync(stageFile, 0o644);
    }
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /shipline: upgrade failed while writing files: /);
    assert.match(r.stderr, /\.shipline\/bin\/VERSION was not rewritten, so the repo still reports its old version\./);
    assert.equal(read(dir, '.shipline/bin/VERSION'), versionText);
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  });
});

// Trust plan, F and Files to Touch: the optional CI workflow is updated only when the repo has it and it is
// Shipline's unedited copy; upgrade never adds it.
describe('the CI workflow (.github/workflows/shipline.yml)', () => {
  const CI = '.github/workflows/shipline.yml';
  const ciTemplate = () => readFileSync(path.join(TEMPLATES_ROOT, 'github', 'shipline.yml'));
  const OLD = '# Shipline CI from an older release\nname: Shipline\non: pull_request\n';

  // A fresh install that opted into the CI check, with `content` as the file and `recorded` as its VERSION hash.
  function ciRepo(content, recorded) {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(dir, CI), content);
    if (recorded !== undefined) {
      const v = version(dir);
      v.files[CI] = recorded;
      writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    }
    return dir;
  }

  test('present and unedited (an older copy Shipline recorded): replaced, and VERSION.files gets the new hash', () => {
    const dir = ciRepo(OLD, sha(OLD));
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`  ~ replace  ${CI}\n`), r.stdout);
    assert.ok(readFileSync(path.join(dir, CI)).equals(ciTemplate()));
    assert.equal(version(dir).files[CI], sha(ciTemplate()));
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('present and already current: "Already up to date."', () => {
    const dir = ciRepo(ciTemplate(), sha(ciTemplate()));
    const before = snapshot(dir);
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Already up to date.\n');
    assert.deepEqual(snapshot(dir), before);
  });

  test('present and edited by the team: skipped, the recorded hash kept; --force replaces it', () => {
    const edited = OLD + 'jobs: {}\n';
    const dir = ciRepo(edited, sha(OLD));
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    // Nothing else to do, so the short form: "Already up to date." plus the skipped file.
    assert.equal(r.stdout, `Already up to date.\nSkipped (edited by your team; use --force to replace): ${CI}\n`);
    assert.equal(read(dir, CI), edited);
    assert.equal(version(dir).files[CI], sha(OLD), 'the previous hash is kept, so the edit is seen again next time');
    const forced = upgrade(dir, '--yes', '--force');
    assert.equal(forced.code, 0, forced.stderr);
    assert.ok(readFileSync(path.join(dir, CI)).equals(ciTemplate()));
    assert.equal(version(dir).files[CI], sha(ciTemplate()));
  });

  test('absent: never added, even with --force', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const old = '// stage.mjs from an older release\n';
    writeFileSync(path.join(dir, '.shipline/bin/stage.mjs'), old);
    const v = version(dir);
    v.files['.shipline/bin/stage.mjs'] = sha(old);
    writeFileSync(path.join(dir, '.shipline/bin/VERSION'), JSON.stringify(v, null, 2) + '\n');
    for (const flags of [['--yes'], ['--yes', '--force']]) {
      const r = upgrade(dir, ...flags);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stdout.includes(CI), r.stdout);
    }
    assert.ok(!existsSync(path.join(dir, '.github')));
    assert.ok(!(CI in version(dir).files));
  });

  test('the team\'s own file with that name (not recorded, not a known Shipline copy) is left alone, even with --force', () => {
    const own = 'name: Our own shipline job\non: push\n';
    const dir = ciRepo(own);
    for (const flags of [['--yes'], ['--yes', '--force']]) {
      const r = upgrade(dir, ...flags);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'Already up to date.\n', flags.join(' '));
    }
    assert.equal(read(dir, CI), own);
    assert.ok(!(CI in version(dir).files));
  });
});

