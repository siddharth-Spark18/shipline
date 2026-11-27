// Chat reliability C1.7: the permission rule a card offers to remember (one function, one case per row of the plan's
// table), and the writer that appends it to .claude/settings.local.json.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { removeDir, tmpDir } from '../helpers.mjs';
import { appendAllowRule, localSettingsPath, ruleFor, splitRule } from '../../src/ui/local-settings.mjs';
import { HttpError } from '../../src/ui/http.mjs';

const bash = (command) => ruleFor('Bash', { command });

describe('ruleFor', () => {
  test('Bash, a single simple command: the first word', () => {
    assert.equal(bash('ls'), 'Bash(ls:*)');
    assert.equal(bash('ls -la src'), 'Bash(ls:*)');
    assert.equal(bash('  cat README.md  '), 'Bash(cat:*)');
    assert.equal(bash('node scripts/build.mjs'), 'Bash(node:*)');
  });

  test('Bash, a single command of a tool that needs its sub-command: the first two words', () => {
    for (const tool of ['git', 'npm', 'pnpm', 'yarn', 'npx', 'bunx', 'docker', 'kubectl', 'gh', 'cargo', 'go', 'uv', 'pip', 'pip3', 'poetry', 'make'])
      assert.equal(bash(`${tool} run thing --flag`), `Bash(${tool} run:*)`, tool);
    assert.equal(bash('git status -s'), 'Bash(git status:*)');
    assert.equal(bash('git'), 'Bash(git:*)', 'no second word');
  });

  test('Bash, python -m <module>: python -m and the module; plain python keeps the first word', () => {
    assert.equal(bash('python -m pytest tests/'), 'Bash(python -m pytest:*)');
    assert.equal(bash('python3 -m http.server 8000'), 'Bash(python3 -m http.server:*)');
    assert.equal(bash('python script.py'), 'Bash(python:*)');
    assert.equal(bash('python -m'), 'Bash(python:*)');
  });

  test('Bash, a compound command: the exact command', () => {
    for (const c of [
      'npm test && npm run lint',
      'git pull || echo failed',
      'cd src; ls',
      'cat a.txt | grep foo',
      'echo hi > out.txt',
      'sort < in.txt',
      '(cd src && ls)',
      'echo $(whoami)',
      'echo `whoami`',
      'sleep 5 &',
      'npm test\nnpm run lint',
      'FOO=bar npm test',
    ])
      assert.equal(bash(c), `Bash(${c.replace(/[\\()]/g, (x) => `\\${x}`)})`, c);
    assert.equal(bash('npm test && npm run lint'), 'Bash(npm test && npm run lint)');
  });

  test('Bash with an empty or missing command has no rule', () => {
    assert.equal(bash('   '), null);
    assert.equal(ruleFor('Bash', {}), null);
    assert.equal(ruleFor('Bash', undefined), null);
  });

  test('WebFetch: the domain of the url', () => {
    assert.equal(ruleFor('WebFetch', { url: 'https://docs.example.com/a/b?x=1' }), 'WebFetch(domain:docs.example.com)');
    assert.equal(ruleFor('WebFetch', { url: 'http://localhost:3000/x' }), 'WebFetch(domain:localhost)');
    assert.equal(ruleFor('WebFetch', { url: 'not a url' }), null);
    assert.equal(ruleFor('WebFetch', { url: 'file:///etc/passwd' }), null);
    assert.equal(ruleFor('WebFetch', {}), null);
  });

  test('any other tool: its name', () => {
    assert.equal(ruleFor('Edit', { file_path: 'src/a.js' }), 'Edit');
    assert.equal(ruleFor('Write', { file_path: 'a' }), 'Write');
    assert.equal(ruleFor('mcp__server__tool', { x: 1 }), 'mcp__server__tool');
  });

  test('a question is not a permission: no rule', () => {
    assert.equal(ruleFor('AskUserQuestion', { questions: [] }), null);
    assert.equal(ruleFor('', {}), null);
    assert.equal(ruleFor(undefined, {}), null);
  });
});

describe('splitRule', () => {
  test('a rule becomes the toolName / ruleContent pair of an updatedPermissions entry', () => {
    assert.deepEqual(splitRule('Bash(git status:*)'), { toolName: 'Bash', ruleContent: 'git status:*' });
    assert.deepEqual(splitRule('WebFetch(domain:example.com)'), { toolName: 'WebFetch', ruleContent: 'domain:example.com' });
    assert.deepEqual(splitRule('Edit'), { toolName: 'Edit' });
    assert.deepEqual(splitRule('mcp__a__b'), { toolName: 'mcp__a__b' });
  });
});

describe('appendAllowRule', () => {
  let root;
  const file = () => localSettingsPath(root);
  const read = () => JSON.parse(readFileSync(file(), 'utf8'));
  beforeEach(() => {
    root = tmpDir('shipline-local-settings-');
  });
  afterEach(() => removeDir(root));

  test('creates .claude/settings.local.json (and the folder) as 2-space JSON', () => {
    assert.deepEqual(appendAllowRule(root, 'Bash(git status:*)'), { added: true, file: file() });
    assert.equal(readFileSync(file(), 'utf8'), '{\n  "permissions": {\n    "allow": [\n      "Bash(git status:*)"\n    ]\n  }\n}\n');
  });

  test('keeps every other key and the existing rules, appends at the end', () => {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify({ env: { A: '1' }, permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], defaultMode: 'plan' }, model: 'opus' }));
    appendAllowRule(root, 'Edit');
    assert.deepEqual(read(), { env: { A: '1' }, permissions: { allow: ['Read', 'Edit'], deny: ['Bash(rm:*)'], defaultMode: 'plan' }, model: 'opus' });
  });

  test('a rule that is already there is not added twice', () => {
    appendAllowRule(root, 'Edit');
    assert.deepEqual(appendAllowRule(root, 'Edit'), { added: false, file: file() });
    assert.deepEqual(read().permissions.allow, ['Edit']);
  });

  test('adds permissions.allow to a file that has permissions without it', () => {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify({ permissions: { deny: ['X'] } }));
    appendAllowRule(root, 'Edit');
    assert.deepEqual(read(), { permissions: { deny: ['X'], allow: ['Edit'] } });
  });

  test('invalid JSON, or a shape that is not an object / list: 409 settings-unreadable naming the file, the file untouched', () => {
    mkdirSync(path.dirname(file()), { recursive: true });
    for (const text of ['{ nope', '[]', 'null', '{"permissions": []}', '{"permissions": {"allow": "Read"}}']) {
      writeFileSync(file(), text);
      assert.throws(
        () => appendAllowRule(root, 'Edit'),
        (e) => e instanceof HttpError && e.status === 409 && e.code === 'settings-unreadable' && e.message.includes(file()),
        text,
      );
      assert.equal(readFileSync(file(), 'utf8'), text);
    }
  });

  test('writes through a temporary file: nothing is left next to it', () => {
    appendAllowRule(root, 'Edit');
    assert.deepEqual(readdirSync(path.dirname(file())), ['settings.local.json']);
    assert.equal(existsSync(path.join(root, '.claude', 'settings.json')), false);
  });
});
