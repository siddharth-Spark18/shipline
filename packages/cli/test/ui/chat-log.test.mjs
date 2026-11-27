// Chat reliability C1.1/C1.2/C1.4: the per-chat ordered log (pos, ver, epoch), history and live events in one shape,
// dedupe by uuid only, catch-up by version, the memory bound, and the live events folded into entries.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_ENTRIES, createChatLog, createFolder } from '../../src/ui/chat-log.mjs';

const assistant = (uuid, text, msgId = 'm1') => ({ type: 'assistant', ...(uuid ? { uuid } : {}), message: { id: msgId, content: [{ type: 'text', text }] } });
const toolUse = (id, uuid) => ({ type: 'assistant', ...(uuid ? { uuid } : {}), message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
const toolResult = (id, text = 'ok', isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const partial = (event) => ({ type: 'stream_event', event });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', ...extra });

describe('the log', () => {
  test('pos is the 1-based place; history entries get ver = pos; appends and updates bump the version', () => {
    const log = createChatLog({ history: [{ type: 'user', text: 'a' }, { type: 'text', text: 'b', key: 'u-2:0' }] });
    assert.match(log.epoch, /^[0-9a-f]{12}$/);
    assert.equal(log.version, 2);
    assert.equal(log.historyCount, 2);
    assert.deepEqual(log.slice(undefined, 10), [
      { type: 'user', text: 'a', pos: 1, ver: 1 },
      { type: 'text', text: 'b', pos: 2, ver: 2 },
    ]);
    const e = log.append({ type: 'user', text: 'c' });
    assert.deepEqual([e.pos, e.ver, log.version], [3, 3, 3]);
    const u = log.update(2, { text: 'b2' });
    assert.deepEqual([u.pos, u.ver, log.version], [2, 4, 4]);
    assert.equal(log.update(99, { text: 'x' }), null);
    // An undefined value removes the field.
    log.update(3, { text: undefined });
    assert.equal('text' in log.get(3), false);
  });

  test('every log has its own epoch', () => {
    assert.notEqual(createChatLog().epoch, createChatLog().epoch);
    assert.equal(createChatLog({ epoch: 'abc' }).epoch, 'abc');
  });

  test('since(v) returns what was created or changed after v, with its full current content; ahead of the log is a gap', () => {
    const log = createChatLog({ history: [{ type: 'user', text: 'a' }] });
    const grow = log.append({ type: 'text', text: 'Hel', streaming: true });
    const v = log.version;
    log.update(grow.pos, { text: 'Hello' });
    log.append({ type: 'user', text: 'later' });
    const changed = log.since(v);
    assert.deepEqual(changed.map((e) => [e.pos, e.text]), [[2, 'Hello'], [3, 'later']]);
    assert.deepEqual(log.since(log.version), []);
    assert.equal(log.since(log.version + 1), null);
    assert.equal(log.since(-1), null);
    assert.equal(log.since(1.5), null);
  });

  test('the last MEMORY_ENTRIES stay in memory; a catch-up that needs an entry that left is a gap', () => {
    const log = createChatLog({ history: Array.from({ length: MEMORY_ENTRIES + 10 }, (_, i) => ({ type: 'user', text: `m${i}` })) });
    assert.equal(log.version, MEMORY_ENTRIES + 10);
    assert.equal(log.firstPos, 11);
    assert.equal(log.slice(undefined, 5000).length, MEMORY_ENTRIES);
    assert.equal(log.get(10), null);
    assert.equal(log.since(0), null, 'entries 1..10 changed after 0 and are gone');
    assert.equal(log.since(10).length, MEMORY_ENTRIES, 'everything after the evicted ones is still there');
    log.append({ type: 'user', text: 'new' });
    assert.equal(log.firstPos, 12);
    assert.equal(log.since(10), null);
    assert.equal(log.since(11).length, MEMORY_ENTRIES);
  });

  test('slice(before, limit) is the last `limit` entries with pos < before', () => {
    const log = createChatLog({ history: Array.from({ length: 10 }, (_, i) => ({ type: 'user', text: `m${i}` })) });
    assert.deepEqual(log.slice(6, 3).map((e) => e.pos), [3, 4, 5]);
    assert.deepEqual(log.slice(undefined, 3).map((e) => e.pos), [8, 9, 10]);
    assert.deepEqual(log.slice(1, 3), []);
  });

  test('a live image is stored with its entry under l:<pos>:<index>', () => {
    const log = createChatLog({ history: [{ type: 'user', text: 'a' }] });
    const e = log.append({ type: 'user', text: 'look' }, { images: [{ media_type: 'image/png', data: 'AAAA' }, { media_type: 'image/gif', data: 'BBBB' }] });
    assert.deepEqual(e.images, ['l:2:0', 'l:2:1']);
    assert.deepEqual(log.image('l:2:1'), { media_type: 'image/gif', data: 'BBBB' });
    assert.equal(log.image('l:2:2'), null);
  });
});

describe('history and live events overlap (dedupe by uuid only)', () => {
  const history = [
    { type: 'user', text: 'go' },
    { type: 'text', text: 'First answer', key: 'ev-1:0' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: 'Bash: ls', key: 'ev-2:0' },
  ];

  test('a live event whose uuid is already in the log is skipped; the rest are appended in order', () => {
    const log = createChatLog({ history });
    const f = createFolder(log);
    assert.deepEqual(f.ingest(assistant('ev-1', 'First answer')), []);
    assert.deepEqual(f.ingest(toolUse('toolu_1', 'ev-2')), []);
    const out = f.ingest(assistant('ev-3', 'Second answer'));
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].pos, out[0].text], [4, 'Second answer']);
    assert.deepEqual(log.slice(undefined, 10).map((e) => e.text ?? e.id), ['go', 'First answer', 'toolu_1', 'Second answer']);
    // The same live event again is not added twice.
    assert.deepEqual(f.ingest(assistant('ev-3', 'Second answer')), []);
  });

  test('an event with no uuid is never deduped, even with the same text', () => {
    const log = createChatLog({ history });
    const f = createFolder(log);
    f.ingest(assistant(null, 'First answer', 'a'));
    f.ingest(assistant(null, 'First answer', 'b'));
    assert.deepEqual(log.slice(undefined, 10).filter((e) => e.text === 'First answer').length, 3);
  });

  test('repeated identical texts are all kept (never deduped by text)', () => {
    const log = createChatLog();
    const f = createFolder(log);
    for (let i = 0; i < 3; i++) {
      f.echo('yes', [], 'composer');
      f.ingest(assistant(`ev-${i}`, 'Done.', `m${i}`));
    }
    assert.deepEqual(log.slice(undefined, 20).map((e) => `${e.type}:${e.text}`), ['user:yes', 'text:Done.', 'user:yes', 'text:Done.', 'user:yes', 'text:Done.']);
  });
});

