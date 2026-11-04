// Helpers for the UI server tests: start the real server (startServer) on port 0 in this process, get a
// session cookie through the token exchange, make requests, read SSE. Not a test file. Node 20+.
import http from 'node:http';
import { startServer } from '../../src/ui/server.mjs';

// startServer prints the URL; keep test output quiet. Its close() ends in process.exit (the shutdown path
// SIGINT uses), so exit is stubbed for the duration of the close.
export async function startUi(dir, { env = {} } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.CLAUDE_PROJECT_DIR;
  const log = console.log;
  console.log = () => {};
  let handle;
  try {
    handle = await startServer({ dir, port: 0, open: false });
  } finally {
    console.log = log;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const token = new URL(handle.url).searchParams.get('t');
  const ui = {
    port: handle.port,
    url: handle.url,
    token,
    base: `http://127.0.0.1:${handle.port}`,
    origin: `http://127.0.0.1:${handle.port}`,
    cookie: null,
    closed: false,
    async close() {
      if (ui.closed) return;
      ui.closed = true;
      const exit = process.exit;
      let code;
      process.exit = (c) => {
        code = c;
      };
      try {
        await handle.close();
      } finally {
        process.exit = exit;
      }
      return code;
    },
  };
  const r = await fetch(handle.url, { redirect: 'manual' });
  if (r.status !== 302) throw new Error(`token exchange failed: ${r.status}`);
  ui.setCookie = r.headers.get('set-cookie');
  ui.cookie = ui.setCookie.split(';')[0];
  return ui;
}

// fetch with the session cookie, and the server's own Origin on POST, unless overridden (null removes).
export async function api(ui, method, pathname, { body, cookie = ui.cookie, origin = method === 'POST' ? ui.origin : null, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie !== null) h.cookie = cookie;
  if (origin !== null) h.origin = origin;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(ui.base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, headers: r.headers, text, json };
}

// node:http request, for headers fetch won't let us set (Host).
export function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, setHost: !('host' in headers) && !('Host' in headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Opens GET /api/events and collects events. waitFor(pred, ms) resolves with the first event, received
// after `since` (an index from mark()), that matches; rejects on timeout.
export async function openEvents(ui) {
  const ac = new AbortController();
  const r = await fetch(`${ui.base}/api/events`, { headers: { cookie: ui.cookie }, signal: ac.signal });
  if (r.status !== 200) throw new Error(`events: ${r.status}`);
  const events = [];
  const waiters = new Set();
  let buf = '';
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = 'message';
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (!data.length) continue;
          const ev = { type, data: JSON.parse(data.join('\n')), at: Date.now() };
          events.push(ev);
          for (const w of waiters) w();
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    mark: () => events.length,
    waitFor(pred, ms, since = 0) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = events.slice(since).find(pred);
          if (hit) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(hit);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no matching event within ${ms} ms; got ${JSON.stringify(events.slice(since).map((e) => e.type))}`));
        }, ms);
        if (!check()) waiters.add(check);
      });
    },
    close: () => ac.abort(),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
