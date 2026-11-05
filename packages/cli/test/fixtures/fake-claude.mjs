#!/usr/bin/env node
// Plan item 57: a stand-in for the user's `claude` binary, so the chat tests run with no Claude credentials.
// The UI server starts it through SHIPLINE_CLAUDE_BIN. Node 20+, no dependencies. Never calls the real claude.
//
// Probes (claude.mjs claudeHealth):
//   --version     prints "$FAKE_CLAUDE_VERSION (Claude Code)" (default 99.0.0).
//   auth status   prints {"loggedIn":true}, or {"loggedIn":false} with exit 1 when FAKE_CLAUDE_LOGGED_OUT=1.
//                 With FAKE_CLAUDE_DELETE_SELF=1 it deletes its own file after answering, so the spawn that
//                 follows fails with ENOENT.
//
// Chat mode (any other argv):
//   Records { argv, pid, pgid?, cwd, shiplineEnv, envKeys, mcpConfig, secretInEnv } as JSON to
//   $FAKE_CLAUDE_ARGV_OUT (one JSON line appended per run).
//   Replays test/fixtures/streams/$FAKE_CLAUDE_SCRIPT.jsonl line by line. Template values in emitted lines:
//   {{SESSION_ID}} (the --session-id / --resume value), {{OTHER_SESSION_ID}} (a fixed different uuid),
//   {{CWD}}. Lines starting with '#' are comments. Lines starting with '@' are directives:
//     @wait-user               wait until the next stream-json user message arrives on stdin
//     @raw <text>              write <text> verbatim (used for an invalid line)
//     @stderr <text>           write <text> to stderr
//     @sleep <ms>              pause
//     @wait-release            wait until the file $FAKE_CLAUDE_RELEASE exists
//     @exit <code>             exit now with <code>
//     @hang                    never continue (stays alive until killed)
//     @ignore-sigterm          from now on SIGTERM is ignored (the server must SIGKILL)
//     @spawn-child             start a long-lived grandchild in this process group; its pid is recorded in
//                              $FAKE_CLAUDE_ARGV_OUT as a {"child": pid} line
//     @spawn-stubborn-child    the same, but the grandchild ignores SIGTERM (it outlives a Stop: the Trust plan's
//                              leftover processes); it waits until the grandchild's handler is installed
//     @stage-start <title>     run the repo's .shipline/bin/stage.mjs start --workflow feature --title <title>
//                              (stage.mjs reads SHIPLINE_SESSION from this process's environment)
//     @approve <json>          start the MCP server named in --mcp-config (once; with its env), do initialize /
//                              notifications/initialized / tools/list, then tools/call approve with <json> as the
//                              arguments. The parsed answer is appended to $FAKE_CLAUDE_RELAY_OUT and a stream-json
//                              tool_result for arguments.tool_use_id is emitted (is_error for a deny).
//   {{MCP_SERVERS}} in a stream line becomes $FAKE_CLAUDE_MCP_SERVERS (raw JSON), or the 2026-11-05 capture's list
//   (the claude.ai Atlassian connector at needs-auth) when unset. {{MODEL}} is the resolved --model (or set_model)
//   value, default claude-opus-5-5; {{PERMISSION_MODE}} is the current mode in control terms (manual -> default).
//   After the script, every further user message gets a short default turn (assistant text + result).
//   With $FAKE_CLAUDE_STDIN_OUT set, every stream-json user message read from stdin is appended there as one
//   JSON line, exactly as received (the image tests check the content blocks).
//   Control messages (chat controls, docs/plans/shipline-chat-reliability.md): every stdin
//   {"type":"control_request","request_id","request":{subtype,…}} line gets a control_response in the shape
//   captured on 2026-11-05 (claude 2.1.317/2.1.318), written straight away (even mid-script):
//     initialize           { models[], current_permission_mode, account, … } (account must never reach the UI)
//     get_settings         { effective: {…the user's whole merged settings…}, applied: { effort, model? } }
//     get_context_usage    { totalTokens, maxTokens, autoCompactThreshold, isAutoCompactEnabled, percentage, model,
//                            categories[], … }; totalTokens grows by 1000 per result emitted, so a fresh reading
//                            can be told from an old one
//     set_model            { model: <resolved id> }, then a replayed <local-command-stdout> user event
//                          (isReplay: true) and a fresh system/init with the new model
//     set_permission_mode  { mode }, then system/status { permissionMode }
//     apply_flag_settings  {} (settings.effortLevel becomes get_settings.applied.effort)
//     anything else        subtype error "Unsupported control request subtype"
//   $FAKE_CLAUDE_CONTROL_FAIL (comma-separated subtypes) answers those with an error instead;
//   $FAKE_CLAUDE_CONTROL_SILENT (comma-separated subtypes) never answers them (the server's 10 s timeout).
//   With $FAKE_CLAUDE_CONTROL_OUT set, each control_request is appended there as
//   { request_id, request, results } (results = how many result events had been emitted when it arrived).
//   Exits 0 when stdin closes.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const OTHER_SESSION_ID = '00000000-0000-4000-8000-0000000000ff';
// system/init.mcp_servers as captured on 2026-11-05 with the claude.ai Atlassian connector added but not authenticated.
const CAPTURED_MCP_SERVERS = JSON.stringify([
  { name: 'shipline_ui', status: 'connected' },
  { name: 'claude.ai Atlassian', status: 'needs-auth', source: 'claudeai' },
]);

