// Chat input plan (docs/plans/shipline-chat-input.md), Tests: commands.test.mjs. listCommands() scans the repo's and
// the user's .claude/commands/**/*.md and .claude/skills/*/SKILL.md. The user folder always comes from opts.home
// (a temp dir), so these tests never read the real ~/.claude.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { removeDir, tmpDir } from '../helpers.mjs';
import { BUILTIN_COMMANDS, INTERACTIVE_ONLY, listCommands } from '../../src/ui/commands.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) removeDir(d);
});

function scratch() {
  const d = tmpDir('shipline-commands-');
  dirs.push(d);
  const root = path.join(d, 'repo');
  const home = path.join(d, 'home');
  mkdirSync(root);
  mkdirSync(home);
  return { base: d, root, home };
}

function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const byName = (list) => Object.fromEntries(list.map((c) => [c.name, c]));
const SYMLINK_SKIP =
  process.platform === 'win32' &&
  'creating symlinks on Windows needs Developer Mode or admin rights; listing plain folders (the same scan without the link) is covered by "lists repo and user commands, a namespaced subfolder, and skills"';

describe('listCommands', () => {
  test('lists repo and user commands, a namespaced subfolder, and skills', () => {
    const { root, home } = scratch();
    put(path.join(root, '.claude', 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nHello there.\n');
    put(path.join(root, '.claude', 'commands', 'git', 'commit.md'), '# Commit the staged changes\n\nMore text.\n');
    put(path.join(root, '.claude', 'skills', 'plan', 'SKILL.md'), '---\nname: feature-planner\ndescription: Plans a feature\n---\nBody.\n');
    put(path.join(home, '.claude', 'commands', 'mine.md'), 'A user command\n');
    put(path.join(home, '.claude', 'skills', 'retro', 'SKILL.md'), '---\ndescription: Runs a retro\n---\n');

    const list = listCommands(root, { home });
    assert.deepEqual(list, [
      { name: 'git:commit', description: 'Commit the staged changes', source: 'repo', kind: 'command' },
      { name: 'hello', description: 'Say hello', source: 'repo', kind: 'command' },
      { name: 'mine', description: 'A user command', source: 'user', kind: 'command' },
      { name: 'plan', description: 'Plans a feature', source: 'repo', kind: 'skill' },
      { name: 'retro', description: 'Runs a retro', source: 'user', kind: 'skill' },
    ]);
  });

  test('a skill is named by its folder, not its frontmatter name', () => {
    const { root, home } = scratch();
    put(path.join(root, '.claude', 'skills', 'ideate', 'SKILL.md'), '---\nname: feature-ideator\ndescription: Ideas\n---\n');
    const names = listCommands(root, { home }).map((c) => c.name);
    assert.deepEqual(names, ['ideate']);
  });

  test('nested subfolders become folder:sub:name', () => {
    const { root, home } = scratch();
    put(path.join(root, '.claude', 'commands', 'a', 'b', 'c.md'), 'deep\n');
    assert.deepEqual(listCommands(root, { home }).map((c) => c.name), ['a:b:c']);
  });

  test('the description is the frontmatter description, else the first non-empty body line (heading marks stripped)', () => {
    const { root, home } = scratch();
    const cmds = path.join(root, '.claude', 'commands');
    put(path.join(cmds, 'front.md'), '---\ndescription: From frontmatter\n---\nFirst body line\n');
    put(path.join(cmds, 'noFront.md'), '\n\n## Heading line\nsecond\n');
    put(path.join(cmds, 'emptyDesc.md'), '---\nargument-hint: x\n---\n\nBody first line\n');
    put(path.join(cmds, 'blank.md'), '');
    put(path.join(root, '.claude', 'skills', 'nodesc', 'SKILL.md'), '---\nname: nodesc\n---\n# Skill body line\n');
    const m = byName(listCommands(root, { home }));
    assert.equal(m.front.description, 'From frontmatter');
    assert.equal(m.noFront.description, 'Heading line');
    assert.equal(m.emptyDesc.description, 'Body first line');
    assert.equal(m.blank.description, '');
    assert.equal(m.nodesc.description, 'Skill body line');
  });

  test('the repo wins on a name clash (commands and skills)', () => {
    const { root, home } = scratch();
    put(path.join(root, '.claude', 'commands', 'hello.md'), 'repo hello\n');
    put(path.join(home, '.claude', 'commands', 'hello.md'), 'user hello\n');
    put(path.join(root, '.claude', 'skills', 'plan', 'SKILL.md'), '---\ndescription: repo plan\n---\n');
    put(path.join(home, '.claude', 'skills', 'plan', 'SKILL.md'), '---\ndescription: user plan\n---\n');
    const list = listCommands(root, { home });
    assert.deepEqual(
      list.map((c) => [c.name, c.source, c.description]),
      [
        ['hello', 'repo', 'repo hello'],
        ['plan', 'repo', 'repo plan'],
      ],
    );
  });

  test('missing folders, empty folders and non-command files give an empty list', () => {
    const { root, home } = scratch();
    assert.deepEqual(listCommands(root, { home }), [], 'no .claude anywhere');
    assert.deepEqual(listCommands(path.join(root, 'does-not-exist'), { home: path.join(home, 'nope') }), []);
    mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
    mkdirSync(path.join(root, '.claude', 'skills', 'no-skill-md'), { recursive: true });
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    put(path.join(root, '.claude', 'commands', 'notes.txt'), 'not a command\n');
    put(path.join(root, '.claude', 'skills', 'README.md'), 'a file, not a skill folder\n');
    assert.deepEqual(listCommands(root, { home }), []);
  });

  test('a symlinked skill folder and a symlinked commands subfolder are listed', { skip: SYMLINK_SKIP }, () => {
    const { base, root, home } = scratch();
    const shared = path.join(base, 'shared');
    put(path.join(shared, 'skills', 'linked-skill', 'SKILL.md'), '---\ndescription: From a link\n---\n');
    put(path.join(shared, 'cmds', 'deploy.md'), '---\ndescription: Linked command\n---\n');
    mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
    symlinkSync(path.join(shared, 'skills', 'linked-skill'), path.join(root, '.claude', 'skills', 'linked-skill'), 'dir');
    symlinkSync(path.join(shared, 'cmds'), path.join(home, '.claude', 'commands', 'ops'), 'dir');
    // A dangling link is ignored, not an error.
    symlinkSync(path.join(shared, 'gone'), path.join(root, '.claude', 'skills', 'dangling'), 'dir');
    assert.deepEqual(listCommands(root, { home }), [
      { name: 'linked-skill', description: 'From a link', source: 'repo', kind: 'skill' },
      { name: 'ops:deploy', description: 'Linked command', source: 'user', kind: 'command' },
    ]);
  });

  test('the built-in list is empty, so no entry has source builtin', () => {
    assert.deepEqual(BUILTIN_COMMANDS, []);
    const { root, home } = scratch();
    put(path.join(root, '.claude', 'commands', 'x.md'), 'x\n');
    assert.ok(listCommands(root, { home }).every((c) => c.source !== 'builtin'));
    // The interactive-only names the composer refuses (plan A).
    assert.deepEqual([...INTERACTIVE_ONLY].sort(), ['config', 'doctor', 'login', 'logout', 'model', 'permissions', 'terminal-setup']);
  });

  test('a parseYaml passed in opts is used for frontmatter; one that throws counts as no frontmatter', () => {
    const { root, home } = scratch();
    put(path.join(root, '.claude', 'commands', 'y.md'), '---\nwhatever\n---\nBody line\n');
    assert.equal(listCommands(root, { home, parseYaml: () => ({ description: 'custom' }) })[0].description, 'custom');
    assert.equal(
      listCommands(root, {
        home,
        parseYaml: () => {
          throw new Error('bad');
        },
      })[0].description,
      'Body line',
    );
  });
});
