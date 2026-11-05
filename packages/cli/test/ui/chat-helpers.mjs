// Helpers for the Phase 2 chat tests (plan items 57-59): the fake claude, its records, chat start/stop over the
// API, the lock and session files, and process-group checks. Not a test file. Node 20+.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAKE_CLAUDE_MJS, FIXTURES, IS_WIN, fakeClaudeBin, removeDir, storeOf, tasklist, tmpDir } from '../helpers.mjs';
import { api, sleep } from './helpers.mjs';

export const FAKE_CLAUDE = FAKE_CLAUDE_MJS;
export const SESSIONS_FIXTURES = path.join(FIXTURES, 'sessions');
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Plan "Spawn": never passed to claude.
export const FORBIDDEN = ['--bare', '--settings', '--plugin-dir', '--allowedTools', '--append-system-prompt', '--strict-mcp-config', '--fork-session'];

// Sets up this test process's environment for the fake claude. The UI server runs in this process and spawns
// claude with process.env, so everything the fake reads goes here. Returns a scratch dir and cleanup.
export function useFakeClaude() {
  if (!IS_WIN) chmodSync(FAKE_CLAUDE, 0o755);
  for (const k of ['CLAUDE_PROJECT_DIR', 'SHIPLINE_SESSION', 'CLAUDE_ENV_FILE', 'SHIPLINE_UI_DEV_ORIGIN', 'MCP_TOOL_TIMEOUT'])
    delete process.env[k];
  const scratch = tmpDir('shipline-chat-');
  const claudeConfig = path.join(scratch, 'claude-config');
  mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeConfig; // transcript.mjs must never read the real ~/.claude
  process.env.SHIPLINE_CLAUDE_BIN = fakeClaudeBin(); // fake-claude.mjs, or its .cmd shim on Windows
  process.env.FAKE_CLAUDE_RELEASE = path.join(scratch, 'release');
  process.env.FAKE_CLAUDE_RELAY_OUT = path.join(scratch, 'relay.jsonl');
  let n = 0;
  const fake = {
    scratch,
    claudeConfig,
    // A fresh record file for the next spawn(s), and the script to replay.
    script(name, extra = {}) {
      process.env.FAKE_CLAUDE_SCRIPT = name;
      process.env.FAKE_CLAUDE_ARGV_OUT = path.join(scratch, `argv-${++n}.jsonl`);
      process.env.FAKE_CLAUDE_RELAY_OUT = path.join(scratch, `relay-${n}.jsonl`);
      for (const k of ['FAKE_CLAUDE_VERSION', 'FAKE_CLAUDE_LOGGED_OUT', 'FAKE_CLAUDE_DELETE_SELF', 'FAKE_CLAUDE_STDIN_OUT']) delete process.env[k];
      Object.assign(process.env, extra);
      return process.env.FAKE_CLAUDE_ARGV_OUT;
    },
    // The records the fake wrote for the current script(): [{ argv, pid, ... }, { child }, ...].
    records(file = process.env.FAKE_CLAUDE_ARGV_OUT) {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    runs(file) {
      return fake.records(file).filter((r) => r.argv);
    },
    relayAnswers() {
      const f = process.env.FAKE_CLAUDE_RELAY_OUT;
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    release() {
      writeFileSync(process.env.FAKE_CLAUDE_RELEASE, 'go');
    },
    unrelease() {
      removeDir(process.env.FAKE_CLAUDE_RELEASE);
    },
    // Safety net: kill any fake claude (or its grandchild) a failed test left running, then remove the scratch.
    cleanup() {
      for (const name of existsSync(scratch) ? readdirSync(scratch).filter((f) => f.startsWith('argv-')) : []) {
        for (const rec of fake.records(path.join(scratch, name))) {
          for (const pid of [rec.pid, rec.child]) {
            if (!pid || !pidAlive(pid)) continue;
            if (IS_WIN) {
              // No command lines in tasklist: only a node process with that pid is killed (with its tree).
              if (tasklist().get(pid) !== 'node.exe') continue;
              try {
                execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
              } catch {
                // Already gone.
              }
              continue;
            }
            let cmd = '';
            try {
              cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
            } catch {
              continue;
            }
            if (/fake-claude|setInterval/.test(cmd)) process.kill(pid, 'SIGKILL');
          }
        }
      }
      removeDir(scratch);
    },
  };
  return fake;
}

// The UI's files live in the repo's store: <SHIPLINE_HOME>/projects/<encoded>/ui/.
export const uiDir = (dir) => path.join(storeOf(dir), 'ui');
export const stateDirOf = (dir) => path.join(storeOf(dir), 'state');
export const tasksDirOf = (dir) => path.join(storeOf(dir), 'tasks');
export const lockPath = (dir) => path.join(uiDir(dir), 'lock.json');
export const readLockFile = (dir) => (existsSync(lockPath(dir)) ? JSON.parse(readFileSync(lockPath(dir), 'utf8')) : null);
export const readSessions = (dir) => {
  const f = path.join(uiDir(dir), 'sessions.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
};
export const readUiLog = (dir) =>
  readFileSync(path.join(uiDir(dir), 'ui.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

export const isChat = (id, kind) => (e) => e.type === 'chat' && e.data.chatId === id && (!kind || e.data.kind === kind);
export const isEnd = (id) => (e) => e.type === 'chat' && e.data.chatId === id && (e.data.kind === 'ended' || e.data.kind === 'fatal');
export const isEventType = (id, type, subtype) => (e) =>
  e.type === 'chat' && e.data.chatId === id && e.data.kind === 'event' && e.data.event.type === type && (!subtype || e.data.event.subtype === subtype);

// POST /api/chats; asserts nothing, returns the response.
export const postChat = (ui, message = 'Add a CSV export') => api(ui, 'POST', '/api/chats', { body: { message } });

// Starts a chat and waits for its system/init on SSE. Returns the chat id.
export async function startChat(ui, ev, message = 'Add a CSV export', { waitInit = true } = {}) {
  const since = ev.mark();
  const r = await postChat(ui, message);
  if (r.status !== 200) throw new Error(`POST /api/chats: ${r.status} ${r.text}`);
  if (waitInit) await ev.waitFor(isEventType(r.json.id, 'system', 'init'), 10_000, since);
  return r.json.id;
}

// POST /stop and wait for the chat's final SSE event (or for the API to say it already ended).
export async function stopChat(ui, ev, id) {
  const since = ev.mark();
  const r = await api(ui, 'POST', `/api/chats/${id}/stop`);
  if (r.status !== 200) throw new Error(`stop: ${r.status} ${r.text}`);
  return ev.waitFor(isEnd(id), 10_000, since).catch(() => null);
}

export async function waitUntil(fn, ms = 5000, step = 25) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms} ms`);
    await sleep(step);
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Every live process whose process group is pgid (ps works the same on macOS and Linux with these flags).
// POSIX only: Windows has no process groups (its tree checks use livePids/tasklist from ../helpers.mjs).
export function groupPids(pgid) {
  if (IS_WIN) throw new Error('groupPids is POSIX-only; use livePids (tasklist) on Windows');
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && Number(p[1]) === pgid && !String(p[2] || '').startsWith('Z'))
    .map((p) => Number(p[0]));
}
