// Teams Phase 1, E: until /shipline-setup has written `setup: done` to config.yml, the SessionStart hook adds a
// systemMessage once per developer (a marker at <store>/state/setup-nudged). Any error there is ignored: no
// message, exit 0, and the resume context is still printed. Node 18+.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { hook, makeRepo, removeDir, storeOf } from './helpers.mjs';

const NUDGE = 'Shipline is using its default rules here. Run /shipline-setup to tailor them to this repo.';
const dirs = [];
after(() => dirs.forEach(removeDir));

const repo = () => {
  const dir = makeRepo();
  dirs.push(dir);
  return dir;
};
const marker = (dir) => path.join(storeOf(dir), 'state', 'setup-nudged');
const sessionStart = (dir, id) => {
  const r = hook(dir, 'session-start.mjs', { session_id: id, cwd: dir, hook_event_name: 'SessionStart' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.json.hookSpecificOutput.additionalContext, new RegExp(`^Shipline is installed\\. Session id: ${id} `));
  return r;
};

test('the nudge shows on the first session only: the marker then suppresses it', () => {
  const dir = repo();
  assert.ok(!existsSync(marker(dir)));
  const first = sessionStart(dir, 'one');
  assert.equal(first.json.systemMessage, NUDGE);
  assert.ok(existsSync(marker(dir)), 'the marker is written in the store');
  const second = sessionStart(dir, 'two');
  assert.ok(!('systemMessage' in second.json), second.stdout);
  // Removing the marker (a new developer, a new store) brings it back.
  rmSync(marker(dir));
  assert.equal(sessionStart(dir, 'three').json.systemMessage, NUDGE);
});

test('no nudge, and no marker written, once config.yml has setup: done', () => {
  const dir = repo();
  appendFileSync(path.join(dir, '.shipline', 'config.yml'), '\nsetup: done\n');
  const r = sessionStart(dir, 'done');
  assert.ok(!('systemMessage' in r.json), r.stdout);
  assert.ok(!existsSync(marker(dir)));
});

test('any other setup value still nudges', () => {
  const dir = repo();
  appendFileSync(path.join(dir, '.shipline', 'config.yml'), '\nsetup: pending\n');
  assert.equal(sessionStart(dir, 'pending').json.systemMessage, NUDGE);
});

test('an error writing the marker: no message, exit 0, and the session context is still printed', {
  skip: process.platform === 'win32' && 'uses a dangling symlink to make the write fail; creating symlinks needs extra rights on Windows',
}, () => {
  const dir = repo();
  // A dangling symlink as the marker: existsSync says no, and the write fails (its target's folder is missing).
  mkdirSync(path.dirname(marker(dir)), { recursive: true });
  symlinkSync(path.join(storeOf(dir), 'missing-folder', 'target'), marker(dir));
  const r = sessionStart(dir, 'broken');
  assert.ok(!('systemMessage' in r.json), r.stdout);
  assert.equal(r.stderr, '');
  // The same with the marker as a folder: it counts as written, so no message either.
  unlinkSync(marker(dir));
  mkdirSync(marker(dir));
  assert.ok(!('systemMessage' in sessionStart(dir, 'dir-marker').json));
});
