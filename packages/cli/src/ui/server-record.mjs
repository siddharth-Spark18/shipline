// $SHIPLINE_HOME/server.json: the one running `shipline ui` server on this machine, and how a later `shipline ui`
// run finds it and hands its folder over. Node 20+, no dependencies.
//
//   { "pid", "port", "version", "key", "startedAt" }
//
// `key` is 32 random bytes (hex); the handoff routes (loopback only) want it in X-Shipline-Key. The file is mode 0600
// (not enforced on Windows: the user profile folder is the boundary, as for devices.json).
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { shiplineHome } from '../store.mjs';
import { openBrowser } from './open-browser.mjs';
import { pidAlive } from './sessions.mjs';

const PING_TIMEOUT_MS = 2000;
const HANDOFF_TIMEOUT_MS = 20_000;

export const serverFile = () => path.join(shiplineHome(), 'server.json');

export function readServerRecord() {
  try {
    const rec = JSON.parse(readFileSync(serverFile(), 'utf8'));
    return rec &&
      Number.isInteger(rec.pid) &&
      Number.isInteger(rec.port) &&
      typeof rec.key === 'string'
      ? rec
      : null;
  } catch {
    return null;
  }
}

// Written right after `listen`, by temp file and rename, with mode 0600.
export function writeServerRecord(rec) {
  const file = serverFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows.
  }
  renameSync(tmp, file);
}

// Removes server.json only when it names this server (a newer one may have replaced it): our pid and, when given,
// our port.
export function removeServerRecord(file = serverFile(), port) {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    if (rec && rec.pid === process.pid && (port === undefined || rec.port === port))
      unlinkSync(file);
  } catch {
    // Missing or not ours.
  }
}

// One request to the running server's handoff routes. Resolves { status, json }; rejects when nothing answers.
function call(rec, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: rec.port,
        method,
        path: pathname,
        headers: {
          'X-Shipline-Key': rec.key,
          ...(text === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Not JSON.
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

// Alive: the pid exists and the server answers the ping, with this key, within 2 s.
export async function serverAlive(rec) {
  if (!rec || !pidAlive(rec.pid)) return false;
  try {
    const r = await call(rec, 'GET', '/api/handoff/ping', undefined, PING_TIMEOUT_MS);
    return r.status === 200;
  } catch {
    return false;
  }
}

// POST /api/handoff: the running server registers (or opens an install context for) `dir` and answers
// { url, version, remote? }. Rejects when nothing answers.
export function handoff(rec, { dir, remote }) {
  return call(rec, 'POST', '/api/handoff', { dir, remote: Boolean(remote) }, HANDOFF_TIMEOUT_MS);
}

// `shipline ui`: hand over to the running server when there is one, else start a server here.
export async function launchUi({ dir, port = 0, open = true, remote = false }, cliVersion) {
  const rec = readServerRecord();
  if (rec && (await serverAlive(rec))) {
    let res = null;
    try {
      res = await handoff(rec, { dir, remote });
    } catch {
      res = null; // shutting down between the ping and the handoff: start our own server below
    }
    if (res && res.status === 200 && res.json && res.json.url) {
      if (port && port !== rec.port)
        console.log(
          `Shipline UI is already running on port ${rec.port}; stop it to change the port.`,
        );
      if (rec.version !== cliVersion)
        console.log(`Shipline UI ${rec.version} is already running; stop it to use ${cliVersion}.`);
      const j = res.json;
      console.log(
        j.installRoot
          ? `Shipline setup for ${j.installRoot} is open in the running UI.`
          : `Opened ${j.root} in the running Shipline UI.`,
      );
      console.log(j.url);
      if (remote && j.phone) {
        if (j.phone.enabled) console.log(`Phone access: ${j.phone.url}`);
        else console.log(`Phone access is off: ${j.phone.message}`);
      }
      if (open) openBrowser(j.url);
      return { handedOff: true };
    }
    if (res && res.status >= 400 && res.status < 500) {
      const m = res.json && res.json.error && res.json.error.message;
      console.error(`shipline: ${m || `the running UI refused the request (${res.status})`}`);
      process.exitCode = 1;
      return { handedOff: false, failed: true };
    }
  }
  // The same check the running server makes for a handoff, so a cold start refuses a bad --dir too.
  const resolved = path.resolve(dir || '.');
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    console.error(`shipline: ${resolved} is not a directory.`);
    process.exitCode = 1;
    return { handedOff: false, failed: true };
  }
  const { startServer } = await import('./server.mjs');
  await startServer({ dir, port, open, remote });
  return { handedOff: false };
}
