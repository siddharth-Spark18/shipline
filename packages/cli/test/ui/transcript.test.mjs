// Plan item 58, Transcript (plan "History", item 51), and chat reliability C1.1/C1.3/C1.4a: GET /api/chats/<id> reads Claude's own session file from
// <CLAUDE_CONFIG_DIR>/projects/<munged repo path>/<id>.jsonl (then a scan of projects/*/). The session files in
// test/fixtures/sessions are hand-made stand-ins, not real captures (see the README there).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeFor, makeRepo, removeDir } from '../helpers.mjs';
import { api, startUi } from './helpers.mjs';
import { SESSIONS_FIXTURES, useFakeClaude } from './chat-helpers.mjs';
import { addChat } from '../../src/ui/sessions.mjs';
import { findTranscript, readEntries, readTranscriptImage } from '../../src/ui/transcript.mjs';

const GOOD = 'aaaaaaaa-0000-4000-8000-000000000001';
const BAD = 'aaaaaaaa-0000-4000-8000-000000000002';
const SCANNED = 'aaaaaaaa-0000-4000-8000-000000000003';
const MISSING = 'aaaaaaaa-0000-4000-8000-000000000004';
const EMPTY = 'aaaaaaaa-0000-4000-8000-000000000005';
const IMAGES = 'aaaaaaaa-0000-4000-8000-000000000006';
const SPECIAL = 'aaaaaaaa-0000-4000-8000-000000000007';
const OPEN_TOOLS = 'aaaaaaaa-0000-4000-8000-000000000008';
const LONG = 'aaaaaaaa-0000-4000-8000-000000000009';

