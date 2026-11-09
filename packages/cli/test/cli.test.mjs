// Shipline 1.0 (docs/plans/shipline-1.0.md), items 4-7: the strict command line (help, version, -y, --dir, exit 2 on
// unknown options, positional arguments or commands), `init --dry-run` without a terminal, init's warnings (no git, a
// detected tool not on PATH) and its file count. Runs the real bin (children have no terminal). Node 18+.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, CLI_ROOT, git, makeRepo, removeDir, run, storeOf, tmpDir } from './helpers.mjs';
import { toolOnPath } from '../src/detect-commands.mjs';

const VERSION = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version;
const dirs = [];
after(() => dirs.forEach(removeDir));
const fresh = (prefix) => {
  const d = tmpDir(prefix);
  dirs.push(d);
  return d;
};
const cli = (args, cwd = CLI_ROOT, env) => run(process.execPath, [BIN, ...args], { cwd, env });

// Every file under dir (relative, sorted), skipping .git.
function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' && d === dir) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

describe('help and version', () => {
  test('--help, -h, `help` and no arguments print the usage and exit 0', () => {
    for (const args of [['--help'], ['-h'], ['help'], []]) {
      const r = cli(args);
      assert.equal(r.code, 0, args.join(' '));
      assert.match(r.stdout, /^shipline - repo-installed Claude Code workflow\n/, args.join(' '));
      assert.match(r.stdout, /-v, --version {3}Print the version/);
      assert.equal(r.stderr, '');
    }
  });

  test('each command\'s --help / -h prints that command\'s usage, exit 0, and runs nothing', () => {
    const dir = fresh('shipline-cli-help-');
    for (const c of ['init', 'upgrade', 'uninstall', 'ui']) {
      for (const h of ['--help', '-h']) {
        const r = cli([c, h], dir);
        assert.equal(r.code, 0, `${c} ${h}`);
        assert.ok(r.stdout.startsWith(`Usage: npx @forgeyard/shipline ${c} [--dir <path>]`), r.stdout);
        assert.match(r.stdout, /--dir <path> {3}Target folder/);
      }
    }
    // Setup polish plan, item 1: init's help lists --terminal.
    const init = cli(['init', '--help'], dir);
    assert.ok(init.stdout.startsWith('Usage: npx @forgeyard/shipline init [--dir <path>] [--yes] [--dry-run] [--terminal]\n'), init.stdout);
    assert.match(init.stdout, /^ {2}--terminal {5}Ask the questions here instead of opening the setup wizard in the browser$/m);
    assert.match(init.stdout, /In a terminal init opens the setup wizard in your browser/);
    // init --help used to run init: nothing was written.
    assert.deepEqual(readdirSync(dir), []);
  });

  test('--version and -v print the version, alone or after a command', () => {
    for (const args of [['--version'], ['-v'], ['init', '--version'], ['upgrade', '-v'], ['uninstall', '--version']]) {
      const r = cli(args);
      assert.equal(r.code, 0, args.join(' '));
      assert.equal(r.stdout, `${VERSION}\n`, args.join(' '));
    }
    assert.equal(VERSION, '1.1.0');
  });
});

