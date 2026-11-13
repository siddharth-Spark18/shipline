// Plan item 17: `init` writes .shipline/bin/VERSION (Goal 1), and the version comparison (src/interface.mjs).
// Phase 1: INTERFACE 3, VERSION.files (hashes of the Shipline-owned files and the two virtual entries),
// the allow rules for ~/.shipline, no .shipline/.gitignore, and the @forgeyard/shipline name.
import { test, describe, after } from 'node:test';
import { nextSteps } from '../src/install.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INTERFACE, MISSING_BEFORE, compareInterface, isPreOne, preOneMessage, readRepoVersion } from '../src/interface.mjs';
import { BIN, CLI_ROOT, homeFor, removeDir, run, runInit, storeOf, tmpDir } from './helpers.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');

const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;
const dirs = [];
const fresh = () => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
after(() => dirs.forEach(removeDir));

describe('init writes VERSION', () => {
  test('with the package version, INTERFACE 1 and the files map, plus a newline', () => {
    const dir = fresh();
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    const v = JSON.parse(text);
    assert.deepEqual(Object.keys(v), ['package', 'interface', 'files', 'excluded']);
    // Setup wizard plan, B: --yes installs only the agents the workflows' stages use (no UI here).
    const excluded = ['.claude/agents/reviewer.md', '.claude/agents/wireframe-proposer.md'];
    assert.deepEqual(v.excluded, excluded, '--yes leaves out the standalone reviewer and, with no UI, wireframe-proposer');
    assert.equal(v.package, PACKAGE_VERSION);
    assert.equal(v.interface, INTERFACE);
    assert.equal(INTERFACE, 1);
    assert.equal(PACKAGE_VERSION, '1.3.0');
    assert.deepEqual(readRepoVersion(dir), { package: PACKAGE_VERSION, interface: INTERFACE, files: v.files, excluded });
  });

  test('VERSION.files hashes every Shipline-owned file as written, plus the two virtual entries; team files are not in it', () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    const { files } = JSON.parse(readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8'));
    const keys = Object.keys(files);
    for (const k of keys) {
      if (k === 'CLAUDE.md#shipline' || k === '.claude/settings.json#shipline') continue;
      assert.equal(files[k], sha(readFileSync(path.join(dir, k))), k);
      assert.ok(/^\.shipline\/bin\/[^/]+\.mjs$|^\.claude\/agents\/[^/]+\.md$|^\.claude\/skills\/shipline-[^/]+\//.test(k), `${k} is Shipline-owned`);
    }
    for (const must of ['.shipline/bin/lib.mjs', '.shipline/bin/guard.mjs', '.shipline/bin/stage.mjs', '.claude/agents/planner.md', '.claude/skills/shipline-workflow/SKILL.md', 'CLAUDE.md#shipline', '.claude/settings.json#shipline']) {
      assert.ok(keys.includes(must), must);
    }
    for (const k of keys) {
      assert.ok(!/^\.shipline\/(config\.yml|workflows\/|rules\/)/.test(k), `${k} is team-owned and must not be tracked`);
      assert.notEqual(k, '.shipline/bin/VERSION');
    }
    // The CLAUDE.md entry hashes the text between the markers (trimmed).
    const md = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    const block = md.slice(md.indexOf('<!-- shipline:start -->') + '<!-- shipline:start -->'.length, md.indexOf('<!-- shipline:end -->')).trim();
    assert.equal(files['CLAUDE.md#shipline'], sha(block));
  });

  test('settings.json gets the ~/.shipline allow rules, merged without duplicates and keeping existing rules', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Read(~/.shipline/**)'] } }));
    assert.equal(runInit(dir).code, 0);
    const s = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.permissions.allow, ['Bash(ls:*)', 'Read(~/.shipline/**)', 'Edit(~/.shipline/**)', 'Bash(node .shipline/bin/stage.mjs:*)']);
    assert.ok(s.hooks.PreToolUse.some((e) => JSON.stringify(e).includes('.shipline/bin/guard.mjs')));
  });

  // Chat reliability plan, G: the hooks check for node first, so a machine without it gets one warning, not an
  // error on every tool call.
  test('settings.json gets the hook form: each Shipline command checks for node; SessionStart warns only without node, the others || true', () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    const s = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    const tpl = JSON.parse(readFileSync(path.join(CLI_ROOT, 'templates', 'settings-hooks.json'), 'utf8'));
    assert.deepEqual(s.hooks, tpl.hooks);
    const commands = Object.fromEntries(
      Object.entries(s.hooks).map(([event, entries]) => [event, entries.flatMap((e) => e.hooks.map((h) => h.command))]),
    );
    assert.deepEqual(Object.keys(commands).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
    const script = { SessionStart: 'session-start', UserPromptSubmit: 'prompt-submit', PostToolUse: 'record-answer', PreToolUse: 'guard' };
    for (const [event, cmds] of Object.entries(commands)) {
      assert.equal(cmds.length, 1, event);
      const run = `node "$CLAUDE_PROJECT_DIR/.shipline/bin/${script[event]}.mjs"`;
      if (event === 'SessionStart') {
        // 1.0 plan, item 7: the warning is in the else branch of `command -v node`, so a failing node never prints it.
        assert.match(cmds[0], new RegExp(`^if command -v node >/dev/null 2>&1; then ${run.replace(/[$.]/g, '\\$&')}; else echo '\\{"systemMessage":"Shipline needs Node\\.js 18 or newer.*'; fi$`), cmds[0]);
      } else {
        assert.equal(cmds[0], `command -v node >/dev/null 2>&1 && ${run} || true`, event);
      }
    }
    // The PreToolUse matcher covers the file tools, Bash, Read and Grep (1.0 plan, item 11); Glob stays outside.
    assert.equal(s.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep');
  });

  test('no .shipline/.gitignore, no docs/shipline and no .shipline/.state; the store is created with repo.json', () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    assert.ok(!existsSync(path.join(dir, '.shipline', '.gitignore')));
    assert.ok(!existsSync(path.join(dir, '.shipline', '.state')));
    assert.ok(!existsSync(path.join(dir, 'docs')));
    const cfg = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
    assert.ok(!/artifact_root|folder_pattern/.test(cfg), cfg);
    const meta = JSON.parse(readFileSync(path.join(storeOf(dir), 'repo.json'), 'utf8'));
    assert.equal(meta.root, dir);
  });

  test('an unwritable SHIPLINE_HOME stops init with "can\'t write its task store" and nothing is installed', { skip: process.platform === 'win32' && 'blocks the store with a file in the path (POSIX ENOTDIR); no Windows test covers an unwritable store yet' }, () => {
    const dir = fresh();
    const blocker = path.join(homeFor(dir), 'file');
    writeFileSync(blocker, 'x');
    const r = run(process.execPath, [BIN, 'init', '--dir', dir, '--yes'], { cwd: dir, env: { SHIPLINE_HOME: path.join(blocker, 'home') } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Shipline can't write its task store at /);
    assert.ok(!existsSync(path.join(dir, '.shipline')));
  });

  test('the success message ends with the next-steps checklist (Setup polish plan, item 5)', () => {
    const r = runInit(fresh());
    assert.ok(r.stdout.includes(`\n\n${nextSteps({ ci: false }).join('\n')}\n`), r.stdout);
    assert.ok(!/^Next: /m.test(r.stdout));
    assert.ok(!/npx shipline/.test(r.stdout));
  });

  test('init on an initialized repo points at `npx @forgeyard/shipline upgrade`', () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    const r = runInit(dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /already initialized/);
    assert.match(r.stdout, /npx @forgeyard\/shipline upgrade/);
  });

  test('--dry-run lists VERSION and writes nothing', () => {
    const dir = fresh();
    const r = runInit(dir, '--dry-run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^ {2}\+ \.shipline\/bin\/VERSION$/m);
    assert.ok(!/\.shipline\/\.gitignore/.test(r.stdout));
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!existsSync(storeOf(dir)), 'a dry run does not create the store');
  });

  test('an existing VERSION file counts as a collision and nothing is written', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'mine\n');
    const r = runInit(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^ {2}- \.shipline\/bin\/VERSION$/m);
    assert.equal(readFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), 'utf8'), 'mine\n');
    assert.deepEqual(readdirSync(path.join(dir, '.shipline', 'bin')), ['VERSION']);
    assert.ok(!existsSync(path.join(dir, '.shipline', 'config.yml')));
    assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')));
  });

  test('a failed preflight (invalid settings.json) writes no VERSION', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ not json');
    const r = runInit(dir);
    assert.equal(r.code, 1);
    assert.ok(!existsSync(path.join(dir, '.shipline')));
  });
});

describe('init write failures', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  test('if an earlier write fails, VERSION is never written and init rolls back', { skip: isRoot ? 'needs a non-root user' : process.platform === 'win32' && 'chmod 0o555 cannot make a folder read-only on Windows; no Windows test covers the rollback (its logic is platform-neutral)' }, () => {
    const dir = fresh();
    const agents = path.join(dir, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    chmodSync(agents, 0o555); // the agent files can't be created
    try {
      const r = runInit(dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /rolled back/);
      assert.ok(!existsSync(path.join(dir, '.shipline', 'bin', 'VERSION')));
      assert.ok(!existsSync(path.join(dir, '.shipline', 'config.yml')));
      assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')));
      assert.ok(!existsSync(path.join(dir, '.claude', 'settings.json')));
    } finally {
      chmodSync(agents, 0o755);
    }
  });
});

describe('readRepoVersion', () => {
  test('reports legacy when VERSION is deleted', () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    rmSync(path.join(dir, '.shipline', 'bin', 'VERSION'));
    assert.deepEqual(readRepoVersion(dir), { legacy: true, interface: 1 });
  });

  test('reports legacy when VERSION is unreadable or malformed', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    for (const text of ['not json', '{"package":"1.0.0"}', '{"interface":"2"}', 'null', '[]']) {
      writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), text);
      assert.deepEqual(readRepoVersion(dir), { legacy: true, interface: 1 }, text);
    }
  });

  test('a VERSION with no package string still reports its interface', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    writeFileSync(path.join(dir, '.shipline', 'bin', 'VERSION'), '{"interface":3}');
    assert.deepEqual(readRepoVersion(dir), { package: null, interface: 3, files: null, excluded: [] });
  });

  test('files is returned only when it is an object', () => {
    const dir = fresh();
    mkdirSync(path.join(dir, '.shipline', 'bin'), { recursive: true });
    const f = path.join(dir, '.shipline', 'bin', 'VERSION');
    writeFileSync(f, '{"package":"0.6.0","interface":2}');
    assert.deepEqual(readRepoVersion(dir), { package: '0.6.0', interface: 2, files: null, excluded: [] });
    writeFileSync(f, '{"package":"0.7.0","interface":3,"files":["x"]}');
    assert.equal(readRepoVersion(dir).files, null);
    writeFileSync(f, '{"package":"0.7.0","interface":3,"files":{"a":"b"}}');
    assert.deepEqual(readRepoVersion(dir).files, { a: 'b' });
  });
});

describe('compareInterface', () => {
  test('same', () => {
    assert.equal(compareInterface(2, 2), 'same');
    assert.equal(compareInterface({ package: '1.0.0', interface: 1 }, INTERFACE), 'same');
    // 1.0 restarts the interface at 1, so a file with no VERSION reads as interface 1 too: `upgrade` refuses such a repo
    // by its package version (upgrade.test.mjs), not by the interface.
    assert.equal(compareInterface({ legacy: true, interface: 1 }, { interface: INTERFACE }), 'same');
  });
  test('repo older', () => {
    assert.equal(compareInterface(1, 2), 'repo-older');
    assert.equal(compareInterface({ package: '1.0.0', interface: 1 }, 2), 'repo-older');
  });
  test('repo newer', () => {
    assert.equal(compareInterface(4, 3), 'repo-newer');
    assert.equal(compareInterface({ interface: 9 }, INTERFACE), 'repo-newer');
  });
  test('isPreOne: a package below 1.0.0, no package, or no/unreadable VERSION; preOneMessage names the version', () => {
    for (const v of [{ package: '0.14.0', interface: 7 }, { package: '0.6.0', interface: 2 }, { package: null, interface: 1 }, { legacy: true, interface: 1 }, null]) {
      assert.equal(isPreOne(v), true, JSON.stringify(v));
    }
    for (const v of [{ package: '1.0.0', interface: 1 }, { package: '1.2.3', interface: 1 }, { package: '2.0.0', interface: 2 }]) {
      assert.equal(isPreOne(v), false, JSON.stringify(v));
    }
    assert.equal(
      preOneMessage({ package: '0.14.0' }),
      'This repo was set up with a pre-1.0 Shipline (0.14.0). Run `npx @forgeyard/shipline uninstall --yes` then `init`; task data in ~/.shipline is kept.',
    );
    assert.match(preOneMessage({ legacy: true, interface: 1 }), /pre-1\.0 Shipline \(unknown version\)/);
  });

  test('MISSING_BEFORE is empty at interface 1 (the 1.0 baseline)', () => {
    assert.deepEqual(MISSING_BEFORE, []);
  });
});
