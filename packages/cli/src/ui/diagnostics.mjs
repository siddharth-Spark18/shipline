// GET /api/status and GET /api/diagnostics. Node 20+, no dependencies.
import { INTERFACE } from '../interface.mjs';
import { storeDir } from '../store.mjs';
import { MIN_CLAUDE_VERSION, claudeHealth } from './claude.mjs';
import { redact, tail } from './log.mjs';
import { readLock } from './sessions.mjs';

export function routes(app) {
  const status = () => ({
    mode: 'repo',
    uiVersion: app.uiVersion,
    repoVersion: app.repo.version,
    versionState: app.repo.state,
    root: app.repo.root,
    storeDir: storeDir(app.repo.root),
    versionMessage: app.repo.versionMessage,
  });

  return [
    { method: 'GET', path: '/api/status', handler: () => status() },
    {
      method: 'GET',
      path: '/api/diagnostics',
      handler: async () => {
        let claude;
        try {
          const h = await claudeHealth(MIN_CLAUDE_VERSION);
          claude = {
            path: h.bin,
            installed: h.installed,
            version: h.version,
            signedIn: h.loggedIn,
            meetsMinVersion: h.meetsMinVersion,
            minVersion: h.minVersion,
          };
        } catch (e) {
          claude = { error: e && e.message };
        }
        const lock = readLock(app.repo.root);
        return redact({
          ...status(),
          uiInterface: INTERFACE,
          node: process.version,
          port: app.port,
          watchMode: app.watch ? app.watch.mode() : null,
          configError: app.repo.getConfig().error || null,
          logTail: tail(50),
          claude,
          activeChatId: app.chats ? app.chats.activeId() : null,
          lock: lock && {
            pid: lock.pid,
            hostname: lock.hostname,
            port: lock.port,
            sessionId: lock.session_id,
          },
        });
      },
    },
  ];
}
