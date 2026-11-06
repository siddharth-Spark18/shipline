// Plan item 17: `init` writes .shipline/bin/VERSION (Goal 1), and the version comparison (src/interface.mjs).
// Phase 1: INTERFACE 3, VERSION.files (hashes of the Shipline-owned files and the two virtual entries),
// the allow rules for ~/.shipline, no .shipline/.gitignore, and the @forgeyard/shipline name.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INTERFACE, MISSING_BEFORE, compareInterface, readRepoVersion } from '../src/interface.mjs';
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
  test('with the package version, INTERFACE 7 and the files map, plus a newline', () => {
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
    assert.equal(INTERFACE, 7);
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
  test('settings.json gets the 0.9.0 hook form: each Shipline command checks for node; SessionStart warns, the others || true', () => {
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
      const prefix = `command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR/.shipline/bin/${script[event]}.mjs" || `;
      assert.ok(cmds[0].startsWith(prefix), `${event}: ${cmds[0]}`);
      const fallback = cmds[0].slice(prefix.length);
      if (event === 'SessionStart') assert.match(fallback, /^echo '\{"systemMessage":"Shipline needs Node\.js 18 or newer/);
      else assert.equal(fallback, 'true');
    }
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
    const r = run(process.execPath, [BIN, 'init', dir, '--yes'], { cwd: dir, env: { SHIPLINE_HOME: path.join(blocker, 'home') } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Shipline can't write its task store at /);
    assert.ok(!existsSync(path.join(dir, '.shipline')));
  });

  test('the success message ends with the setup nudge (Teams Phase 1, E)', () => {
    const r = runInit(fresh());
    assert.match(r.stdout, /Next: tailor the rules to this repo\. Run `\/shipline-setup` in Claude Code, or open `npx @forgeyard\/shipline ui` and use Setup -> Set up with Claude\./);
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

describe('ui on old Node', () => {
  const major = Number(process.versions.node.split('.')[0]);
  test('`shipline ui` exits 1 with a message on Node < 20, without loading the UI code', { skip: major >= 20 ? 'runs on Node 18 (the CI test:hooks job)' : false }, () => {
    const dir = fresh();
    assert.equal(runInit(dir).code, 0);
    const r = run(process.execPath, [BIN, 'ui', dir, '--no-open'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /shipline ui requires Node 20 or newer/);
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
    assert.equal(compareInterface({ package: '0.14.0', interface: 7 }, INTERFACE), 'same');
    assert.equal(compareInterface({ package: '0.13.0', interface: 6 }, INTERFACE), 'repo-older');
    assert.equal(compareInterface({ package: '0.11.0', interface: 5 }, INTERFACE), 'repo-older');
    assert.equal(compareInterface({ package: '0.8.0', interface: 4 }, INTERFACE), 'repo-older');
    assert.equal(compareInterface({ package: '0.7.0', interface: 3 }, INTERFACE), 'repo-older');
    assert.equal(compareInterface({ package: '0.6.0', interface: 2 }, INTERFACE), 'repo-older');
  });
  test('repo older, including a legacy repo', () => {
    assert.equal(compareInterface(1, 2), 'repo-older');
    assert.equal(compareInterface({ legacy: true, interface: 1 }, { interface: INTERFACE }), 'repo-older');
  });
  test('repo newer', () => {
    assert.equal(compareInterface(4, 3), 'repo-newer');
    assert.equal(compareInterface({ interface: 9 }, INTERFACE), 'repo-newer');
  });
  test('MISSING_BEFORE names what interface-1 repos lack', () => {
    assert.deepEqual(MISSING_BEFORE, [
      'the lost-task warning',
      'visible warn reminders',
      'task storage outside the repo (the store)',
      'Trust: answer-based confirmations and the CI check',
      'Trust: real check runs, required sections and PR evidence',
      'Guardrails: always-on rails, protected paths, named actions and the Verify scope check',
      'Lighter confirmations: the standard or light preset and checkpoint stages',
    ]);
  });
});
