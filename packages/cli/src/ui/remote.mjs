// Phone access: runs and removes `tailscale serve` for this UI server and holds the runtime remote state that
// auth.mjs and sse.mjs read on every call. Node 20+, no dependencies; `tailscale` is an external program.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { shiplineHome } from '../store.mjs';

// The HTTPS ports tried, in order. (`tailscale serve --https=<port>` accepts any port; this short list is
// what Tailscale Funnel allows too, and is plenty for a few repos at a time.)
export const HTTPS_PORTS = [443, 8443, 10000];

const TAILSCALE_TIMEOUT_MS = 15_000;
const INSTALL_URL = 'https://tailscale.com/download';

function run(args) {
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      args,
      { timeout: TAILSCALE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          missing: !!err && err.code === 'ENOENT',
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      },
    );
  });
}

const firstLine = (s) => String(s).trim().split(/\r?\n/)[0] || '';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// True when something listens on 127.0.0.1:<port>.
function answers(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(750, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const recordFile = () => path.join(shiplineHome(), 'remote-serve.json');

// Which HTTPS ports this Shipline registered, and for which local port: [{ httpsPort, targetPort }].
function readRecord() {
  try {
    const data = JSON.parse(readFileSync(recordFile(), 'utf8'));
    return Array.isArray(data.entries)
      ? data.entries.filter((e) => Number.isInteger(e.httpsPort) && Number.isInteger(e.targetPort))
      : [];
  } catch {
    return [];
  }
}

function writeRecord(entries) {
  const f = recordFile();
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
  renameSync(tmp, f);
}

// `tailscale serve status --json` -> Map<httpsPort, description of its target>, or null when it cannot be read.
async function serveMappings() {
  const r = await run(['serve', 'status', '--json']);
  if (!r.ok) return null;
  const data = r.stdout.trim() === '' ? {} : parseJson(r.stdout);
  if (!data || typeof data !== 'object') return null;
  const out = new Map();
  for (const key of Object.keys(data.TCP || {})) {
    const p = Number(key);
    if (Number.isInteger(p)) out.set(p, 'another Tailscale serve mapping');
  }
  for (const [key, web] of Object.entries(data.Web || {})) {
    const p = Number(key.slice(key.lastIndexOf(':') + 1));
    if (!Number.isInteger(p)) continue;
    const targets = Object.values((web && web.Handlers) || {})
      .map((h) => h && (h.Proxy || h.Path || h.Text))
      .filter(Boolean);
    out.set(p, targets.length ? targets.join(', ') : 'another Tailscale serve mapping');
  }
  return out;
}

const NOT_OK = {
  missing: `Tailscale is not installed (the \`tailscale\` command was not found). Install it from ${INSTALL_URL} and sign in.`,
  'logged-out':
    'Tailscale is not connected. Open the Tailscale app and sign in (or run `tailscale up`), then try again.',
  'no-https':
    'HTTPS certificates are not enabled for your tailnet. Turn them on in the Tailscale admin console under DNS, then try again.',
};

// app: { port } (read lazily: the port is known only after listen). devices: the devices.mjs store.
export function createRemote({ app, devices }) {
  const remote = {
    enabled: false,
    host: null,
    httpsPort: null,
    loginName: null,
    tailscale: { state: 'ok', message: '' },
    devices,

    // The page address, without a trailing slash. Also the one Origin a device's POST may carry.
    get url() {
      if (!this.enabled || !this.host) return null;
      return this.httpsPort === 443
        ? `https://${this.host}`
        : `https://${this.host}:${this.httpsPort}`;
    },

    // { enabled, url, httpsPort, tailscale }. While off, asks Tailscale again so the panel shows today's state.
    async status() {
      if (!this.enabled) {
        const p = await probe();
        if (!p.ok) this.tailscale = { state: p.state, message: p.message };
        else {
          const used = await serveMappings();
          const free = used === null || HTTPS_PORTS.some((x) => !used.has(x));
          this.tailscale = free ? { state: 'ok', message: '' } : noFreePort(used);
        }
      }
      return this.snapshot();
    },

    snapshot() {
      return {
        enabled: this.enabled,
        url: this.url,
        httpsPort: this.httpsPort,
        tailscale: this.tailscale,
      };
    },

    // Registers the HTTPS mapping. Never throws: the outcome is in `tailscale.state` (and `enabled`).
    async start() {
      if (this.enabled) return this.snapshot();
      const p = await probe();
      if (!p.ok) return fail(p.state, p.message);

      await cleanStale();
      const used = await serveMappings();
      if (used === null) return fail('error', 'Could not read `tailscale serve status`.');
      const port = HTTPS_PORTS.find((x) => !used.has(x));
      if (port === undefined) {
        const t = noFreePort(used);
        return fail(t.state, t.message);
      }
      const r = await run(['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${app.port}`]);
      if (!r.ok) {
        const msg = firstLine(r.stderr) || firstLine(r.stdout) || '`tailscale serve` failed.';
        return fail(/https|cert/i.test(msg) ? 'no-https' : 'error', msg);
      }
      writeRecord([
        ...readRecord().filter((e) => e.httpsPort !== port),
        { httpsPort: port, targetPort: app.port },
      ]);
      this.host = p.host;
      this.loginName = p.loginName;
      this.httpsPort = port;
      this.tailscale = { state: 'ok', message: '' };
      this.enabled = true;
      return this.snapshot();
    },

    // Removes the mapping this Shipline made. Paired devices stay paired.
    async stop() {
      if (!this.enabled) return;
      const port = this.httpsPort;
      this.enabled = false;
      this.host = null;
      this.httpsPort = null;
      this.loginName = null;
      await run(['serve', `--https=${port}`, 'off']);
      writeRecord(readRecord().filter((e) => e.httpsPort !== port));
    },
  };

  function fail(state, message) {
    remote.tailscale = { state, message };
    return remote.snapshot();
  }

  function noFreePort(used) {
    const what = HTTPS_PORTS.map((x) => `${x} (${used.get(x)})`).join(', ');
    return {
      state: 'no-free-port',
      message: `Every HTTPS port Shipline tries is already served by something else: ${what}.`,
    };
  }

  // Tailscale state: { ok: true, host, loginName } or { ok: false, state, message }.
  async function probe() {
    const r = await run(['status', '--json']);
    if (r.missing) return { ok: false, state: 'missing', message: NOT_OK.missing };
    const st = parseJson(r.stdout);
    if (!st || typeof st !== 'object' || st.BackendState !== 'Running')
      return { ok: false, state: 'logged-out', message: NOT_OK['logged-out'] };
    const self = st.Self || {};
    const host = String(self.DNSName || '')
      .replace(/\.$/, '')
      .toLowerCase();
    const user = st.User && st.User[String(self.UserID)];
    const loginName = user && user.LoginName;
    if (!host || !loginName)
      return { ok: false, state: 'logged-out', message: NOT_OK['logged-out'] };
    if (!Array.isArray(st.CertDomains) || st.CertDomains.length === 0)
      return { ok: false, state: 'no-https', message: NOT_OK['no-https'] };
    return { ok: true, host, loginName };
  }

  // A recorded mapping whose target no longer answers (a crashed Shipline), or that points at our own port
  // (that earlier process is gone), is removed. Mappings Shipline did not record are never touched.
  async function cleanStale() {
    const entries = readRecord();
    if (entries.length === 0) return;
    const live = await serveMappings();
    const keep = [];
    for (const e of entries) {
      const stale = e.targetPort === app.port || !(await answers(e.targetPort));
      if (!stale) {
        keep.push(e);
        continue;
      }
      const target = live && live.get(e.httpsPort);
      // Only remove it while it still points at that old target; otherwise the port was reused by someone else.
      if (target && target.includes(`127.0.0.1:${e.targetPort}`))
        await run(['serve', `--https=${e.httpsPort}`, 'off']);
    }
    writeRecord(keep);
  }

  return remote;
}