describe('live events folded into entries', () => {
  test('a streamed text block is one entry that grows in place; the final message replaces it at the same pos', () => {
    const log = createChatLog();
    const f = createFolder(log);
    assert.deepEqual(f.ingest(partial({ type: 'message_start', message: { id: 'm1' } })), []);
    const [start] = f.ingest(partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    assert.deepEqual(start, { type: 'text', text: '', streaming: true, done: false, msgId: 'm1', pos: 1, ver: 1 });
    const [d1] = f.ingest(partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }));
    assert.deepEqual(d1, { pos: 1, ver: 2, type: 'text', delta: 'Hel' });
    const [d2] = f.ingest(partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }));
    assert.deepEqual(d2, { pos: 1, ver: 3, type: 'text', delta: 'lo' });
    assert.equal(log.get(1).text, 'Hello', 'the log has the full text');
    const [stopped] = f.ingest(partial({ type: 'content_block_stop', index: 0 }));
    assert.equal(stopped.done, true);
    const [final] = f.ingest(assistant('ev-1', 'Hello there.', 'm1'));
    assert.equal(final.pos, 1, 'same entry');
    assert.equal(final.text, 'Hello there.');
    assert.equal('streaming' in final, false);
    assert.equal(log.version, 5);
    assert.equal(log.slice(undefined, 10).length, 1, 'shown once');
  });

  test('the final message can come before content_block_stop and still replaces the partial', () => {
    const log = createChatLog();
    const f = createFolder(log);
    f.ingest(partial({ type: 'message_start', message: { id: 'm1' } }));
    f.ingest(partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    f.ingest(assistant('ev-1', 'Done', 'm1'));
    f.ingest(partial({ type: 'content_block_stop', index: 0 }));
    assert.deepEqual(log.slice(undefined, 10).map((e) => e.text), ['Done']);
  });

  test('a partial that never got a final message stops streaming at the result', () => {
    const log = createChatLog();
    const f = createFolder(log);
    f.ingest(partial({ type: 'message_start', message: { id: 'm1' } }));
    f.ingest(partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } }));
    f.ingest(result());
    assert.equal(log.get(1).streaming, undefined);
    assert.equal(log.get(2).type, 'result');
  });

  test('tool_use and its tool_result are separate entries; a guard block and your denial are labelled and noticed', () => {
    const log = createChatLog();
    const f = createFolder(log);
    f.ingest(toolUse('toolu_a'));
    f.ingest(toolUse('toolu_b'));
    f.ingest(toolUse('toolu_c'));
    const ok = f.ingest(toolResult('toolu_a', 'fine'));
    assert.deepEqual(ok.map((e) => e.type), ['tool_result']);
    const blocked = f.ingest(toolResult('toolu_b', 'Shipline (x): no', true), [{ kind: 'shipline-block', toolUseId: 'toolu_b', text: 'Shipline (x): no' }]);
    assert.deepEqual(blocked.map((e) => [e.type, e.outcome ?? e.level]), [['tool_result', 'blocked'], ['notice', 'blocked']]);
    const denied = f.ingest(toolResult('toolu_c', 'No', true), [{ kind: 'you-denied', toolUseId: 'toolu_c' }]);
    assert.deepEqual(denied.map((e) => [e.type, e.outcome ?? e.level, e.text && e.type === 'notice' ? e.text : undefined]), [['tool_result', 'denied', undefined], ['notice', 'denied', 'You denied Bash.']]);
  });

  test('hook messages become notices; sub-agent traffic is left out', () => {
    const log = createChatLog();
    const f = createFolder(log);
    const [n] = f.ingest({ type: 'system', subtype: 'informational' }, [{ kind: 'reminder', text: 'Shipline reminder: do the plan' }]);
    assert.deepEqual([n.type, n.level], ['notice', 'reminder']);
    assert.deepEqual(f.ingest({ ...assistant('ev-s', 'sub-agent chatter'), parent_tool_use_id: 'toolu_x' }), []);
  });

  test('the result: tool calls with no result are cancelled in the same step; error results give notices', () => {
    const log = createChatLog();
    const f = createFolder(log);
    f.ingest(toolUse('toolu_a'));
    f.ingest(toolUse('toolu_b'));
    f.ingest(toolResult('toolu_a'));
    const out = f.ingest(result({ total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 4 } }));
    assert.deepEqual(out.map((e) => e.type), ['result', 'tools_cancelled']);
    assert.deepEqual(out[0].result, { costUsd: 0.5, durationMs: undefined, turns: undefined, inputTokens: 3, outputTokens: 4, isError: false });
    assert.deepEqual(out[1].ids, ['toolu_b']);
    assert.deepEqual(f.cancelOpen(), [], 'nothing left open');
    const err = f.ingest(result({ is_error: true, subtype: 'error_max_turns', result: '' }));
    assert.deepEqual(err.map((e) => e.type), ['notice', 'result']);
    assert.equal(err[0].text, 'Turn ended: error_max_turns');
  });

  test('an interrupt: the user event becomes the Interrupted notice, and the error result after it says nothing more', () => {
    const log = createChatLog();
    const f = createFolder(log);
    const [n] = f.ingest({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    assert.deepEqual([n.level, n.text], ['info', 'Interrupted']);
    const out = f.ingest(result({ is_error: true, subtype: 'error_during_execution', result: '' }));
    assert.deepEqual(out.map((e) => e.type), ['result']);
  });

  test('a replayed local command output is not a message', () => {
    const f = createFolder(createChatLog());
    assert.deepEqual(f.ingest({ type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }), []);
  });

  test('echo adds the user entry (with image refs) and returns it', () => {
    const log = createChatLog();
    const f = createFolder(log);
    const [e] = f.echo('hi', [{ media_type: 'image/png', data: 'AAAA' }], 'queue');
    assert.deepEqual(e, { type: 'user', text: 'hi', from: 'queue', pos: 1, ver: 1, images: ['l:1:0'] });
  });

  test('cancelOpen is empty when no tool call is open', () => {
    assert.deepEqual(createFolder(createChatLog()).cancelOpen(), []);
  });
});