describe('usage errors exit 2 and write nothing', () => {
  test('an unknown option, globally and per command', () => {
    const dir = fresh('shipline-cli-bad-');
    for (const [args, msg] of [
      [['--bogus'], 'shipline: unknown option --bogus (see shipline --help)\n'],
      [['init', '--bogus'], 'shipline: unknown option --bogus (see shipline init --help)\n'],
      [['init', '--yes', '--force'], 'shipline: unknown option --force (see shipline init --help)\n'],
      [['upgrade', '--terminal'], 'shipline: unknown option --terminal (see shipline upgrade --help)\n'],
      [['upgrade', '--purge'], 'shipline: unknown option --purge (see shipline upgrade --help)\n'],
      [['uninstall', '-f'], 'shipline: unknown option -f (see shipline uninstall --help)\n'],
    ]) {
      const r = cli(args, dir);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stderr, msg, args.join(' '));
      assert.equal(r.stdout, '');
    }
    assert.deepEqual(readdirSync(dir), []);
  });

  test('a bare folder argument is an error: use --dir', () => {
    const dir = fresh('shipline-cli-pos-');
    for (const c of ['init', 'upgrade', 'uninstall']) {
      const r = cli([c, 'some/dir', '--yes'], dir);
      assert.equal(r.code, 2, c);
      assert.equal(r.stderr, 'shipline: unexpected argument some/dir (use --dir)\n', c);
    }
    // `upgrade -y` once targeted a folder named "-y"; now it is --yes, and a positional after it is still an error.
    const y = cli(['init', '-y', '.'], dir);
    assert.equal(y.code, 2);
    assert.equal(y.stderr, 'shipline: unexpected argument . (use --dir)\n');
    assert.deepEqual(readdirSync(dir), []);
  });

  test('--dir without a path', () => {
    for (const args of [['init', '--dir'], ['init', '--dir='], ['upgrade', '--yes', '--dir']]) {
      const r = cli(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /^shipline: --dir needs a path \(see shipline (init|upgrade) --help\)\n$/, args.join(' '));
    }
  });

  test('an unknown command prints the help on stdout and exits 2', () => {
    const r = cli(['instal']);
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'shipline: unknown command instal\n\n');
    assert.match(r.stdout, /^shipline - repo-installed Claude Code workflow\n/);
  });
});

