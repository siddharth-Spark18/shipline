// Plan A (docs/plans/shipline-2-2-0-hotfix.md), A3: run-hook.mjs, the launcher every hook command goes through. A
// crash in a hook (or in lib.mjs) fails open but says so; output the hook already printed is never followed by a
// second JSON object. Node 18+ (test:hooks).
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, hook, makeRepo, removeDir, run, tmpDir } from './helpers.mjs';

const RUN_HOOK = path.join(CLI_ROOT, 'templates', 'shipline', 'bin', 'run-hook.mjs');
const dirs = [];
after(() => dirs.forEach(removeDir));

// A folder with run-hook.mjs and the given stand-ins for the hook scripts.
function fakeBin(files) {
  const dir = tmpDir('shipline-run-hook-');
  dirs.push(dir);
  copyFileSync(RUN_HOOK, path.join(dir, 'run-hook.mjs'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}
const launch = (dir, name) => run(process.execPath, [path.join(dir, 'run-hook.mjs'), ...(name ? [name] : [])], { cwd: dir, input: '{}' });

describe('run-hook.mjs', () => {
  test('a script that throws on import: one systemMessage JSON on stdout, exit 0', () => {
    const dir = fakeBin({ 'guard.mjs': "throw new Error('boom: first line\\nsecond line');\n" });
    const r = launch(dir, 'guard');
    assert.equal(r.code, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(json), ['systemMessage']);
    assert.match(json.systemMessage, /^Shipline guard hook crashed: boom: first line\. Its checks are off for this call; run `npx @forgeyard\/shipline upgrade` or fix \.shipline\/bin\.$/);
    assert.ok(!json.systemMessage.includes('second line'));
  });

  test('a missing script file crashes visibly too', () => {
    const r = launch(fakeBin({}), 'session-start');
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).systemMessage, /^Shipline session-start hook crashed: /);
  });

  test('an unknown hook name: a systemMessage, exit 0', () => {
    for (const name of ['nope', '../lib', undefined]) {
      const r = launch(fakeBin({}), name);
      assert.equal(r.code, 0, r.stderr);
      assert.match(JSON.parse(r.stdout).systemMessage, /^Shipline run-hook: unknown hook/);
    }
  });

  test('an error thrown after the script printed: stdout stays that one object, the message goes to stderr', () => {
    const dir = fakeBin({
      'guard.mjs': "process.stdout.write(JSON.stringify({ decision: 'kept' }));\nawait Promise.resolve();\nthrow new Error('late failure');\n",
    });
    const r = launch(dir, 'guard');
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { decision: 'kept' });
    assert.match(r.stderr, /Shipline guard hook crashed: late failure/);
  });

  test('an unhandled rejection after the import is caught the same way', () => {
    const dir = fakeBin({ 'guard.mjs': "setTimeout(() => { Promise.reject(new Error('async failure')); }, 5);\n" });
    const r = launch(dir, 'guard');
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).systemMessage, /Shipline guard hook crashed: async failure/);
  });

  test('a normal guard deny passes through unchanged', () => {
    const repo = makeRepo({ commitInit: true });
    dirs.push(repo);
    const r = run(process.execPath, [path.join(repo, '.shipline', 'bin', 'run-hook.mjs'), 'guard'], {
      cwd: repo,
      input: JSON.stringify({ session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node .shipline/bin/record-answer.mjs' } }),
    });
    assert.equal(r.code, 0, r.stderr);
    const direct = hook(repo, 'guard.mjs', { session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node .shipline/bin/record-answer.mjs' } });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(r.stdout, direct.stdout);
  });

  test('a lib.mjs with a syntax error is reported on every hook', () => {
    const repo = makeRepo({ commitInit: true });
    dirs.push(repo);
    writeFileSync(path.join(repo, '.shipline', 'bin', 'lib.mjs'), 'export const = ;\n');
    for (const name of ['guard', 'session-start', 'prompt-submit', 'record-answer']) {
      const r = run(process.execPath, [path.join(repo, '.shipline', 'bin', 'run-hook.mjs'), name], { cwd: repo, input: JSON.stringify({ session_id: 's', cwd: repo }) });
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
      assert.match(JSON.parse(r.stdout).systemMessage, new RegExp(`^Shipline ${name} hook crashed: `), name);
    }
  });
});

describe('settings-hooks.json', () => {
  const settings = JSON.parse(readFileSync(path.join(CLI_ROOT, 'templates', 'settings-hooks.json'), 'utf8'));
  const commands = Object.values(settings.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));

  test('every hook runs through run-hook.mjs, with no `|| true`, and says so when node is missing', () => {
    assert.equal(commands.length, 4);
    for (const c of commands) {
      assert.ok(!c.includes('|| true'), c);
      assert.match(c, /^if command -v node >\/dev\/null 2>&1; then node "\$CLAUDE_PROJECT_DIR\/\.shipline\/bin\/run-hook\.mjs" (guard|session-start|prompt-submit|record-answer); else echo '.*Node\.js 18 or newer.*'; fi$/, c);
    }
    assert.deepEqual(commands.map((c) => c.match(/run-hook\.mjs" ([\w-]+);/)[1]).sort(), ['guard', 'prompt-submit', 'record-answer', 'session-start']);
  });
});
