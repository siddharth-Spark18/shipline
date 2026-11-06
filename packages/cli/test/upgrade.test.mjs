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
import { SETTINGS_KEY, canonicalSettingsPart } from '../src/hashes.mjs';
import { INTERFACE } from '../src/interface.mjs';
import { parseYaml } from '../templates/shipline/bin/lib.mjs';

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

// Chat reliability plan, G: 0.9.0 wraps every Shipline hook command in a node check. upgrade swaps the 0.8.0
// commands for the new ones in repos that haven't edited them, and leaves an edited entry alone.
describe('the node-check hook wrappers (0.8.0 -> 0.9.0)', () => {
  const OLD_COMMANDS = {
    SessionStart: 'node "$CLAUDE_PROJECT_DIR/.shipline/bin/session-start.mjs"',
    UserPromptSubmit: 'node "$CLAUDE_PROJECT_DIR/.shipline/bin/prompt-submit.mjs"',
    PostToolUse: 'node "$CLAUDE_PROJECT_DIR/.shipline/bin/record-answer.mjs"',
    PreToolUse: 'node "$CLAUDE_PROJECT_DIR/.shipline/bin/guard.mjs"',
  };
  const tplHooks = () => readJson(path.join(TEMPLATES_ROOT, 'settings-hooks.json')).hooks;
  const OLD_PRETOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
  // A repo whose settings.json has the 0.8.0 hook commands; `record` says what VERSION.files records for it.
  function repoWith08Hooks({ record = 'old', edit } = {}) {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const sf = path.join(dir, '.claude', 'settings.json');
    const s = readJson(sf);
    for (const [event, cmd] of Object.entries(OLD_COMMANDS)) s.hooks[event][0].hooks[0].command = cmd;
    s.hooks.PreToolUse[0].matcher = OLD_PRETOOL_MATCHER; // 0.13.0 added Read
    // 0.8.0's allow rules (0.10.1 added the stage.mjs Bash rule).
    s.permissions.allow = s.permissions.allow.filter((r) => r !== 'Bash(node .shipline/bin/stage.mjs:*)');
    const oldHash = sha(canonicalSettingsPart(s));
    if (edit) edit(s);
    writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
    const v = version(dir);
    if (record === 'old') v.files[SETTINGS_KEY] = oldHash;
    else delete v.files[SETTINGS_KEY];
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify(v, null, 2) + '\n');
    git(dir, 'commit', '-q', '-am', 'as installed by 0.8.0');
    return { dir, sf, oldHash, settings: s };
  }

  test('the 0.8.0 settings part is a known 0.8.0 hash, and the template differs from it', () => {
    const { oldHash } = repoWith08Hooks();
    const known = readJson(path.join(CLI_ROOT, 'src', 'known-hashes.json'))[SETTINGS_KEY];
    assert.equal(known[oldHash], '0.8.0');
    assert.notEqual(oldHash, sha(canonicalSettingsPart({ hooks: tplHooks(), permissions: { allow: ['Read(~/.shipline/**)', 'Edit(~/.shipline/**)'] } })));
  });

  test('unedited (recorded in VERSION.files): replaced by the wrappers; the record is updated', () => {
    const { dir, sf } = repoWith08Hooks();
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\.claude\/settings\.json \(hook entries, allow rules for ~\/\.shipline\): replace/);
    const after = readJson(sf);
    assert.deepEqual(after.hooks, tplHooks());
    for (const entries of Object.values(after.hooks))
      for (const e of entries) for (const h of e.hooks) assert.ok(h.command.startsWith('command -v node >/dev/null 2>&1 && node '), h.command);
    assert.equal(version(dir).files[SETTINGS_KEY], sha(canonicalSettingsPart(after)));
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('unedited with no record: matched through known-hashes.json and replaced', () => {
    const { dir, sf } = repoWith08Hooks({ record: 'none' });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJson(sf).hooks, tplHooks());
  });

  test('a team edit to the 0.8.0 entries is skipped (the old commands stay); --force writes the wrappers', () => {
    const { dir, sf } = repoWith08Hooks({ edit: (s) => (s.hooks.PreToolUse[0].matcher = 'Edit|Write') });
    const text = readFileSync(sf, 'utf8');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Skipped \(edited by your team; use --force to replace\): \.claude\/settings\.json/);
    assert.equal(readFileSync(sf, 'utf8'), text);
    assert.equal(upgrade(dir, '--yes', '--force').code, 0);
    assert.deepEqual(readJson(sf).hooks, tplHooks());
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
    assert.match(out, new RegExp(`repo: 0\\.6\\.0 \\(interface 2\\) -> ${PACKAGE_VERSION.replace(/\./g, '\\.')} \\(interface 6\\)`));
    // Trust plan, F: the recorder and the CI check script arrive with the upgrade; the CI workflow is never added.
    for (const f of ['.shipline/bin/record-answer.mjs', '.shipline/bin/ci-check.mjs']) assert.ok(out.includes(`  + add      ${f}\n`), f);
    assert.ok(!out.includes('.github/workflows/shipline.yml'), 'the CI workflow is opt-in, never added by upgrade');
    for (const f of ['.shipline/bin/guard.mjs', '.shipline/bin/lib.mjs', '.shipline/bin/stage.mjs', '.shipline/bin/session-start.mjs', '.claude/agents/planner.md', '.claude/skills/shipline-workflow/SKILL.md']) {
      assert.ok(out.includes(`  ~ replace  ${f}\n`), f);
    }
    assert.ok(!out.includes('! skip'), 'a 0.6.0 file is never treated as edited');
    assert.ok(!out.includes('(edited, --force)'));
    assert.match(out, /CLAUDE\.md block: replace/);
    assert.match(out, /\.claude\/settings\.json \(hook entries, allow rules for ~\/\.shipline\): replace/);
    assert.match(out, /~ \.shipline\/config\.yml: remove artifact_root, folder_pattern/);
    // Teams Phase 1, F: the `jira` stage of every workflow becomes `ticket`.
    assert.match(out, /~ \.shipline\/workflows\/feature\.yml: remove 1 \{artifact_root\} allow_paths entry; rename stage jira to ticket/);
    assert.match(out, /~ \.shipline\/workflows\/bugfix\.yml: remove 1 \{artifact_root\} allow_paths entry; rename stage jira to ticket/);
    // Teams Phase 3, D: the shipped commit/PR regex on verify becomes named actions.
    assert.match(out, /~ \.shipline\/workflows\/hotfix\.yml: rename stage jira to ticket; add checks on verify, sections on verify; replace the commit\/PR regex with actions: \[commit, pr\]\n/);
    // Teams Phase 3, G: an existing repo gets the guardrail keys with every rail off.
    assert.match(out, /~ \.shipline\/config\.yml: remove artifact_root, folder_pattern; add rails, rails_commands, protected_paths, scope_check \(every rail off\)\n/);
    assert.ok(out.includes('New: guardrails (off; see Setup → Guardrails)'));
    // Every 0.6.0 rules file is an unedited stub: each is replaced, and jira.md becomes the new ticket.md.
    assert.match(out, /~ \.shipline\/rules\/ticket\.md: new default \(jira\.md was unedited\)/);
    assert.match(out, /- remove {3}\.shipline\/rules\/jira\.md \(renamed to ticket\.md\)/);
    for (const f of ['feasibility', 'fix', 'implement', 'plan', 'pr', 'questions', 'reproduce', 'root_cause', 'verify', 'wireframes']) {
      assert.ok(out.includes(`  ~ .shipline/rules/${f}.md: unedited stub replaced by the new default\n`), f);
    }
    assert.ok(out.includes(`Task data -> ${store}`));
    for (const t of TASKS) assert.ok(out.includes(`  move task docs/shipline/${t}/ -> tasks/${t}/ (git rm staged afterwards)`), t);
    assert.match(out, /move \d+ item\(s\) from \.shipline\/\.state\/ \(session state, UI data\); the folder is then removed/);
    assert.match(out, /left in place \(not task folders\): docs\/shipline\/README\.md/);
    assert.ok(!out.includes('Warnings'), 'the aged sessions are not reported as running');
    assert.ok(out.includes(`Upgraded to ${PACKAGE_VERSION} (interface 6). Moved 3 task(s) to ${store}.`));
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

  test('VERSION is interface 6 with a files map of what is on disk; team files are not in it', () => {
    const v = version(dir);
    assert.equal(v.package, PACKAGE_VERSION);
    assert.equal(v.interface, 6);
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

  test('workflows lose only their {artifact_root} allow_paths entries and have jira renamed ticket; unedited stub rules get the new defaults', () => {
    const feature = read(dir, '.shipline/workflows/feature.yml');
    assert.ok(!feature.includes('{artifact_root}'));
    assert.match(feature, /^ {8}allow_paths: \[("?)docs\/\*\*\1\]$/m, 'the team\'s own entry stays (re-emitted, so its quoting may change)');
    assert.match(feature, /^owner: platform$/m);
    const bugfix = read(dir, '.shipline/workflows/bugfix.yml');
    assert.ok(!bugfix.includes('{artifact_root}'));
    assert.ok(!/^\s+allow_paths:/m.test(bugfix), 'an entry list left empty is removed');
    assert.match(bugfix, /^ {6}- tools: 'Edit\|Write\|MultiEdit\|NotebookEdit'$/m, 'the block itself stays');
    // hotfix.yml had no {artifact_root} entry: its jira stage is renamed and (Teams Phase 2) its verify stage gets
    // `checks: true` and the default sections, appended after the stage's existing keys.
    assert.equal(
      read(dir, '.shipline/workflows/hotfix.yml'),
      orig.hotfix
        .replace('  - id: jira\n    name: Jira ticket\n', '  - id: ticket\n    name: Ticket\n')
        .replace(/(\n  - id: verify\n(?: {4}[^\n]*\n| {6}[^\n]*\n)*)/, '$1    checks: true\n    sections: [Checklist]\n')
        .replace(/^ {6}- bash: '\\bgit\\s\+commit\\b\|\\bgh\\s\+pr\\s\+create\\b'$/m, '      - actions: [commit, pr]'),
    );
    for (const f of ['feature', 'bugfix', 'hotfix']) {
      const wf = read(dir, `.shipline/workflows/${f}.yml`);
      assert.ok(!/^\s+- id: jira$/m.test(wf), f);
      assert.match(wf, /^ {2}- id: ticket\n {4}name: Ticket\n {4}artifact: ticket\.md$/m, f);
    }
    // Every rules file was an unedited 0.6.0 stub: all now hold the shipped defaults, and jira.md became ticket.md.
    const rules = tree(path.join(dir, '.shipline/rules'));
    assert.deepEqual(Object.keys(rules).sort(), Object.keys(orig.rules).map((f) => (f === 'jira.md' ? 'ticket.md' : f)).sort());
    for (const f of Object.keys(rules)) assert.equal(rules[f], sha(template(`.shipline/rules/${f}`)), f);
    // The hooks still load every workflow.
    assert.match(stage(dir, ['workflows']).stdout, /^bugfix: .*\n^feature: .*\n^hotfix: /m);
  });

  test('settings.json: Shipline hook entries replaced, ~/.shipline allow rules added, the team\'s deny rules kept', () => {
    const s = readJson(path.join(dir, '.claude/settings.json'));
    assert.deepEqual(s.permissions.deny, orig.settings.permissions.deny);
    assert.deepEqual(s.permissions.allow, ['Read(~/.shipline/**)', 'Edit(~/.shipline/**)', 'Bash(node .shipline/bin/stage.mjs:*)']);
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
    assert.equal(v.interface, 6);
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
    assert.equal(version(dir).interface, 6);
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
    assert.match(r.stdout, /Upgraded to [\d.]+ \(interface 6\)\.\n/);
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
    assert.equal(version(dir).interface, 6);
    assert.ok(existsSync(path.join(storeOf(dir), 'tasks', 'LL-12-add-export')));
  });
});

// ---------- failure safety ----------

describe('an unwritable store', () => {
  test('upgrade exits 1 with "Shipline can\'t write its task store" and changes nothing', { skip: process.platform === 'win32' && 'blocks the store with a file in the path (POSIX ENOTDIR); no Windows test covers an unwritable store yet' }, () => {
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
  test('while writing files: VERSION, the task folders and .state stay; the store copies stay; the step is named', { skip: isRoot ? 'needs a non-root user' : process.platform === 'win32' && 'relies on POSIX file modes to make a write fail; no Windows test covers the failed-write path (its logic is platform-neutral)' }, () => {
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

// ---------- Teams Phase 1, B and F ----------

describe('0.10.0: commands, the jira -> ticket stage, and the rules files', () => {
  const LEGACY_RULES = path.join(LEGACY, '.shipline', 'rules');
  const legacyRule = (f) => readFileSync(path.join(LEGACY_RULES, f), 'utf8');
  const rulesTemplate = (f) => readFileSync(path.join(TEMPLATES_ROOT, 'shipline', 'rules', f), 'utf8');
  const write = (dir, rel, text) => writeFileSync(path.join(dir, rel), text);
  const commit = (dir) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'team edits');
  };
  // Makes the install look like 0.9.0, so upgrade shows its plan (a repo that is already 0.10.0 with nothing to
  // change only prints "Already up to date.").
  const asOlder = (d) => {
    const v = version(d);
    v.package = '0.9.0';
    writeFileSync(path.join(d, '.shipline', 'bin', 'VERSION'), JSON.stringify(v, null, 2) + '\n');
  };
  // A fresh install, then `prepare` to make it look like an older or edited one, committed.
  const repo = (prepare) => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    prepare(dir);
    commit(dir);
    return dir;
  };
  const toJira = (text) => text.replace('  - id: ticket\n    name: Ticket\n', '  - id: jira\n    name: Jira ticket\n');

  test('empty commands are filled from the repo\'s files and a set one is kept; --dry-run shows them and writes nothing', () => {
    const dir = repo((d) => {
      write(d, 'package.json', JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .', build: 'tsc' } }));
      write(d, 'yarn.lock', '');
      write(d, '.shipline/config.yml', read(d, '.shipline/config.yml').replace('  test: ""', '  test: make check'));
    });
    const before = snapshot(dir);
    const dry = upgrade(dir, '--dry-run');
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /~ \.shipline\/config\.yml: fill empty commands/);
    assert.ok(dry.stdout.includes('    commands: lint <- `yarn run lint` (package.json)\n'), dry.stdout);
    assert.ok(dry.stdout.includes('    commands: build <- `yarn run build` (package.json)\n'), dry.stdout);
    assert.ok(!dry.stdout.includes('commands: test <-'), 'a set command is never overwritten');
    assert.match(dry.stdout, /^ {4}\+ {3}lint: yarn run lint$/m, 'the diff shows the new line');
    assert.deepEqual(snapshot(dir), before, '--dry-run wrote nothing');

    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    const cfg = read(dir, '.shipline/config.yml');
    assert.match(cfg, /^commands:\n {2}test: make check\n {2}lint: yarn run lint\n {2}build: yarn run build\n/m);
    assert.match(cfg, /^# Optional\. The verify stage runs only the commands you set here\./m, 'comments are kept');
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n', 'a second run has nothing to fill');
  });

  test('nothing detected: config.yml is not touched', () => {
    const dir = repo(() => {});
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('a workflow\'s `jira` stage becomes `ticket` (named Ticket), with a diff in the plan; open tasks are not rewritten', () => {
    let manifestBefore;
    const dir = repo((d) => {
      write(d, '.shipline/workflows/feature.yml', toJira(read(d, '.shipline/workflows/feature.yml')));
      // A hand-renamed stage keeps its own name.
      write(d, '.shipline/workflows/bugfix.yml', read(d, '.shipline/workflows/bugfix.yml').replace('  - id: ticket\n    name: Ticket\n', '  - id: jira\n    name: Our tracker\n'));
    });
    assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], 's1').code, 0);
    const mf = path.join(storeOf(dir), 'tasks', 'add-export', 'manifest.json');
    manifestBefore = readFileSync(mf, 'utf8');
    assert.equal(JSON.parse(manifestBefore).stages[0].id, 'jira');

    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /~ \.shipline\/workflows\/feature\.yml: rename stage jira to ticket\n/);
    assert.match(r.stdout, /^ {4}- {3}- id: jira$/m);
    assert.match(r.stdout, /^ {4}\+ {3}- id: ticket$/m);
    assert.match(r.stdout, /^ {4}\+ {5}name: Ticket$/m);
    assert.ok(!r.stdout.includes('hotfix.yml'), 'a workflow already on `ticket` is left alone');
    assert.equal(read(dir, '.shipline/workflows/feature.yml'), readFileSync(path.join(TEMPLATES_ROOT, 'shipline', 'workflows', 'feature.yml'), 'utf8'));
    assert.match(read(dir, '.shipline/workflows/bugfix.yml'), /^ {2}- id: ticket\n {4}name: Our tracker$/m);
    assert.equal(readFileSync(mf, 'utf8'), manifestBefore, 'the open task\'s manifest is not rewritten');
    // The open task (stage `jira`) still works against the renamed workflow.
    const st = stage(dir, ['status'], 's1');
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /^Current stage: Ticket \[jira\]$/m);
    assert.match(st.stdout, /^Repo rules for this stage \(\.shipline\/rules\/ticket\.md\):$/m);
  });

  test('a workflow with both a jira and a ticket stage is left alone, with a warning', () => {
    let wf;
    const dir = repo((d) => {
      wf = read(d, '.shipline/workflows/hotfix.yml').replace(
        '  - id: ticket\n',
        '  - id: jira\n    name: Old Jira\n    artifact: jira.md\n    enforcement: guide\n  - id: ticket\n',
      );
      write(d, '.shipline/workflows/hotfix.yml', wf);
      asOlder(d);
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /! \.shipline\/workflows\/hotfix\.yml has both a jira and a ticket stage; its jira stage was left alone/);
    assert.equal(read(dir, '.shipline/workflows/hotfix.yml'), wf);
  });

  test('rules/jira.md unedited (a shipped version): replaced by the new ticket.md', () => {
    const dir = repo((d) => {
      rmSync(path.join(d, '.shipline/rules/ticket.md'));
      write(d, '.shipline/rules/jira.md', legacyRule('jira.md'));
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /~ \.shipline\/rules\/ticket\.md: new default \(jira\.md was unedited\)/);
    assert.match(r.stdout, /- remove {3}\.shipline\/rules\/jira\.md \(renamed to ticket\.md\)/);
    assert.ok(!existsSync(path.join(dir, '.shipline/rules/jira.md')));
    assert.equal(read(dir, '.shipline/rules/ticket.md'), rulesTemplate('ticket.md'));
  });

  test('rules/jira.md edited: renamed to ticket.md with its content kept and the 0.10.0 Jira and GitHub text appended', () => {
    const team = '# Jira rules\n\n- Our project key is ACME.\n- Always link the epic.\n';
    const dir = repo((d) => {
      rmSync(path.join(d, '.shipline/rules/ticket.md'));
      write(d, '.shipline/rules/jira.md', team);
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /~ \.shipline\/rules\/ticket\.md: your jira\.md content kept, Jira and GitHub text appended/);
    assert.ok(!existsSync(path.join(dir, '.shipline/rules/jira.md')));
    const ticket = read(dir, '.shipline/rules/ticket.md');
    assert.ok(ticket.startsWith(team + '\n## Shipline defaults (0.10.0)\n\n'), ticket);
    assert.match(ticket, /skip --reason "Jira not connected"/);
    assert.match(ticket, /gh issue view <n> --json number,title,body,labels,url,state/);
    assert.match(ticket, /skip --reason "GitHub not connected"/);
    assert.ok(ticket.endsWith('\n') && !ticket.endsWith('\n\n'));
  });

  test('rules/jira.md next to an existing ticket.md: both left alone, with a warning', () => {
    const dir = repo((d) => {
      write(d, '.shipline/rules/jira.md', legacyRule('jira.md'));
      asOlder(d);
    });
    const ticketBefore = read(dir, '.shipline/rules/ticket.md');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /! \.shipline\/rules\/jira\.md was left alone because \.shipline\/rules\/ticket\.md already exists/);
    assert.equal(read(dir, '.shipline/rules/jira.md'), legacyRule('jira.md'));
    assert.equal(read(dir, '.shipline/rules/ticket.md'), ticketBefore);
  });

  test('stub rules (any shipped version, LF or CRLF) get the new default; edited rules are kept', () => {
    const edited = legacyRule('verify.md') + '\n- Run the e2e suite too.\n';
    const dir = repo((d) => {
      write(d, '.shipline/rules/plan.md', legacyRule('plan.md'));
      write(d, '.shipline/rules/pr.md', legacyRule('pr.md')); // the 0.6.0 pr.md text
      write(d, '.shipline/rules/fix.md', legacyRule('fix.md').replace(/\n/g, '\r\n'));
      write(d, '.shipline/rules/verify.md', edited);
    });
    const before = snapshot(dir);
    const dry = upgrade(dir, '--dry-run');
    assert.equal(dry.code, 0, dry.stderr);
    for (const f of ['plan', 'pr', 'fix']) assert.ok(dry.stdout.includes(`  ~ .shipline/rules/${f}.md: unedited stub replaced by the new default\n`), f);
    assert.ok(!dry.stdout.includes('rules/verify.md'), 'an edited file is not mentioned');
    assert.deepEqual(snapshot(dir), before, '--dry-run wrote nothing');

    assert.equal(upgrade(dir, '--yes').code, 0);
    assert.equal(read(dir, '.shipline/rules/plan.md'), rulesTemplate('plan.md'));
    assert.equal(read(dir, '.shipline/rules/pr.md'), rulesTemplate('pr.md'));
    assert.equal(read(dir, '.shipline/rules/fix.md'), rulesTemplate('fix.md').replace(/\n/g, '\r\n'), 'the file keeps its CRLF line endings');
    assert.equal(read(dir, '.shipline/rules/verify.md'), edited);
    // The current defaults are not stubs: nothing more to do.
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('a rules file the repo deleted is not added back', () => {
    const dir = repo((d) => rmSync(path.join(d, '.shipline/rules/wireframes.md')));
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
    assert.ok(!existsSync(path.join(dir, '.shipline/rules/wireframes.md')));
  });
});

// ---------- Teams Phase 2, E and G ----------

describe('0.11.0: checks and sections on workflow stages, the CI checkout ref, and the 0.10.x rules', () => {
  const RULES_010 = path.join(FIXTURES, 'rules-0.10'); // the four rules files as 0.10.x shipped them
  const CI = '.github/workflows/shipline.yml';
  const write = (dir, rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const stageIn = (dir, wf, id) => parseYaml(read(dir, `.shipline/workflows/${wf}.yml`)).stages.find((s) => s.id === id);
  // A workflow as 0.10.x shipped it: no checks and no sections lines.
  const as010 = (text) => text.replace(/^ {4}(checks|sections):[^\n]*\n/gm, '');
  // A fresh install made to look like 0.10.1 (workflows without the new fields), then `prepare`, committed.
  const repo = (prepare = () => {}) => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    for (const wf of ['feature', 'bugfix', 'hotfix', 'small']) write(dir, `.shipline/workflows/${wf}.yml`, as010(read(dir, `.shipline/workflows/${wf}.yml`)));
    const v = version(dir);
    v.package = '0.10.1';
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify(v, null, 2) + '\n');
    prepare(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', '0.10.1 layout');
    return dir;
  };

  test('checks: true on verify and the default sections are added where missing, with a diff; --dry-run writes nothing', () => {
    const dir = repo();
    assert.equal(stageIn(dir, 'feature', 'verify').checks, undefined);
    const before = snapshot(dir);
    const dry = upgrade(dir, '--dry-run');
    assert.equal(dry.code, 0, dry.stderr);
    assert.ok(dry.stdout.includes('  ~ .shipline/workflows/feature.yml: add sections on feasibility, sections on plan, checks on verify, sections on verify\n'), dry.stdout);
    assert.ok(dry.stdout.includes('  ~ .shipline/workflows/bugfix.yml: add sections on root_cause, checks on verify, sections on verify\n'), dry.stdout);
    assert.ok(dry.stdout.includes('  ~ .shipline/workflows/small.yml: add checks on verify, sections on verify\n'), dry.stdout);
    assert.match(dry.stdout, /^ {4}\+ {5}checks: true$/m);
    assert.match(dry.stdout, /^ {4}\+ {5}sections: \[Scope, Files to touch, Verification\]$/m);
    assert.deepEqual(snapshot(dir), before, '--dry-run wrote nothing');

    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    for (const wf of ['feature', 'bugfix', 'hotfix', 'small']) {
      assert.equal(stageIn(dir, wf, 'verify').checks, true, wf);
      assert.deepEqual(stageIn(dir, wf, 'verify').sections, ['Checklist'], wf);
    }
    assert.deepEqual(stageIn(dir, 'feature', 'plan').sections, ['Scope', 'Files to touch', 'Verification']);
    assert.deepEqual(stageIn(dir, 'feature', 'feasibility').sections, ['Risks']);
    assert.deepEqual(stageIn(dir, 'bugfix', 'root_cause').sections, ['Cause', 'Evidence']);
    for (const id of ['ticket', 'questions', 'implement', 'pr']) {
      assert.equal(stageIn(dir, 'feature', id).checks, undefined, id);
      assert.equal(stageIn(dir, 'feature', id).sections, undefined, id);
    }
    // The upgraded workflows hold the same fields as the shipped 0.11 ones (only the key order may differ).
    for (const wf of ['feature', 'bugfix', 'hotfix', 'small']) {
      const shipped = parseYaml(readFileSync(path.join(TEMPLATES_ROOT, 'shipline', 'workflows', `${wf}.yml`), 'utf8'));
      assert.deepEqual(parseYaml(read(dir, `.shipline/workflows/${wf}.yml`)), shipped, wf);
    }
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('stages that already set checks or sections (to false, [] or their own list) are left alone', () => {
    const dir = repo((d) => {
      const f = '.shipline/workflows/feature.yml';
      write(d, f, read(d, f)
        .replace('    name: Verify\n', '    name: Verify\n    checks: false\n    sections: []\n')
        .replace('    name: Plan\n', '    name: Plan\n    sections: [Goal]\n')
        .replace('    name: Feasibility\n', '    name: Feasibility\n    sections: []\n'));
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('.shipline/workflows/feature.yml'), r.stdout);
    assert.equal(stageIn(dir, 'feature', 'verify').checks, false);
    assert.deepEqual(stageIn(dir, 'feature', 'verify').sections, []);
    assert.deepEqual(stageIn(dir, 'feature', 'plan').sections, ['Goal']);
    assert.deepEqual(stageIn(dir, 'feature', 'feasibility').sections, []);
    // The other workflows still get theirs.
    assert.equal(stageIn(dir, 'bugfix', 'verify').checks, true);
  });

  test('an open task keeps working after the upgrade', () => {
    const dir = repo();
    assert.equal(stage(dir, ['start', '--workflow', 'small', '--title', 'Open task'], 'up-s1').code, 0);
    assert.equal(upgrade(dir, '--yes').code, 0);
    const st = stage(dir, ['status'], 'up-s1');
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /^Current stage: Ticket \[ticket\]$/m);
  });

  test('the 0.10.x rules files, unedited, are replaced by the new defaults (which ask for the required headings)', () => {
    const files = ['plan.md', 'verify.md', 'root_cause.md', 'feasibility.md'];
    const dir = repo((d) => {
      for (const f of files) write(d, `.shipline/rules/${f}`, readFileSync(path.join(RULES_010, f), 'utf8'));
      write(d, '.shipline/rules/verify.md', readFileSync(path.join(RULES_010, 'verify.md'), 'utf8').replace(/\n/g, '\r\n'));
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    for (const f of files) {
      assert.ok(r.stdout.includes(`  ~ .shipline/rules/${f}: unedited stub replaced by the new default\n`), f);
      const shipped = readFileSync(path.join(TEMPLATES_ROOT, 'shipline', 'rules', f), 'utf8');
      assert.equal(read(dir, `.shipline/rules/${f}`), f === 'verify.md' ? shipped.replace(/\n/g, '\r\n') : shipped, f);
    }
    for (const [f, heading] of [['plan.md', 'Files to touch'], ['verify.md', 'Checklist'], ['root_cause.md', 'Evidence'], ['feasibility.md', 'Risks']]) {
      assert.ok(read(dir, `.shipline/rules/${f}`).includes(heading), `${f} names ${heading}`);
    }
  });

  test('an unedited 0.10.x shipline.yml gets the checkout of the PR\'s head commit', () => {
    const OLD_CI = readFileSync(path.join(TEMPLATES_ROOT, 'github', 'shipline.yml'), 'utf8').replace(
      /\n {8}with:\n(?: {10}[^\n]*\n)+/,
      '\n',
    );
    assert.ok(!OLD_CI.includes('ref:'), OLD_CI);
    assert.equal(sha(OLD_CI), '6f73bcdade9673bd631ad9bffd548673e4c500c1d779a66fa3b33ed17b2643a1', 'the file as 0.8.0 - 0.10.x shipped it');
    const dir = repo((d) => {
      write(d, CI, OLD_CI);
      const v = version(d);
      v.files[CI] = sha(OLD_CI);
      writeFileSync(path.join(d, '.shipline', 'bin', 'VERSION'), JSON.stringify(v, null, 2) + '\n');
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`  ~ replace  ${CI}\n`), r.stdout);
    assert.match(read(dir, CI), /- uses: actions\/checkout@v4\n {8}with:\n(?: {10}#[^\n]*\n)? {10}ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n/);
    assert.equal(version(dir).files[CI], sha(readFileSync(path.join(TEMPLATES_ROOT, 'github', 'shipline.yml'))));
  });
});

// Teams Phase 3, G and D: upgrading a 0.12.0 repo adds the guardrail keys with every rail off (keys already there
// are kept), turns the shipped verify regex into `actions: [commit, pr]` (an edited regex is kept), gives the
// settings hook entries the Read matcher when unedited, and warns when edited entries lack it.
describe('guardrails (0.12.0 -> 0.13.0)', () => {
  const SHIPPED_REGEX_LINE = "      - bash: '\\bgit\\s+commit\\b|\\bgh\\s+pr\\s+create\\b'";
  const OFF_COMMENT = '# Guardrails are off for repos set up before 0.13.0. Turn them on here or in Setup → Guardrails.';
  const NEW_LINE = 'New: guardrails (off; see Setup → Guardrails)';
  const READ_WARNING =
    'Your Shipline hook entries in .claude/settings.json were edited, so reading credential files (the read_credentials rail) is not guarded. Add Read to the PreToolUse matcher to enable it.';

  // A current install turned back into what 0.12.0 wrote: no guardrail keys in config.yml, the commit/PR regex on
  // every verify stage, no Read in the PreToolUse matcher. opts.config / opts.workflow / opts.settings edit further.
  function repo012({ config, workflow, settings } = {}) {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const cfgFile = path.join(dir, '.shipline', 'config.yml');
    let cfg = read(dir, '.shipline/config.yml').replace(/\n# Guardrails:[\s\S]*?\n(?=# Set to `done`)/, '\n');
    assert.ok(!/^(rails|rails_commands|protected_paths|scope_check):/m.test(cfg), cfg);
    if (config) cfg = config(cfg);
    writeFileSync(cfgFile, cfg);
    for (const f of readdirSync(path.join(dir, '.shipline', 'workflows'))) {
      const file = path.join(dir, '.shipline', 'workflows', f);
      let text = readFileSync(file, 'utf8').replace('      - actions: [commit, pr]', SHIPPED_REGEX_LINE);
      if (workflow) text = workflow(f, text);
      writeFileSync(file, text);
    }
    const sf = path.join(dir, '.claude', 'settings.json');
    const s = readJson(sf);
    s.hooks.PreToolUse[0].matcher = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
    const v = version(dir);
    v.package = '0.12.0';
    v.interface = 5;
    v.files[SETTINGS_KEY] = sha(canonicalSettingsPart(s)); // as 0.12.0 installed it
    if (settings) settings(s);
    writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), JSON.stringify(v, null, 2) + '\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'as installed by 0.12.0');
    return dir;
  }
  const guard = (dir, command) => run(process.execPath, [path.join(dir, '.shipline', 'bin', 'guard.mjs')], { cwd: dir, input: JSON.stringify({ session_id: 'g', cwd: dir, tool_name: 'Bash', tool_input: { command } }) });

  test('known-hashes.json knows the settings part without Read (shipped before 0.13.0)', () => {
    const dir = repo012();
    const known = readJson(path.join(CLI_ROOT, 'src', 'known-hashes.json'))[SETTINGS_KEY];
    assert.ok(known[version(dir).files[SETTINGS_KEY]], 'a known pre-0.13.0 hash');
  });

  test('every rail off, empty protected_paths, rails_commands and scope_check (on) added; the shipped regex becomes actions', () => {
    const dir = repo012();
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^ {2}~ \.shipline\/config\.yml: add rails, rails_commands, protected_paths, scope_check \(every rail off\)$/m);
    for (const f of ['feature', 'bugfix', 'hotfix', 'small']) {
      assert.match(r.stdout, new RegExp(`^ {2}~ \\.shipline/workflows/${f}\\.yml: replace the commit/PR regex with actions: \\[commit, pr\\]$`, 'm'), f);
    }
    assert.ok(r.stdout.includes(`\n${NEW_LINE}\n`), r.stdout);
    assert.ok(!r.stdout.includes(READ_WARNING));

    const cfgText = read(dir, '.shipline/config.yml');
    const cfg = parseYaml(cfgText);
    assert.deepEqual(cfg.rails, {
      force_push_default: 'off',
      push_default: 'off',
      pipe_to_shell: 'off',
      print_credentials: 'off',
      read_credentials: 'off',
      deploy: 'off',
      migrate: 'off',
      agent_config: 'off',
    });
    assert.deepEqual(cfg.rails_commands, { deploy: [], migrate: [] });
    assert.deepEqual(cfg.protected_paths, []);
    assert.deepEqual(cfg.scope_check, { enabled: true, sensitive_extra: [] });
    assert.ok(cfgText.includes(`${OFF_COMMENT}\nrails:\n`), cfgText);
    assert.match(cfgText, /^protected_paths: \[\]$/m);

    for (const f of ['feature', 'bugfix', 'hotfix', 'small']) {
      const wf = parseYaml(read(dir, `.shipline/workflows/${f}.yml`));
      assert.deepEqual(wf.stages.find((s) => s.id === 'verify').blocks, [{ actions: ['commit', 'pr'] }], f);
    }
    // The unedited hook entries are replaced, so the matcher gains Read.
    assert.deepEqual(readJson(path.join(dir, '.claude', 'settings.json')).hooks, readJson(path.join(TEMPLATES_ROOT, 'settings-hooks.json')).hooks);

    // The rails are really off: what a fresh install denies goes through.
    assert.equal(guard(dir, 'cat .env').stdout, '');
    assert.equal(guard(dir, 'git push --force origin main').stdout, '');
    // A second run changes nothing.
    assert.equal(upgrade(dir, '--yes').stdout, 'Already up to date.\n');
  });

  test('keys already present are never changed; only the missing ones are added', () => {
    const dir = repo012({
      config: (t) => t.replace(/\n# Set to `done`/, '\nrails:\n  deploy: deny\nprotected_paths: [infra/**]\n\n# Set to `done`'),
    });
    const before = read(dir, '.shipline/config.yml');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /config\.yml: add rails_commands, scope_check \(every rail off\)$/m);
    assert.ok(!r.stdout.includes(NEW_LINE), 'rails were already set: nothing new to announce');
    const text = read(dir, '.shipline/config.yml');
    const cfg = parseYaml(text);
    assert.deepEqual(cfg.rails, { deploy: 'deny' });
    assert.deepEqual(cfg.protected_paths, ['infra/**']);
    assert.deepEqual(cfg.rails_commands, { deploy: [], migrate: [] });
    assert.deepEqual(cfg.scope_check, { enabled: true, sensitive_extra: [] });
    assert.ok(!text.includes(OFF_COMMENT));
    assert.match(text, /^ {2}deploy: deny$/m);
    assert.match(text, /^protected_paths: \[infra\/\*\*\]$/m);
    assert.notEqual(text, before);
    // A missing rail uses its default (deny/ask), the one set is kept.
    assert.equal(run(process.execPath, [path.join(dir, '.shipline', 'bin', 'guard.mjs')], { cwd: dir, input: JSON.stringify({ session_id: 'g', cwd: dir, tool_name: 'Bash', tool_input: { command: 'fly deploy' } }) }).stdout.includes('"deny"'), true);
  });

  test('with every guardrail key present, config.yml is left alone', () => {
    const dir = repo012({
      config: (t) => t.replace(/\n# Set to `done`/, '\nrails:\n  deploy: ask\nrails_commands:\nprotected_paths: []\nscope_check:\n  enabled: false\n\n# Set to `done`'),
    });
    const before = read(dir, '.shipline/config.yml');
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('.shipline/config.yml'), r.stdout);
    assert.equal(read(dir, '.shipline/config.yml'), before);
  });

  test('an edited verify regex is kept; a regex block with other keys is kept', () => {
    const dir = repo012({
      workflow: (f, t) => {
        if (f === 'feature.yml') return t.replace(SHIPPED_REGEX_LINE, "      - bash: '\\bgit\\s+commit\\b'");
        if (f === 'bugfix.yml') return t.replace(SHIPPED_REGEX_LINE, `${SHIPPED_REGEX_LINE}\n        note: ours`);
        return t;
      },
    });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/workflows\/feature\.yml: replace the commit\/PR regex/.test(r.stdout), r.stdout);
    assert.ok(!/workflows\/bugfix\.yml: replace the commit\/PR regex/.test(r.stdout), r.stdout);
    assert.match(r.stdout, /workflows\/hotfix\.yml: replace the commit\/PR regex with actions: \[commit, pr\]/);
    const verify = (f) => parseYaml(read(dir, `.shipline/workflows/${f}.yml`)).stages.find((s) => s.id === 'verify').blocks;
    assert.deepEqual(verify('feature'), [{ bash: '\\bgit\\s+commit\\b' }]);
    assert.deepEqual(verify('bugfix'), [{ bash: '\\bgit\\s+commit\\b|\\bgh\\s+pr\\s+create\\b', note: 'ours' }]);
    assert.deepEqual(verify('hotfix'), [{ actions: ['commit', 'pr'] }]);
  });

  test('edited hook entries without Read: left alone, with the read_credentials warning', () => {
    const dir = repo012({ settings: (s) => (s.hooks.PreToolUse[0].matcher = 'Edit|Write|Bash') });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}! skip {5}\.claude\/settings\.json \(Shipline hook entries and allow rules\): edited by your team/m);
    assert.ok(r.stdout.includes(`  ! ${READ_WARNING}`), r.stdout);
    assert.equal(readJson(path.join(dir, '.claude', 'settings.json')).hooks.PreToolUse[0].matcher, 'Edit|Write|Bash');
  });

  test('edited hook entries that already include Read: no warning', () => {
    const dir = repo012({ settings: (s) => (s.hooks.PreToolUse[0].matcher = 'Edit|Write|Bash|Read') });
    const r = upgrade(dir, '--yes');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(READ_WARNING), r.stdout);
  });

  test('--dry-run shows the guardrails and writes nothing', () => {
    const dir = repo012();
    const snap = snapshot(dir);
    const r = upgrade(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /add rails, rails_commands, protected_paths, scope_check \(every rail off\)/);
    assert.ok(r.stdout.includes(`+ ${OFF_COMMENT}`), r.stdout);
    assert.deepEqual(snapshot(dir), snap);
  });
});