if (argv[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION || '99.0.0'} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_OUT !== '1';
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: 'fake' }) + '\n');
  if (process.env.FAKE_CLAUDE_DELETE_SELF === '1') {
    try {
      unlinkSync(process.argv[1]);
    } catch {
      // Already gone.
    }
  }
  process.exit(loggedIn ? 0 : 1);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = flag('--session-id') || flag('--resume') || '';
const mcpConfigPath = flag('--mcp-config');

let mcpConfig = null;
try {
  mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
} catch {
  // No config: @approve will fail loudly.
}
const record = (obj) => {
  if (process.env.FAKE_CLAUDE_ARGV_OUT) appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify(obj) + '\n');
};
{
  const secrets = [];
  for (const s of Object.values((mcpConfig && mcpConfig.mcpServers) || {}))
    for (const v of Object.values((s && s.env) || {})) if (typeof v === 'string' && v.length >= 32) secrets.push(v);
  const values = Object.values(process.env).map(String);
  record({
    argv,
    pid: process.pid,
    cwd: process.cwd(),
    shiplineEnv: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^SHIPLINE_|^MCP_/.test(k))),
    envKeys: Object.keys(process.env),
    mcpConfig,
    secretInEnv: secrets.some((s) => values.some((v) => v.includes(s))),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let resultsEmitted = 0;
let lastInit = null; // the last system/init written, re-sent (with the new model) after set_model
const out = (obj) => {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  try {
    const parsed = typeof obj === 'string' ? JSON.parse(obj) : obj;
    if (parsed && parsed.type === 'result') resultsEmitted++;
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init') lastInit = parsed;
  } catch {
    // An @raw invalid line.
  }
  process.stdout.write(line + '\n');
};
// Stream lines are JSON, so there {{CWD}} is JSON-escaped (a Windows path has backslashes); directive
// arguments are plain text and get the raw path.
const fill = (s, json = false) =>
  s
    .replaceAll('{{SESSION_ID}}', sessionId)
    .replaceAll('{{OTHER_SESSION_ID}}', OTHER_SESSION_ID)
    .replaceAll('{{MCP_SERVERS}}', process.env.FAKE_CLAUDE_MCP_SERVERS || CAPTURED_MCP_SERVERS)
    .replaceAll('{{MODEL}}', current.model || 'claude-opus-5-5')
    .replaceAll('{{PERMISSION_MODE}}', current.mode)
    .replaceAll('{{CWD}}', json ? JSON.stringify(process.cwd()).slice(1, -1) : process.cwd());

// stdin: stream-json user messages.
const userQueue = [];
let userWaiter = null;
let stdinClosed = false;
let scriptDone = false;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_request') return control(msg);
  if (msg.type !== 'user') return;
  if (process.env.FAKE_CLAUDE_STDIN_OUT) appendFileSync(process.env.FAKE_CLAUDE_STDIN_OUT, JSON.stringify(msg) + '\n');
  if (userWaiter) {
    const w = userWaiter;
    userWaiter = null;
    w(msg);
  } else if (scriptDone) defaultTurn(msg);
  else userQueue.push(msg);
});
rl.on('close', () => {
  stdinClosed = true;
  if (scriptDone) finish(0);
});
const nextUser = () => (userQueue.length ? Promise.resolve(userQueue.shift()) : new Promise((r) => (userWaiter = r)));