describe('--dir and -y', () => {
  test('init --dir <path> -y installs there, from any cwd; --dir=<path> works too', () => {
    const cwd = fresh('shipline-cli-cwd-');
    const a = fresh('shipline-cli-a-');
    const b = fresh('shipline-cli-b-');
    const r = cli(['init', '--dir', a, '-y'], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(files(a).includes('.shipline/config.yml'));
    const r2 = cli(['init', `--dir=${b}`, '--yes'], cwd);
    assert.equal(r2.code, 0, r2.stderr);
    assert.ok(files(b).includes('.shipline/bin/VERSION'));
    assert.deepEqual(readdirSync(cwd), [], 'nothing in the cwd');
  });

  test('upgrade -y and uninstall -y take -y as --yes', () => {
    const dir = makeRepo({ commitInit: true });
    dirs.push(dir);
    const u = cli(['upgrade', '-y', '--dir', dir], dir);
    assert.equal(u.code, 0, u.stderr);
    assert.equal(u.stdout, 'Already up to date.\n');
    const x = cli(['uninstall', '-y', '--dir', dir], dir);
    assert.equal(x.code, 0, x.stderr);
    assert.ok(!files(dir).some((f) => f.startsWith('.shipline/')));
  });

  test('the cwd is the default target', () => {
    const dir = fresh('shipline-cli-default-');
    const r = cli(['init', '--yes'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^Shipline initialized in ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`, 'm'));
  });
});

// 1.0 plan, item 5: without a terminal, a dry run previews what --yes would install instead of refusing.
describe('init --dry-run without a terminal', () => {
  test('previews the --yes defaults, says so, exits 0 and writes nothing (repo or store)', () => {
    const dir = fresh('shipline-cli-dry-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const r = cli(['init', '--dir', dir, '--dry-run'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\+ \.shipline\/bin\/VERSION/);
    assert.match(r.stdout, /= \.claude\/agents\/reviewer\.md \(not installed; recorded as excluded\)/, 'the --yes selection');
    assert.match(r.stdout, /\n\nNo terminal, so this previews the defaults that --yes installs\.\n$/);
    assert.deepEqual(files(dir), ['package.json']);
    assert.ok(!existsSync(storeOf(dir)), 'the store was not created');

    // The same list as --dry-run --yes, minus the note.
    const y = cli(['init', '--dir', dir, '--dry-run', '--yes'], dir);
    assert.equal(y.code, 0, y.stderr);
    assert.ok(!y.stdout.includes('No terminal'), y.stdout);
    assert.equal(r.stdout.replace(/\n\nNo terminal, so this previews the defaults that --yes installs\.\n$/, '\n'), y.stdout);
    assert.deepEqual(files(dir), ['package.json']);
  });

  test('without --dry-run and without --yes it still refuses (exit 1) and writes nothing', () => {
    const dir = fresh('shipline-cli-refuse-');
    const r = cli(['init', '--dir', dir], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /init asks questions, and this is not a terminal\. Run it in a terminal, or pass --yes to install the defaults\./);
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe('init: the file count and the warnings', () => {
  // 1.0 plan, item 7: the count includes VERSION.
  test('"created N files" counts every file written under .shipline/ and .claude/ except settings.json, VERSION included', () => {
    for (const withSettings of [false, true]) {
      const dir = fresh('shipline-cli-count-');
      if (withSettings) {
        mkdirSync(path.join(dir, '.claude'));
        writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}\n');
      }
      const r = cli(['init', '--dir', dir, '--yes'], dir);
      assert.equal(r.code, 0, r.stderr);
      const written = files(dir).filter((f) => /^\.(shipline|claude)\//.test(f) && f !== '.claude/settings.json');
      assert.ok(written.includes('.shipline/bin/VERSION'));
      const m = /created (\d+) files under \.shipline\/ and \.claude\//.exec(r.stdout);
      assert.ok(m, r.stdout);
      assert.equal(Number(m[1]), written.length, written.join(', '));
    }
  });

  test('outside a git repo: installs, then warns after the summary (exit 0)', () => {
    const dir = fresh('shipline-cli-nogit-');
    const r = cli(['init', '--dir', dir, '--yes'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(files(dir).includes('.shipline/config.yml'), 'not refused');
    const at = r.stdout.indexOf('\nWarnings\n');
    assert.ok(at > r.stdout.indexOf('Next steps\n  1. Commit the setup'), 'after the summary');
    assert.ok(
      r.stdout.includes("\nWarnings\n  ! Not a git repository: scope checks, the PR summary's code match and pushes need git. Run `git init` first.\n"),
      r.stdout,
    );
  });

  test('inside a git repo with nothing detected: no Warnings section', () => {
    const dir = fresh('shipline-cli-git-');
    git(dir, 'init', '-q');
    const r = cli(['init', '--dir', dir, '--yes'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('Warnings'), r.stdout);
  });

  // A PATH with only git and sh (POSIX): pytest and ruff, detected from requirements.txt, are not on it.
  test('a detected command whose tool is not on PATH is a warning; the command stays in config.yml', { skip: process.platform === 'win32' && 'builds a PATH from symlinks to git and sh (POSIX); toolOnPath itself is checked on Windows below' }, () => {
    const dir = fresh('shipline-cli-tool-');
    git(dir, 'init', '-q');
    writeFileSync(path.join(dir, 'requirements.txt'), 'pytest==8\nruff\n');
    const bin = fresh('shipline-cli-bin-');
    for (const tool of ['git', 'sh']) {
      const where = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      assert.ok(where, tool);
      symlinkSync(where, path.join(bin, tool));
    }
    const r = cli(['init', '--dir', dir, '--yes'], dir, { PATH: bin });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('Not a git repository'), r.stdout);
    assert.ok(r.stdout.includes('\nWarnings\n  ! Detected `pytest` for test, but `pytest` isn\'t installed here.\n  ! Detected `ruff` for lint, but `ruff` isn\'t installed here.\n'), r.stdout);
    const cfg = readFileSync(path.join(dir, '.shipline', 'config.yml'), 'utf8');
    assert.match(cfg, /^ {2}test: pytest$/m);
    assert.match(cfg, /^ {2}lint: ruff check \.$/m);
  });

  test('toolOnPath: a program on PATH is found; a missing one, a path or anything not a bare name is not', () => {
    const saved = process.env.PATH;
    process.env.PATH = [path.dirname(process.execPath), saved].join(path.delimiter);
    try {
      assert.equal(toolOnPath('node'), true);
      assert.equal(toolOnPath('shipline-no-such-tool-xyz'), false);
      for (const bad of ['', './node', '../x', 'a b', 'x;rm', '$(id)', null, undefined, 3]) assert.equal(toolOnPath(bad), false, String(bad));
    } finally {
      process.env.PATH = saved;
    }
  });
});
