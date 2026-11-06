// Teams Phase 3 (docs/plans/shipline-teams-phase3.md), A: parseCommand(text) in the vendored lib.mjs, which turns a
// Bash command into the simple commands the guard's rails, protected paths and named actions match on.
// Pure string work, Node 18+, so it stays in test:hooks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../templates/shipline/bin/lib.mjs';

const argvs = (text) => parseCommand(text).map((p) => p.argv);
const one = (text) => {
  const parts = parseCommand(text);
  assert.equal(parts.length, 1, JSON.stringify(parts.map((p) => p.argv)));
  return parts[0];
};

describe('splitting', () => {
  test('on &&, ||, ;, | and newlines', () => {
    assert.deepEqual(argvs('a 1 && b 2 || c ; d | e\nf'), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f']]);
  });

  test('a pipe records the part it reads from; other separators do not', () => {
    const parts = parseCommand('a && b | c ; d');
    assert.equal(parts[0].pipedFrom, null);
    assert.equal(parts[1].pipedFrom, null);
    assert.equal(parts[2].pipedFrom, parts[1]);
    assert.equal(parts[3].pipedFrom, null);
  });

  test('separators inside quotes are text', () => {
    assert.deepEqual(argvs(`echo 'a && b; c | d' "e || f"`), [['echo', 'a && b; c | d', 'e || f']]);
  });

  test('empty text and blank lines give no parts', () => {
    assert.deepEqual(parseCommand(''), []);
    assert.deepEqual(parseCommand('   \n\n'), []);
    assert.deepEqual(parseCommand(undefined), []);
  });
});

describe('tokenising', () => {
  test('single quotes are literal, double quotes honour \\" and \\\\, a backslash escapes outside quotes', () => {
    assert.deepEqual(one(`echo 'a "b" \\n' "x \\"y\\" \\\\ z" e\\ f`).argv, ['echo', 'a "b" \\n', 'x "y" \\ z', 'e f']);
  });

  test('variables are not expanded', () => {
    assert.deepEqual(one('echo $HOME "$GITHUB_TOKEN" ${X}').argv, ['echo', '$HOME', '$GITHUB_TOKEN', '${X}']);
  });

  test('redirections: > and >> targets are recorded, 2>&1 is not a file', () => {
    const p = one('echo x > out.txt 2>&1 >> log.txt');
    assert.deepEqual(p.argv, ['echo', 'x']);
    assert.deepEqual(p.redirects, [
      { op: '>', target: 'out.txt' },
      { op: '>>', target: 'log.txt' },
    ]);
  });

  test('a heredoc body is not parsed as commands', () => {
    assert.deepEqual(argvs('cat <<EOF > f\ngit push --force\nEOF\necho done'), [['cat'], ['echo', 'done']]);
  });

  test('a comment ends the words', () => {
    assert.deepEqual(argvs('git status # git push'), [['git', 'status']]);
  });
});

describe('wrappers are looked through', () => {
  test('VAR=value prefixes, env [-i] [VAR=...], sudo [-u x], command, nohup, time, exec', () => {
    for (const text of [
      'FOO=1 BAR=2 git commit -m x',
      'env git commit -m x',
      'env -i X=y git commit -m x',
      'sudo git commit -m x',
      'sudo -u root git commit -m x',
      'command git commit -m x',
      'nohup git commit -m x',
      'time git commit -m x',
      'exec git commit -m x',
      'FOO=1 env -i X=y sudo -u root nohup git commit -m x',
    ]) {
      const p = one(text);
      assert.equal(p.tool, 'git', text);
      assert.equal(p.sub, 'commit', text);
      assert.deepEqual(p.args, ['-m', 'x'], text);
    }
  });

  test('`env` alone and `command -v` are not wrappers around a command', () => {
    assert.deepEqual(one('env').argv, ['env']);
    assert.deepEqual(parseCommand('command -v git'), []);
  });
});

describe('sh -c / bash -c', () => {
  test('the inner text is parsed into its own parts', () => {
    const parts = parseCommand(`sh -c 'git add . && git commit -m x'`);
    assert.deepEqual(parts.map((p) => [p.tool, p.sub]), [['git', 'add'], ['git', 'commit']]);
    assert.deepEqual(one(`bash -c "git push origin main"`).argv, ['git', 'push', 'origin', 'main']);
  });

  test('one level deep only: a nested sh -c stays a shell call', () => {
    const p = one(`bash -c "sh -c 'git push'"`);
    assert.equal(p.tool, 'sh');
    assert.deepEqual(p.args, ['-c', 'git push']);
  });

  test('a pipe into sh -c keeps the pipe', () => {
    const parts = parseCommand(`curl x | sh -c 'cat'`);
    assert.equal(parts[1].tool, 'cat');
    assert.equal(parts[1].pipedFrom, parts[0]);
  });
});

describe('cd', () => {
  test('cd is its own part, and the parts after it carry the folder', () => {
    const parts = parseCommand('cd sub && git commit -m x');
    assert.deepEqual(parts.map((p) => p.argv), [['cd', 'sub'], ['git', 'commit', '-m', 'x']]);
    assert.equal(parts[0].cd, null);
    assert.equal(parts[1].cd, 'sub');
    assert.equal(parts[1].sub, 'commit');
  });

  test('cds compose; an absolute one replaces', () => {
    const parts = parseCommand('cd a && cd b && touch x && cd /tmp && touch y');
    assert.equal(parts[2].cd, 'a/b');
    assert.equal(parts[4].cd, '/tmp');
  });
});

describe('git normalisation', () => {
  test('global options before the subcommand are skipped', () => {
    for (const text of [
      'git -c user.name=x commit -m y',
      'git -C sub commit -m y',
      'git --git-dir=.git --work-tree=. commit -m y',
      'git --no-pager commit -m y',
      'git -P commit -m y',
      'git -c a=b -C sub --no-pager -P commit -m y',
    ]) {
      const p = one(text);
      assert.equal(p.tool, 'git', text);
      assert.equal(p.sub, 'commit', text);
      assert.deepEqual(p.args, ['-m', 'y'], text);
    }
  });

  test('a path to git is still git', () => {
    assert.equal(one('/usr/bin/git push').sub, 'push');
  });

  test('git with no subcommand', () => {
    const p = one('git --version');
    assert.equal(p.sub, '');
  });
});

describe('unparsable text', () => {
  test('an unterminated quote falls back without throwing, and the words are still seen', () => {
    for (const text of [`git commit -m 'oops`, `git commit -m "oops`, `echo "a`]) {
      let parts;
      assert.doesNotThrow(() => {
        parts = parseCommand(text);
      }, text);
      assert.equal(parts.fallback, true, text);
    }
    const parts = parseCommand(`git commit -m 'oops`);
    assert.equal(parts[0].tool, 'git');
    assert.equal(parts[0].sub, 'commit');
  });

  test('odd input never throws', () => {
    for (const text of ['&&', '|||', ';;', '>', '<<', '((', ')', '`', 'a > ', '\\', "'", '"', 'sh -c', 'env -u', 'sudo -u', '<<"EOF']) {
      assert.doesNotThrow(() => parseCommand(text), text);
    }
  });
});