// Chat input plan, B. History: user entries carrying image blocks (as claude writes them for a stream-json
// message with images). Image entries come in order, before the text they were sent with, and are served by reference.
const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQSkZJRg==';
const GIF = 'R0lGODlhAQABAA==';
const imageBlock = (media_type, data) => ({ type: 'image', source: { type: 'base64', media_type, data } });
const IMAGE_SESSION = [
  { type: 'user', uuid: 'iu-1', message: { role: 'user', content: [imageBlock('image/png', PNG), imageBlock('image/jpeg', JPEG), { type: 'text', text: 'What are these?' }] } },
  { type: 'assistant', uuid: 'iu-2', message: { role: 'assistant', content: [{ type: 'text', text: 'Two screenshots.' }] } },
  // Images only, no text block.
  { type: 'user', uuid: 'iu-3', message: { role: 'user', content: [imageBlock('image/gif', GIF)] } },
  // Not base64 (a url source) or with no data: skipped.
  { type: 'user', uuid: 'iu-4', message: { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png' } }, { type: 'text', text: 'and this' }] } },
  // A sidechain's images are not shown.
  { type: 'user', uuid: 'iu-5', isSidechain: true, message: { role: 'user', content: [imageBlock('image/png', PNG)] } },
]
  .map((e) => JSON.stringify(e))
  .join('\n');
const IMAGE_ENTRIES = [
  { type: 'image', ref: 't:iu-1:0', media_type: 'image/png' },
  { type: 'image', ref: 't:iu-1:1', media_type: 'image/jpeg' },
  { type: 'user', text: 'What are these?' },
  { type: 'text', text: 'Two screenshots.', key: 'iu-2:0' },
  { type: 'image', ref: 't:iu-3:0', media_type: 'image/gif' },
  { type: 'user', text: 'and this' },
];

// C1.3: what must not show as a user bubble. A compact summary, a slash command's stdout, a command line, an interrupt.
const SPECIAL_SESSION = [
  { type: 'user', uuid: 'sp-1', message: { role: 'user', content: '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the diff</command-args>' } },
  { type: 'user', uuid: 'sp-2', message: { role: 'user', content: '<local-command-stdout>Total cost: $0.01</local-command-stdout>' } },
  { type: 'user', uuid: 'sp-3', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation. Summary: ...' }] } },
  { type: 'user', uuid: 'sp-4', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
  { type: 'user', uuid: 'sp-5', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  { type: 'user', uuid: 'sp-6', message: { role: 'user', content: 'yes' } },
  { type: 'user', uuid: 'sp-7', message: { role: 'user', content: 'yes' } },
]
  .map((e) => JSON.stringify(e))
  .join('\n');
const SPECIAL_ENTRIES = [
  { type: 'user', text: '/review the diff' },
  { type: 'notice', level: 'info', text: 'Total cost: $0.01' },
  { type: 'compact', text: 'This session is being continued from a previous conversation. Summary: ...' },
  { type: 'notice', level: 'info', text: 'Interrupted' },
  // Repeated identical messages are all kept.
  { type: 'user', text: 'yes' },
  { type: 'user', text: 'yes' },
];

// C1.4a: tool calls with no result. toolu_a resolved; toolu_b was in an earlier turn; toolu_c is from the last turn.
const tu = (id, uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 9' } }] } });
const OPEN_SESSION = [
  { type: 'user', uuid: 'ot-1', message: { role: 'user', content: 'first' } },
  tu('toolu_a', 'ot-2'),
  { type: 'user', uuid: 'ot-3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] } },
  tu('toolu_b', 'ot-4'),
  { type: 'user', uuid: 'ot-5', message: { role: 'user', content: 'second' } },
  tu('toolu_c', 'ot-6'),
]
  .map((e) => JSON.stringify(e))
  .join('\n');

// C1.3 paging: 1200 entries (600 user + assistant pairs).
const LONG_SESSION = Array.from({ length: 600 }, (_, i) => [
  JSON.stringify({ type: 'user', uuid: `lu-${i}`, message: { role: 'user', content: `question ${i}` } }),
  JSON.stringify({ type: 'assistant', uuid: `la-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }),
])
  .flat()
  .join('\n');

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
const write = (id, text) => {
  mkdirSync(path.join(projects(), munged()), { recursive: true });
  writeFileSync(path.join(projects(), munged(), `${id}.jsonl`), text + '\n');
};
const entry = (id) => ({ id, title: 't', created: '2026-11-01T00:00:00.000Z', last_active: '2026-11-01T00:00:00.000Z', task_dir: null, status: 'ended' });

before(async () => {
  fake = useFakeClaude(); // sets CLAUDE_CONFIG_DIR to a temp dir
  dir = makeRepo({ commitInit: true });
  process.env.SHIPLINE_HOME = homeFor(dir); // addChat writes sessions.json in the repo's store, in this process
  for (const id of [GOOD, BAD, SCANNED, MISSING, EMPTY, IMAGES, SPECIAL, OPEN_TOOLS, LONG]) addChat(dir, entry(id));
  place('session.jsonl', GOOD);
  place('corrupted.jsonl', BAD);
  place('session.jsonl', SCANNED, '-some-other-checkout');
  mkdirSync(path.join(projects(), munged()), { recursive: true });
  writeFileSync(path.join(projects(), munged(), `${EMPTY}.jsonl`), '\n\n');
  write(IMAGES, IMAGE_SESSION);
  write(SPECIAL, SPECIAL_SESSION);
  write(OPEN_TOOLS, OPEN_SESSION);
  write(LONG, LONG_SESSION);
  ui = await startUi(dir);
});

after(async () => {
  if (ui) await ui.close();
  removeDir(dir);
  if (fake) fake.cleanup();
});

const EXPECTED = [
  { type: 'user', text: 'Add a CSV export to the reports page' },
  { type: 'text', text: "I'll start the task.", key: 'u-2:0' },
  { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: 'Bash: node .shipline/bin/stage.mjs start --workflow feature --title "Add export"', key: 'u-2:1' },
  { type: 'tool_result', toolUseId: 'toolu_1', text: 'Started Feature task in /home/dev/.shipline/projects/-home-dev-repo/tasks/add-export', isError: false, key: 'u-3:0' },
  { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: 'Edit: src/a.js', key: 'u-6:0' },
  {
    type: 'tool_result',
    toolUseId: 'toolu_2',
    text: 'Shipline (Feature workflow, task add-export): Edit on src/a.js needs the "Plan" stage to be done first. Finish it, then record it with: node .shipline/bin/stage.mjs advance Do not work around this; tell the developer what is missing.',
    isError: true,
    outcome: 'blocked',
    key: 'u-7:0',
  },
  {
    type: 'notice',
    level: 'blocked',
    text: 'Shipline (Feature workflow, task add-export): Edit on src/a.js needs the "Plan" stage to be done first. Finish it, then record it with: node .shipline/bin/stage.mjs advance Do not work around this; tell the developer what is missing.',
  },
  { type: 'text', text: 'The Plan stage has to be done first.', key: 'u-8:0' },
];

// What the page route returns: the entries with their pos and ver (equal for a transcript), no keys.
const numbered = (list) => list.map(({ key, ...e }, i) => ({ ...e, pos: i + 1, ver: i + 1 }));

describe('readEntries', () => {
  test('the fixture session file parses: user, assistant, tool use and results; sidechain, meta and bad lines skipped', () => {
    assert.deepEqual(readEntries(dir, GOOD), { entries: EXPECTED });
  });

  test('a file where no line parses is unavailable', () => {
    assert.deepEqual(readEntries(dir, BAD), { unavailable: true });
  });

  test('a missing file gives no entries (a chat whose first turn has not been written yet)', () => {
    assert.deepEqual(readEntries(dir, MISSING), { entries: [] });
  });

  test('a file with only blank lines gives no entries, not unavailable', () => {
    assert.deepEqual(readEntries(dir, EMPTY), { entries: [] });
  });

  test('the direct path is tried first, then a scan of projects/*/', () => {
    assert.equal(findTranscript(dir, GOOD), path.join(projects(), munged(), `${GOOD}.jsonl`));
    assert.equal(findTranscript(dir, SCANNED), path.join(projects(), '-some-other-checkout', `${SCANNED}.jsonl`));
    assert.deepEqual(readEntries(dir, SCANNED), { entries: EXPECTED });
  });

  test('image blocks become image entries with a reference, in order, before the text they came with', () => {
    assert.deepEqual(readEntries(dir, IMAGES), { entries: IMAGE_ENTRIES });
  });

  test('a session id that is not a uuid is never used as a path', () => {
    assert.equal(findTranscript(dir, '../../etc/passwd'), null);
    assert.deepEqual(readEntries(dir, '../x'), { entries: [] });
  });

  test('a compact summary, a command\'s stdout, a command line and an interrupt are not user bubbles; identical messages all stay', () => {
    assert.deepEqual(readEntries(dir, SPECIAL), { entries: SPECIAL_ENTRIES });
  });

  test('tool calls with no result are cancelled: all of them for a chat that is not running, only older turns for a running busy one', () => {
    const idle = readEntries(dir, OPEN_TOOLS).entries;
    assert.deepEqual(idle[idle.length - 1], { type: 'tools_cancelled', ids: ['toolu_b', 'toolu_c'] });
    const running = readEntries(dir, OPEN_TOOLS, { running: true, busy: true }).entries;
    assert.deepEqual(running[running.length - 1], { type: 'tools_cancelled', ids: ['toolu_b'] });
    // Running but between turns counts as not busy.
    const between = readEntries(dir, OPEN_TOOLS, { running: true, busy: false }).entries;
    assert.deepEqual(between[between.length - 1], { type: 'tools_cancelled', ids: ['toolu_b', 'toolu_c'] });
    assert.equal(readEntries(dir, GOOD).entries.some((e) => e.type === 'tools_cancelled'), false);
  });

  test('readTranscriptImage reads the n-th base64 image of the line with that uuid', () => {
    assert.deepEqual(readTranscriptImage(dir, IMAGES, 'iu-1', 0), { media_type: 'image/png', data: PNG });
    assert.deepEqual(readTranscriptImage(dir, IMAGES, 'iu-1', 1), { media_type: 'image/jpeg', data: JPEG });
    assert.equal(readTranscriptImage(dir, IMAGES, 'iu-1', 2), null);
    assert.equal(readTranscriptImage(dir, IMAGES, 'no-such-uuid', 0), null);
    assert.equal(readTranscriptImage(dir, MISSING, 'iu-1', 0), null);
  });
});

describe('GET /api/chats/<id>', () => {
  test('returns the chat and its entries with pos and ver, an epoch and the version', async () => {
    const r = await api(ui, 'GET', `/api/chats/${GOOD}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.chat.id, GOOD);
    assert.deepEqual(r.json.entries, numbered(EXPECTED));
    assert.equal(r.json.version, EXPECTED.length);
    assert.match(r.json.epoch, /^[0-9a-f]{12}$/);
    assert.equal(r.json.has_earlier, false);
    assert.equal(r.json.queue, null);
    assert.equal(r.json.unavailable, undefined);
    assert.equal(r.json.history, undefined);
  });

  test('the epoch stays the same while the file is unchanged, and changes when it is', async () => {
    const a = await api(ui, 'GET', `/api/chats/${SCANNED}`);
    const b = await api(ui, 'GET', `/api/chats/${SCANNED}`);
    assert.equal(a.json.epoch, b.json.epoch);
    const file = findTranscript(dir, SCANNED);
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'user', uuid: 'late-1', message: { role: 'user', content: 'added in a terminal' } }) + '\n');
    const c = await api(ui, 'GET', `/api/chats/${SCANNED}`);
    assert.notEqual(c.json.epoch, a.json.epoch);
    assert.equal(c.json.entries[c.json.entries.length - 1].text, 'added in a terminal');
  });

  test('returns image entries by reference, and GET images/<ref> serves them', async () => {
    const r = await api(ui, 'GET', `/api/chats/${IMAGES}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.entries, numbered(IMAGE_ENTRIES));
    const img = await api(ui, 'GET', `/api/chats/${IMAGES}/images/${encodeURIComponent('t:iu-1:1')}`);
    assert.equal(img.status, 200);
    assert.deepEqual(img.json, { media_type: 'image/jpeg', data: JPEG });
    const gone = await api(ui, 'GET', `/api/chats/${IMAGES}/images/${encodeURIComponent('t:iu-1:9')}`);
    assert.equal(gone.status, 404);
    const live = await api(ui, 'GET', `/api/chats/${IMAGES}/images/${encodeURIComponent('l:3:0')}`);
    assert.equal(live.status, 404, 'a live image of a log that has none');
    const bad = await api(ui, 'GET', `/api/chats/${IMAGES}/images/nonsense`);
    assert.equal(bad.status, 400);
  });

  test('a corrupted session file gives an empty log flagged unavailable', async () => {
    const r = await api(ui, 'GET', `/api/chats/${BAD}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.chat.id, BAD);
    assert.deepEqual(r.json.entries, []);
    assert.equal(r.json.unavailable, true);
  });

  test('a missing session file gives no entries', async () => {
    const r = await api(ui, 'GET', `/api/chats/${MISSING}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.entries, []);
    assert.equal(r.json.version, 0);
  });

  test('an unknown chat id is 404 not-found, a non-uuid id too', async () => {
    for (const id of ['bbbbbbbb-0000-4000-8000-000000000009', 'not-a-uuid']) {
      const r = await api(ui, 'GET', `/api/chats/${id}`);
      assert.equal(r.status, 404, id);
      assert.equal(r.json.error.code, 'not-found');
    }
  });

  test('a transcript of an ended chat with an unresolved tool_use gives it as cancelled', async () => {
    const r = await api(ui, 'GET', `/api/chats/${OPEN_TOOLS}`);
    const last = r.json.entries[r.json.entries.length - 1];
    assert.equal(last.type, 'tools_cancelled');
    assert.deepEqual(last.ids, ['toolu_b', 'toolu_c']);
  });
});

describe('paging (C1.3)', () => {
  test('a 1200-entry transcript: the first page is the last 200, `before` pages walk back, has_earlier is false at the start', async () => {
    const first = await api(ui, 'GET', `/api/chats/${LONG}`);
    assert.equal(first.json.entries.length, 200);
    assert.equal(first.json.entries[0].pos, 1001);
    assert.equal(first.json.entries[199].pos, 1200);
    assert.equal(first.json.version, 1200);
    assert.equal(first.json.has_earlier, true);
    // Positions are the transcript's own, whatever the page.
    assert.equal(first.json.entries[199].text, 'answer 599');
    let before = first.json.entries[0].pos;
    let total = first.json.entries.length;
    let pages = 0;
    for (;;) {
      const r = await api(ui, 'GET', `/api/chats/${LONG}/events?before=${before}&limit=200`);
      assert.equal(r.status, 200, r.text);
      pages++;
      assert.ok(r.json.entries.length <= 200);
      assert.equal(r.json.entries[r.json.entries.length - 1].pos, before - 1, 'contiguous');
      before = r.json.entries[0].pos;
      total += r.json.entries.length;
      if (!r.json.hasEarlier) break;
    }
    assert.equal(pages, 5);
    assert.equal(before, 1);
    assert.equal(total, 1200);
  });

  test('limit is validated, and `limit=50` returns 50', async () => {
    const r = await api(ui, 'GET', `/api/chats/${LONG}?limit=50`);
    assert.equal(r.json.entries.length, 50);
    assert.equal(r.json.entries[0].pos, 1151);
    assert.equal((await api(ui, 'GET', `/api/chats/${LONG}?limit=0`)).status, 400);
    assert.equal((await api(ui, 'GET', `/api/chats/${LONG}/events?before=10&limit=x`)).status, 400);
    assert.equal((await api(ui, 'GET', `/api/chats/${LONG}/events`)).status, 400, 'neither since nor before');
  });

  test('entries older than the in-memory part (the last 2000) are read from the transcript again', async () => {
    const BIG = 'aaaaaaaa-0000-4000-8000-00000000000a';
    addChat(dir, entry(BIG));
    write(BIG, Array.from({ length: 2500 }, (_, i) => JSON.stringify({ type: 'user', uuid: `b-${i}`, message: { role: 'user', content: `m${i}` } })).join('\n'));
    const first = await api(ui, 'GET', `/api/chats/${BIG}?limit=1000`);
    assert.equal(first.json.entries[0].pos, 1501);
    const older = await api(ui, 'GET', `/api/chats/${BIG}/events?before=501&limit=200`);
    assert.deepEqual(older.json.entries.map((e) => e.pos), Array.from({ length: 200 }, (_, i) => 301 + i));
    assert.equal(older.json.entries[0].text, 'm300');
    assert.equal(older.json.hasEarlier, true);
    const start = await api(ui, 'GET', `/api/chats/${BIG}/events?before=101&limit=200`);
    assert.equal(start.json.entries.length, 100);
    assert.equal(start.json.entries[0].pos, 1);
    assert.equal(start.json.hasEarlier, false);
  });
});