function defaultTurn(msg) {
  const text = msg.message && Array.isArray(msg.message.content) ? msg.message.content.map((b) => b.text).join('') : '';
  out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text}` }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: `echo: ${text}`, total_cost_usd: 0.001 });
}

// ---------- control_request / control_response (shapes from the 2026-11-05 captures) ----------

// initialize's models[] as captured (2.1.318), trimmed to a few entries; extra fields the server must drop included.
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true, isDefault: true },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 for complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAutoMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 for everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Haiku 4.5 for quick answers', supportsEffort: false, supportedEffortLevels: [], supportsAutoMode: false },
];
const resolveModel = (m) => {
  const hit = MODELS.find((x) => x.value === m);
  return hit ? hit.resolvedModel : m;
};
const listEnv = (name) => (process.env[name] || '').split(',').map((x) => x.trim()).filter(Boolean);
const toControlMode = (m) => (m === 'manual' ? 'default' : m);
const current = {
  model: flag('--model') ? resolveModel(flag('--model')) : null,
  effort: flag('--effort') || null,
  mode: toControlMode(flag('--permission-mode') || 'default'),
};

function controlAnswer(request) {
  switch (request.subtype) {
    case 'initialize':
      return {
        commands: [{ name: 'context', description: 'Show context usage', argumentHint: '' }],
        output_style: 'default',
        available_output_styles: ['default', 'Explanatory', 'Learning'],
        models: MODELS,
        current_permission_mode: current.mode,
        account: { email: 'dev@example.com', organization: 'Example Org', subscriptionType: 'max' },
        pid: process.pid,
      };
    case 'get_settings':
      return {
        effective: { env: { SECRET_TOKEN: 'do-not-forward' }, permissions: { allow: ['Bash(ls:*)'] }, theme: 'dark' },
        sources: [{ source: 'userSettings', path: '/home/dev/.claude/settings.json' }],
        applied: { effort: current.effort || 'high', ...(current.model ? { model: current.model } : {}) },
      };
    case 'get_context_usage': {
      const totalTokens = 19614 + 1000 * resultsEmitted;
      return {
        totalTokens,
        maxTokens: 1000000,
        rawMaxTokens: 1000000,
        autoCompactThreshold: 967000,
        isAutoCompactEnabled: true,
        percentage: Math.round((totalTokens / 1000000) * 100),
        model: current.model || 'claude-opus-5-5',
        memoryFiles: [{ path: '/home/dev/.claude/CLAUDE.md', tokens: 900 }],
        categories: [
          { name: 'System prompt', tokens: 3100, color: 'promptBorder' },
          { name: 'System tools', tokens: 11800, color: 'inactive' },
          { name: 'MCP tools', tokens: 1200, color: 'cyan_FOR_SUBAGENTS_ONLY' },
          { name: 'Memory files', tokens: 900, color: 'claude' },
          { name: 'Skills', tokens: 600, color: 'warning' },
          { name: 'Messages', tokens: 2014 + 1000 * resultsEmitted, color: 'purple_FOR_SUBAGENTS_ONLY' },
          { name: 'Free space', tokens: 0, color: 'promptBorder', isDeferred: true },
        ],
      };
    }
    case 'set_model':
      current.model = resolveModel(request.model);
      return { model: current.model };
    case 'set_permission_mode':
      current.mode = request.mode;
      return { mode: request.mode };
    case 'apply_flag_settings':
      if (request.settings && request.settings.effortLevel) current.effort = request.settings.effortLevel;
      return {};
    default:
      return null;
  }
}

function control(msg) {
  const request = (msg && msg.request) || {};
  if (process.env.FAKE_CLAUDE_CONTROL_OUT)
    appendFileSync(process.env.FAKE_CLAUDE_CONTROL_OUT, JSON.stringify({ request_id: msg.request_id, request, results: resultsEmitted }) + '\n');
  if (listEnv('FAKE_CLAUDE_CONTROL_SILENT').includes(request.subtype)) return;
  const fail = listEnv('FAKE_CLAUDE_CONTROL_FAIL').includes(request.subtype);
  const answer = fail ? null : controlAnswer(request);
  if (!answer) {
    out({
      type: 'control_response',
      response: { subtype: 'error', request_id: msg.request_id, error: fail ? `Fake failure for ${request.subtype}` : 'Unsupported control request subtype' },
    });
    return;
  }
  out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: answer } });
  if (request.subtype === 'set_model') {
    out({
      type: 'user',
      session_id: sessionId,
      isReplay: true,
      message: { role: 'user', content: `<local-command-stdout>Set model to ${current.model}</local-command-stdout>` },
    });
    if (lastInit) out({ ...lastInit, model: current.model, permissionMode: current.mode });
  }
  if (request.subtype === 'set_permission_mode')
    out({ type: 'system', subtype: 'status', session_id: sessionId, status: null, permissionMode: current.mode });
}

// The MCP server from --mcp-config, started on first @approve, as claude would start it.
let mcp = null;
function startMcp() {
  const [name, server] = Object.entries(mcpConfig.mcpServers)[0];
  const child = spawn(server.command, server.args || [], { env: { ...process.env, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  mcp = { name, child, call, notify, ready: null };
  mcp.ready = (async () => {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    notify('notifications/initialized');
    const list = await call('tools/list', {});
    return { init, list };
  })();
  return mcp;
}

async function approve(args) {
  if (!mcp) startMcp();
  const handshake = await mcp.ready;
  const res = await mcp.call('tools/call', { name: 'approve', arguments: args });
  let answer = null;
  try {
    answer = JSON.parse(res.result.content[0].text);
  } catch {
    // Recorded as null.
  }
  if (process.env.FAKE_CLAUDE_RELAY_OUT)
    appendFileSync(process.env.FAKE_CLAUDE_RELAY_OUT, JSON.stringify({ args, answer, response: res, handshake }) + '\n');
  const deny = !answer || answer.behavior !== 'allow';
  out({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: args.tool_use_id,
          is_error: deny,
          content: deny ? (answer && answer.message) || 'denied' : 'ok',
        },
      ],
    },
  });
}

function finish(code) {
  if (mcp) mcp.child.stdin.end();
  process.exit(code);
}

async function main() {
  const file = path.join(HERE, 'streams', `${process.env.FAKE_CLAUDE_SCRIPT || 'normal-turn'}.jsonl`);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith('@')) {
      out(fill(line, true));
      continue;
    }
    const sp = line.indexOf(' ');
    const cmd = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : fill(line.slice(sp + 1));
    switch (cmd) {
      case '@wait-user':
        await nextUser();
        break;
      case '@raw':
        out(rest);
        break;
      case '@stderr':
        process.stderr.write(rest + '\n');
        break;
      case '@sleep':
        await sleep(Number(rest));
        break;
      case '@wait-release':
        while (!existsSync(process.env.FAKE_CLAUDE_RELEASE)) await sleep(20);
        break;
      case '@exit':
        // Let stdout/stderr drain first.
        process.stdout.write('', () => process.stderr.write('', () => process.exit(Number(rest))));
        await new Promise(() => {});
        break;
      case '@hang':
        setInterval(() => {}, 60_000);
        await new Promise(() => {});
        break;
      case '@ignore-sigterm':
        process.on('SIGTERM', () => {});
        break;
      case '@spawn-child': {
        const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
        record({ child: c.pid });
        break;
      }
      case '@spawn-stubborn-child': {
        // A grandchild that ignores SIGTERM (only SIGKILL ends it), so it outlives a Stop. Waits until the
        // handler is installed, so a Stop right after this can't beat it.
        const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 60000)"], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        await new Promise((resolve) => c.stdout.once('data', resolve));
        c.stdout.destroy();
        c.unref();
        record({ child: c.pid });
        break;
      }
      case '@stage-start': {
        const r = await new Promise((resolve) => {
          const c = spawn(process.execPath, [path.join(process.cwd(), '.shipline', 'bin', 'stage.mjs'), 'start', '--workflow', 'feature', '--title', rest], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let err = '';
          c.stderr.on('data', (d) => (err += d));
          c.on('close', (code) => resolve({ code, err }));
        });
        if (r.code !== 0) process.stderr.write(`stage start failed: ${r.err}\n`);
        break;
      }
      case '@approve':
        await approve(JSON.parse(rest));
        break;
      default:
        throw new Error(`fake-claude: unknown directive ${cmd}`);
    }
  }
  scriptDone = true;
  for (const m of userQueue.splice(0)) defaultTurn(m);
  if (stdinClosed) finish(0);
}

main().catch((e) => {
  process.stderr.write(`fake-claude: ${e && e.stack}\n`);
  process.exit(70);
});
