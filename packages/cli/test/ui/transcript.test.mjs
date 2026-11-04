// Plan item 58, Transcript (plan "History", item 51): GET /api/chats/<id> reads Claude's own session file from
// <CLAUDE_CONFIG_DIR>/projects/<munged repo path>/<id>.jsonl (then a scan of projects/*/). The session files in
// test/fixtures/sessions are hand-made stand-ins, not real captures (see the README there).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo, removeDir } from '../helpers.mjs';
import { api, startUi } from './helpers.mjs';
import { SESSIONS_FIXTURES, useFakeClaude } from './chat-helpers.mjs';
import { addChat } from '../../src/ui/sessions.mjs';
import { findTranscript, readHistory } from '../../src/ui/transcript.mjs';

const GOOD = 'aaaaaaaa-0000-4000-8000-000000000001';
const BAD = 'aaaaaaaa-0000-4000-8000-000000000002';
const SCANNED = 'aaaaaaaa-0000-4000-8000-000000000003';
const MISSING = 'aaaaaaaa-0000-4000-8000-000000000004';
const EMPTY = 'aaaaaaaa-0000-4000-8000-000000000005';

let dir;
let fake;
let ui;

const projects = () => path.join(fake.claudeConfig, 'projects');
const munged = () => dir.replace(/[^a-zA-Z0-9]/g, '-');
const place = (fixture, id, folder = munged()) => {
  mkdirSync(path.join(projects(), folder), { recursive: true });
  const to = path.join(projects(), folder, `${id}.jsonl`);
  copyFileSync(path.join(SESSIONS_FIXTURES, fixture), to);
  return to;
};
const entry = (id) => ({ id, title: 't', created: '2026-11-01T00:00:00.000Z', last_active: '2026-11-01T00:00:00.000Z', task_dir: null, status: 'ended' });

before(async () => {
  fake = useFakeClaude(); // sets CLAUDE_CONFIG_DIR to a temp dir
  dir = makeRepo({ commitInit: true });
  for (const id of [GOOD, BAD, SCANNED, MISSING, EMPTY]) addChat(dir, entry(id));
  place('session.jsonl', GOOD);
  place('corrupted.jsonl', BAD);
  place('session.jsonl', SCANNED, '-some-other-checkout');
  mkdirSync(path.join(projects(), munged()), { recursive: true });
  writeFileSync(path.join(projects(), munged(), `${EMPTY}.jsonl`), '\n\n');
  ui = await startUi(dir);
});

after(async () => {
  if (ui) await ui.close();
  removeDir(dir);
  if (fake) fake.cleanup();
});

const EXPECTED = [
  { kind: 'user', text: 'Add a CSV export to the reports page' },
  { kind: 'assistant', text: "I'll start the task." },
  { kind: 'tool-use', id: 'toolu_1', name: 'Bash', summary: 'Bash: node .shipline/bin/stage.mjs start --workflow feature --title "Add export"' },
  { kind: 'tool-result', toolUseId: 'toolu_1', text: 'Started Feature task in docs/shipline/add-export', isError: false },
  { kind: 'tool-use', id: 'toolu_2', name: 'Edit', summary: 'Edit: src/a.js' },
  {
    kind: 'tool-result',
    toolUseId: 'toolu_2',
    text: 'Shipline (Feature workflow, task add-export): Edit on src/a.js needs the "Plan" stage to be done first. Finish it, then record it with: node .shipline/bin/stage.mjs advance Do not work around this; tell the developer what is missing.',
    isError: true,
    notice: 'shipline-block',
  },
  { kind: 'assistant', text: 'The Plan stage has to be done first.' },
];

describe('readHistory', () => {
  test('the fixture session file parses: user, assistant, tool use and results; sidechain, meta and bad lines skipped', () => {
    assert.deepEqual(readHistory(dir, GOOD), { history: EXPECTED });
  });

  test('a file where no line parses is unavailable', () => {
    assert.deepEqual(readHistory(dir, BAD), { unavailable: true });
  });

  test('a missing file gives an empty history (a chat whose first turn has not been written yet)', () => {
    assert.deepEqual(readHistory(dir, MISSING), { history: [] });
  });

  test('a file with only blank lines gives an empty history, not unavailable', () => {
    assert.deepEqual(readHistory(dir, EMPTY), { history: [] });
  });

  test('the direct path is tried first, then a scan of projects/*/', () => {
    assert.equal(findTranscript(dir, GOOD), path.join(projects(), munged(), `${GOOD}.jsonl`));
    assert.equal(findTranscript(dir, SCANNED), path.join(projects(), '-some-other-checkout', `${SCANNED}.jsonl`));
    assert.deepEqual(readHistory(dir, SCANNED), { history: EXPECTED });
  });

  test('a session id that is not a uuid is never used as a path', () => {
    assert.equal(findTranscript(dir, '../../etc/passwd'), null);
    assert.deepEqual(readHistory(dir, '../x'), { history: [] });
  });
});

describe('GET /api/chats/<id>', () => {
  test('returns the chat and its history', async () => {
    const r = await api(ui, 'GET', `/api/chats/${GOOD}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.chat.id, GOOD);
    assert.deepEqual(r.json.history, EXPECTED);
    assert.equal(r.json.unavailable, undefined);
  });

  test('a corrupted session file gives { chat, history: null, unavailable: true }', async () => {
    const r = await api(ui, 'GET', `/api/chats/${BAD}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.chat.id, BAD);
    assert.equal(r.json.history, null);
    assert.equal(r.json.unavailable, true);
  });

  test('a missing session file gives history []', async () => {
    const r = await api(ui, 'GET', `/api/chats/${MISSING}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.history, []);
  });

  test('an unknown chat id is 404 not-found, a non-uuid id too', async () => {
    for (const id of ['bbbbbbbb-0000-4000-8000-000000000009', 'not-a-uuid']) {
      const r = await api(ui, 'GET', `/api/chats/${id}`);
      assert.equal(r.status, 404, id);
      assert.equal(r.json.error.code, 'not-found');
    }
  });
});
