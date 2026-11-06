// The ticket notice's data: whether the repo's tracker (Jira through the Atlassian MCP, GitHub through the `gh`
// CLI) can be used right now. Node 20+, no dependencies.
import { execFile } from 'node:child_process';
import { startSpec } from './claude.mjs';
import { jiraStatus } from './stream.mjs';

export const GH_TIMEOUT_MS = 5_000;
export const GH_CACHE_MS = 60_000;

// Runs `gh auth status` once -> 'connected' | 'needs-auth' | 'failed' | 'missing'.
// ENOENT = gh is not installed; a non-zero exit = not signed in; a timeout or anything else = failed.
function probeGh() {
  const spec = startSpec('gh', ['auth', 'status']);
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      { ...spec.options, timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err) => {
        if (!err) return resolve('connected');
        if (err.code === 'ENOENT') return resolve('missing');
        if (err.killed || err.signal) return resolve('failed');
        resolve(typeof err.code === 'number' ? 'needs-auth' : 'failed');
      },
    );
  });
}

// The result is cached for 60 s in `cache` (one object per server, `{}` to start), and a probe already running is
// shared. `now` is injectable for tests.
export function ghStatus(cache = {}, now = Date.now) {
  if (cache.pending) return cache.pending;
  if (cache.at !== undefined && now() - cache.at < GH_CACHE_MS) return Promise.resolve(cache.value);
  cache.pending = probeGh().then((value) => {
    cache.value = value;
    cache.at = now();
    cache.pending = null;
    return value;
  });
  return cache.pending;
}

// { tracker: 'jira' | 'github', status } for the chat, or null when there is nothing to report.
//   jira: from the chat's system/init mcp_servers (null until the chat has started).
//   github: from ghStatus, only when `atTicketStage`, so other chats never start gh.
// 'none' and any other tracker have no notice (their ticket stage is skipped).
export async function ticketStatus(
  tracker,
  initInfo,
  { atTicketStage = false, ghCache = {}, now } = {},
) {
  if (tracker === 'jira') {
    const status = initInfo ? jiraStatus(initInfo.mcpServers) : null;
    return status ? { tracker, status } : null;
  }
  if (tracker === 'github' && atTicketStage)
    return { tracker, status: await ghStatus(ghCache, now) };
  return null;
}
