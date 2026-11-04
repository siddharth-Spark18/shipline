// The permission relay: a standalone MCP stdio server that `claude` starts (--mcp-config). It exposes one
// tool, `approve`, and passes each call to the UI server and the developer's answer back. It applies no
// policy: it reads no stage state, workflow files or config. Node 20+, no dependencies.
//
// The wait uses node:http with no timeout, because the built-in global request API stops waiting for response
// headers after 300 s and a developer may take longer than that to answer.
import { readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const FALLBACK_PROTOCOL = '2025-06-18';
const UNREACHABLE = { behavior: 'deny', message: 'Shipline UI is not reachable' };

const APPROVE_TOOL = {
  name: 'approve',
  description: 'Asks the developer in the Shipline UI whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// node:http options for the POST to the UI: the secret header, no Origin header, no timeout. Exported so a
// test can inspect them.
export function relayRequestOptions(url, secret, contentLength) {
  const u = new URL(url);
  const headers = { 'Content-Type': 'application/json', 'X-Shipline-Relay': secret };
  if (contentLength !== undefined) headers['Content-Length'] = contentLength;
  return {
    method: 'POST',
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    headers,
    timeout: 0,
  };
}

// POSTs the approve arguments; resolves with the answer, or a deny when the UI can't be reached.
export function askUi(args, url = process.env.SHIPLINE_UI_RELAY_URL, secret = process.env.SHIPLINE_UI_RELAY_SECRET) {
  return new Promise((resolve) => {
    if (!url || !secret) return resolve(UNREACHABLE);
    let body;
    let options;
    try {
      body = JSON.stringify(args);
      options = relayRequestOptions(url, secret, Buffer.byteLength(body));
    } catch {
      return resolve(UNREACHABLE);
    }
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode === 200 && answer && typeof answer.behavior === 'string')
            return resolve(answer);
        } catch {
          // Falls through to the deny below.
        }
        resolve({ behavior: 'deny', message: `Shipline UI refused the request (HTTP ${res.statusCode})` });
      });
      res.on('error', () => resolve(UNREACHABLE));
    });
    req.setTimeout(0);
    req.on('error', () => resolve(UNREACHABLE));
    req.end(body);
  });
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// One JSON-RPC message in, the response out (null for a notification).
export async function handleMessage(msg, ask = askUi) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return failure(null, -32600, 'Invalid Request');
  const hasId = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'shipline_ui', version: packageVersion() },
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return hasId ? reply(msg.id, {}) : null;
    case 'tools/list':
      return reply(msg.id, { tools: [APPROVE_TOOL] });
    case 'tools/call': {
      const p = msg.params || {};
      if (p.name !== 'approve') return failure(msg.id, -32602, `Unknown tool: ${p.name}`);
      const answer = await ask(p.arguments || {});
      return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
    default:
      return hasId ? failure(msg.id, -32601, `Method not found: ${msg.method}`) : null;
  }
}

function main() {
  const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write(failure(null, -32700, 'Parse error'));
    }
    handleMessage(msg).then(
      (res) => res && write(res),
      () => write(failure(msg && msg.id !== undefined ? msg.id : null, -32603, 'Internal error')),
    );
  });
  rl.on('close', () => process.exit(0));
}

// Run as a server only when started directly, so a test can import relayRequestOptions.
try {
  if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
} catch {
  // Not started directly.
}
