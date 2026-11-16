/**
 * Hash routes. The sidebar is one flat chat list across every project, so a chat's address has no repo in it:
 *   #/chat/<chatId>     a chat (the server maps the id to its project)
 *   #/new               the new-chat screen (`#/new/<repoId>` presets its project)
 *   #/all               All projects
 *   #/chats             the phone's Chats tab (the flat chat list)
 *   #/setup/<repoId>    Setup of one project
 *   #/setup/<repoId>/draft/<workflowId>   Setup, with that workflow draft open for review
 *   #/health            Health
 * Old hashes (#chat, #setup, #chats, #/r/<repoId>/...) and an empty one are redirected (see app.tsx).
 */

export type Route =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new'; repoId: string | null }
  | { kind: 'all' }
  /** The phone's Chats tab (the chat list). */
  | { kind: 'chats' }
  | { kind: 'setup'; repoId: string; draftId: string | null }
  | { kind: 'health' }
  /** Anything else, with what an old-style address named: `view` (chat, chats or setup), a repo and a chat. */
  | { kind: 'legacy'; view: 'chat' | 'chats' | 'setup' | null; repoId: string | null; chatId: string | null };

export const ALL_HASH = '#/all';
export const NEW_HASH = '#/new';
export const HEALTH_HASH = '#/health';
export const CHATS_HASH = '#/chats';

export const chatHash = (chatId: string) => `#/chat/${encodeURIComponent(chatId)}`;
export const newHash = (repoId?: string | null) => (repoId ? `#/new/${repoId}` : NEW_HASH);
export const setupHash = (repoId: string) => `#/setup/${repoId}`;
export const draftHash = (repoId: string, workflowId: string) =>
  `#/setup/${repoId}/draft/${encodeURIComponent(workflowId)}`;

const decode = (v: string | undefined): string | null => {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
};

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (h === '/all') return { kind: 'all' };
  if (h === '/health') return { kind: 'health' };
  if (h === '/chats') return { kind: 'chats' };
  if (h === '/setup' || h === '/setup/') return { kind: 'legacy', view: 'setup', repoId: null, chatId: null };
  // Trailing parts after a valid id are ignored, so a hand-edited address still opens that project.
  let m = /^\/chat\/([^/?]+)/.exec(h);
  if (m) {
    const chatId = decode(m[1]);
    if (chatId) return { kind: 'chat', chatId };
  }
  if (h === '/new' || h === '/new/') return { kind: 'new', repoId: null };
  m = /^\/new\/([0-9a-f]+)(?:[/?].*)?$/.exec(h);
  if (m) return { kind: 'new', repoId: m[1] };
  m = /^\/setup\/([0-9a-f]+)\/draft\/([A-Za-z0-9_-]+)(?:[/?].*)?$/.exec(h);
  if (m) return { kind: 'setup', repoId: m[1], draftId: m[2] };
  m = /^\/setup\/([0-9a-f]+)(?:[/?].*)?$/.exec(h);
  if (m) return { kind: 'setup', repoId: m[1], draftId: null };
  // The first build's addresses: #/r/<repoId>/chat[/<chatId>] | chats | setup.
  m = /^\/r\/([0-9a-f]+)\/(chat|chats|setup)(?:\/([^/]+))?/.exec(h);
  if (m) {
    return {
      kind: 'legacy',
      view: m[2] as 'chat' | 'chats' | 'setup',
      repoId: m[1],
      chatId: m[2] === 'chat' ? decode(m[3]) : null,
    };
  }
  const view = h === 'chat' || h === 'chats' || h === 'setup' ? h : null;
  return { kind: 'legacy', view, repoId: null, chatId: null };
}

const LAST_REPO_KEY = 'shipline:last-repo';

/** The project last used in this browser (last chat opened, last picked in New chat or Setup), or null. */
export function lastRepo(): string | null {
  try {
    return window.localStorage.getItem(LAST_REPO_KEY);
  } catch {
    return null;
  }
}

export function rememberRepo(id: string) {
  try {
    window.localStorage.setItem(LAST_REPO_KEY, id);
  } catch {
    // Blocked storage: the redirect falls back to the first usable project.
  }
}
