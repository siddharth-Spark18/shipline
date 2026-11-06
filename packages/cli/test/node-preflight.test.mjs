// Chat reliability plan (docs/plans/shipline-chat-reliability.md), G. The missing-Node warning: every Shipline hook
// command in templates/settings-hooks.json checks for `node` first. Without it (or when the script fails),
// SessionStart prints one systemMessage and the other hooks stay silent, all exiting 0, so no tool call fails.
// lib.mjs does the same on a Node older than 18. Node 18+, no dependencies.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, cleanEnv, homeFor, makeRepo, removeDir, stage, tmpDir } from './helpers.mjs';

const WARNING = "Shipline needs Node.js 18 or newer on this machine; its workflow hooks are off until it's installed.";
const SETTINGS = JSON.parse(readFileSync(path.join(CLI_ROOT, 'templates', 'settings-hooks.json'), 'utf8'));
const SESSION = 'np-session';

// [{ event, script, command }] for every Shipline hook command in the template.
const HOOKS = Object.entries(SETTINGS.hooks).flatMap(([event, entries]) =>
  entries.flatMap((e) =>
    e.hooks.map((h) => ({ event, command: h.command, script: /\.shipline\/bin\/([a-z-]+\.mjs)/.exec(h.command)[1] })),
  ),
);

let dir;
let scratch;
const payload = (event) => {
  const base = { session_id: SESSION, cwd: dir, hook_event_name: event };
  if (event === 'SessionStart') return { ...base, source: 'startup' };
  if (event === 'UserPromptSubmit') return { ...base, prompt: 'Add a CSV export' };
  if (event === 'PostToolUse') return { ...base, tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_response: {} };
  return { ...base, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.js'), old_string: 'a', new_string: 'b' } };
};
const hookEnv = (PATH) => ({ ...cleanEnv({ CLAUDE_PROJECT_DIR: dir, SHIPLINE_HOME: homeFor(dir) }), PATH });

// Runs a hook command the way Claude Code does on POSIX: through sh -c, in the repo, with the payload on stdin.
// The payload comes from a file, not a pipe: when node is missing, sh exits without reading stdin, and
// writing to the closed pipe fails with EPIPE (seen on Linux CI).
function viaShell(command, event, PATH) {
  const input = path.join(scratch, `payload-${event}.json`);
  writeFileSync(input, JSON.stringify(payload(event)));
  const fd = openSync(input, 'r');
  try {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: dir, env: hookEnv(PATH), stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    closeSync(fd);
  }
}

before(() => {
  dir = makeRepo({ commitInit: true });
  scratch = tmpDir('shipline-preflight-');
  // No once-per-developer setup nudge: otherwise the first SessionStart run prints it and writes its marker, and the
  // second (the one compared with it) doesn't.
  appendFileSync(path.join(dir, '.shipline', 'config.yml'), '\nsetup: done\n');
  // A started task, so the guard has something to say about an Edit.
  assert.equal(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export'], SESSION).code, 0);
});
after(() => {
  removeDir(dir);
  removeDir(scratch);
});

describe('the hook wrappers (sh -c)', { skip: process.platform === 'win32' && 'POSIX sh only; Claude Code runs hooks through Git Bash on Windows, which this suite does not drive (unverified, see the plan\'s Open Questions)' }, () => {
  test('the template has the four Shipline hooks', () => {
    assert.deepEqual(HOOKS.map((h) => h.script).sort(), ['guard.mjs', 'prompt-submit.mjs', 'record-answer.mjs', 'session-start.mjs']);
  });

  test('no node on PATH: SessionStart prints the warning JSON, the others print nothing; all exit 0', () => {
    const empty = path.join(scratch, 'no-node');
    mkdirSync(empty, { recursive: true });
    for (const h of HOOKS) {
      const r = viaShell(h.command, h.event, empty);
      assert.equal(r.code, 0, `${h.event}: ${r.stderr}`);
      if (h.event === 'SessionStart') assert.deepEqual(JSON.parse(r.stdout), { systemMessage: WARNING });
      else assert.equal(r.stdout, '', h.event);
      assert.equal(r.stderr, '', `${h.event} is quiet on stderr`);
    }
  });

  // 1.0 plan, item 7: the "needs Node" warning is only for a missing node. A node that is there but fails
  // prints nothing from the wrapper: SessionStart passes node's exit code on, the others still exit 0.
  test('a node that exits 1: no "needs Node" warning; SessionStart passes the exit code on, the others exit 0', () => {
    const bin = path.join(scratch, 'broken-node');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(bin, 'node'), 0o755);
    for (const h of HOOKS) {
      const r = viaShell(h.command, h.event, bin);
      assert.equal(r.code, h.event === 'SessionStart' ? 1 : 0, `${h.event}: ${r.stderr}`);
      assert.equal(r.stdout, '', h.event);
      assert.ok(!r.stdout.includes('Shipline needs Node.js'), h.event);
    }
  });

  test('with a real node, the output is what the script itself prints', () => {
    const PATH = [path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
    for (const h of HOOKS) {
      const direct = spawnSync(process.execPath, [path.join(dir, '.shipline', 'bin', h.script)], {
        cwd: dir,
        env: hookEnv(PATH),
        input: JSON.stringify(payload(h.event)),
        encoding: 'utf8',
      });
      const wrapped = viaShell(h.command, h.event, PATH);
      assert.equal(wrapped.code, direct.status, h.event);
      assert.equal(wrapped.stdout, direct.stdout, h.event);
      assert.ok(!wrapped.stdout.includes('Shipline needs Node.js'), `${h.event}: no warning with a working node`);
    }
    // The guard really ran: an Edit before the Plan stage is denied.
    const guard = HOOKS.find((h) => h.script === 'guard.mjs');
    const out = JSON.parse(viaShell(guard.command, guard.event, PATH).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('lib.mjs on a Node older than 18', () => {
  // A preload that makes the script see Node 16 (process.versions is replaced before lib.mjs loads).
  let preload;
  before(() => {
    preload = path.join(scratch, 'old-node.cjs');
    writeFileSync(preload, "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '16.20.2' } });\n");
  });
  const runOld = (script, event) =>
    spawnSync(process.execPath, ['--require', preload, path.join(dir, '.shipline', 'bin', script)], {
      cwd: dir,
      env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, SHIPLINE_HOME: homeFor(dir) }),
      input: JSON.stringify(payload(event)),
      encoding: 'utf8',
    });

  test('session-start.mjs prints the warning systemMessage and exits 0', () => {
    const r = runOld('session-start.mjs', 'SessionStart');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: WARNING });
  });

  test('guard.mjs, prompt-submit.mjs and record-answer.mjs exit 0 silently (the guard does not deny)', () => {
    for (const [script, event] of [['guard.mjs', 'PreToolUse'], ['prompt-submit.mjs', 'UserPromptSubmit'], ['record-answer.mjs', 'PostToolUse']]) {
      const r = runOld(script, event);
      assert.equal(r.status, 0, `${script}: ${r.stderr}`);
      assert.equal(r.stdout, '', script);
    }
  });

  test('stage.mjs is not a hook and is left alone', () => {
    const r = spawnSync(process.execPath, ['--require', preload, path.join(dir, '.shipline', 'bin', 'stage.mjs'), 'workflows'], {
      cwd: dir,
      env: cleanEnv({ SHIPLINE_HOME: homeFor(dir) }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^feature: /m);
  });
});
