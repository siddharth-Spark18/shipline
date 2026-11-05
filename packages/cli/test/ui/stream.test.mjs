// Chat reliability plan (docs/plans/shipline-chat-reliability.md), Tests: stream.test.mjs. The hook-message and
// guard-denial readers against the shapes captured on 2026-11-05 (claude 2.1.317), plus the older shapes they
// still accept, and the Jira status read from system/init.mcp_servers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../helpers.mjs';
import { classifyHookMessage, guardDenial, hookSystemMessage, jiraStatus } from '../../src/ui/stream.mjs';

const REMINDER = 'Shipline reminder: the "Plan" stage isn\'t done yet (warn mode).';

// The informational event exactly as captured (only the message text is ours).
const informational = (content) => ({ type: 'system', subtype: 'informational', level: 'notice', content });

describe('hookSystemMessage', () => {
  test('reads a real system/informational event, with the "<Event>:<Tool> says: " prefix stripped', () => {
    assert.equal(hookSystemMessage(informational(`PreToolUse:Edit says: ${REMINDER}`)), REMINDER);
    assert.equal(hookSystemMessage(informational(`PostToolUse:Bash says: ${REMINDER}`)), REMINDER);
    assert.equal(hookSystemMessage(informational(`UserPromptSubmit says: ${REMINDER}`)), REMINDER);
    assert.equal(
      hookSystemMessage(informational('PreToolUse:mcp__shipline_ui__approve says: Shipline: hello')),
      'Shipline: hello',
    );
  });

  test('a message without the prefix is used as it is; only the leading prefix is stripped', () => {
    assert.equal(hookSystemMessage(informational(REMINDER)), REMINDER);
    const inner = 'Shipline reminder: PreToolUse:Edit says: stays';
    assert.equal(hookSystemMessage(informational(`PreToolUse:Edit says: ${inner}`)), inner);
  });

  test('the informational event in reliability.jsonl (the capture) gives the reminder', () => {
    const lines = readFileSync(path.join(FIXTURES, 'streams', 'reliability.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l.replaceAll('{{MCP_SERVERS}}', '[]')));
    const ev = lines.find((e) => e.type === 'system' && e.subtype === 'informational');
    assert.ok(ev, 'the fixture has a system/informational event');
    const text = hookSystemMessage(ev);
    assert.match(text, /^Shipline reminder: /);
    assert.deepEqual(classifyHookMessage(text), { kind: 'reminder' });
  });

  test('the existing shapes still work: systemMessage on the event, or in output / stdout / data (object or JSON)', () => {
    const msg = 'Shipline: something';
    assert.equal(hookSystemMessage({ type: 'system', subtype: 'hook_response', systemMessage: msg }), msg);
    assert.equal(hookSystemMessage({ type: 'system', subtype: 'hook_response', output: { systemMessage: msg } }), msg);
    assert.equal(
      hookSystemMessage({ type: 'system', subtype: 'hook_response', stdout: JSON.stringify({ systemMessage: msg }), exit_code: 0, outcome: 'success' }),
      msg,
    );
    assert.equal(hookSystemMessage({ type: 'system', subtype: 'hook_response', data: JSON.stringify({ systemMessage: msg }) }), msg);
  });

  test('anything else gives null', () => {
    assert.equal(hookSystemMessage(null), null);
    assert.equal(hookSystemMessage({ type: 'assistant', content: 'PreToolUse:Edit says: x' }), null);
    assert.equal(hookSystemMessage(informational('')), null);
    assert.equal(hookSystemMessage({ type: 'system', subtype: 'informational', content: 42 }), null);
    assert.equal(hookSystemMessage({ type: 'system', subtype: 'hook_response', stdout: 'not json' }), null);
    assert.equal(hookSystemMessage({ type: 'system', subtype: 'init' }), null);
  });
});

describe('classifyHookMessage', () => {
  test('reminder, fail-open, lost-task and plain notices', () => {
    assert.deepEqual(classifyHookMessage(REMINDER), { kind: 'reminder' });
    assert.deepEqual(
      classifyHookMessage('Shipline: ignoring a problem and continuing without enforcement (bad config)'),
      { kind: 'notice', banner: 'fail-open' },
    );
    assert.deepEqual(
      classifyHookMessage("Shipline: branch feat/x has a task, but this session isn't tracking it"),
      { kind: 'notice', banner: 'lost-task' },
    );
    assert.deepEqual(classifyHookMessage('Shipline needs Node.js 18 or newer'), { kind: 'notice' });
  });
});

describe('guardDenial (Q6)', () => {
  // As captured: is_error true, "PreToolUse:<Tool> hook error: " before the guard's own reason.
  const CAPTURED =
    'PreToolUse:Edit hook error: Shipline (Feature workflow, task add-export): Edit on src/a.js needs the "Plan" stage to be done first. Finish it, then record it with: node .shipline/bin/stage.mjs advance Do not work around this; tell the developer what is missing.';

  test('the captured tool_result text is classified as a Shipline block (string or text blocks)', () => {
    assert.equal(guardDenial({ type: 'tool_result', tool_use_id: 't', is_error: true, content: CAPTURED }), CAPTURED);
    assert.equal(
      guardDenial({ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: CAPTURED }] }),
      CAPTURED,
    );
  });

  test('not a block: is_error false, an ordinary error, or "Shipline (" past the first 300 characters', () => {
    assert.equal(guardDenial({ type: 'tool_result', is_error: false, content: CAPTURED }), null);
    assert.equal(guardDenial({ type: 'tool_result', is_error: true, content: 'Exit code 1' }), null);
    assert.equal(guardDenial({ type: 'tool_result', is_error: true, content: `${'x'.repeat(300)}Shipline (late)` }), null);
  });
});

describe('jiraStatus', () => {
  test('the captured needs-auth entry, and each status', () => {
    const atl = (status) => [{ name: 'shipline_ui', status: 'connected' }, { name: 'claude.ai Atlassian', status, source: 'claudeai' }];
    assert.equal(jiraStatus(atl('needs-auth')), 'needs-auth');
    assert.equal(jiraStatus(atl('connected')), 'connected');
    assert.equal(jiraStatus(atl('failed')), 'failed');
    assert.equal(jiraStatus(atl('pending')), 'failed', 'an unknown status counts as failed');
    assert.equal(jiraStatus([{ name: 'shipline_ui', status: 'connected' }]), 'missing');
    assert.equal(jiraStatus([]), 'missing');
    assert.equal(jiraStatus(null), null, 'no system/init yet');
  });

  test('several Atlassian-like servers: the first connected one wins, otherwise the first match', () => {
    assert.equal(
      jiraStatus([{ name: 'jira-local', status: 'failed' }, { name: 'claude.ai Atlassian', status: 'connected' }]),
      'connected',
    );
    assert.equal(
      jiraStatus([{ name: 'JIRA', status: 'needs-auth' }, { name: 'atlassian', status: 'failed' }]),
      'needs-auth',
    );
  });
});
