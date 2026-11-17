/**
 * Hash routes. The sidebar is one flat chat list across every project, so a chat's address has no repo in it:
 *   #/chat/<chatId>     a chat (the server maps the id to its project)
 *   #/new               the new-chat screen (`#/new/<repoId>` presets its project)
 *   #/all               All projects
 *   #/chats             the phone's Chats tab (the flat chat list)
 *   #/setup/<repoId>    Setup of one project
 *   #/setup/<repoId>/workflows | /workflows/<wid> | /workflows/<wid>/stages/<n>[/<step>]   the workflow list, one workflow, one stage
 *   #/setup/<repoId>/guardrails | /agents | /ci | /phone | /config   the other Setup pages
 *   #/setup/<repoId>/draft/<workflowId>   Setup, with that workflow draft open for review
 *   #/health            Health
 * Old hashes (#chat, #setup, #chats, #/r/<repoId>/...) and an empty one are redirected (see app.tsx).
 */

export type StageStep = 'basics' | 'enforcement' | 'blocks' | 'sections' | 'rules';
export const STAGE_STEPS: StageStep[] = ['basics', 'enforcement', 'blocks', 'sections', 'rules'];

/** Which page of Setup: the hub of summary cards, or one focused page. */
export type SetupSub =
  | { page: 'hub' }
  | { page: 'workflows' }
  | { page: 'workflow'; workflowId: string }
  | { page: 'stage'; workflowId: string; n: number; step: StageStep }
  | { page: 'guardrails' | 'agents' | 'ci' | 'phone' | 'config' };

export type Route =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new'; repoId: string | null }
  | { kind: 'all' }
  /** The phone's Chats tab (the chat list). */
  | { kind: 'chats' }
  | { kind: 'setup'; repoId: string; sub: SetupSub; draftId: string | null }
  | { kind: 'health' }
  /** Anything else, with what an old-style address named: `view` (chat, chats or setup), a repo and a chat. */
  | {
      kind: 'legacy';
      view: 'chat' | 'chats' | 'setup' | null;
      repoId: string | null;
      chatId: string | null;
    };

export const ALL_HASH = '#/all';
export const NEW_HASH = '#/new';
export const HEALTH_HASH = '#/health';
export const CHATS_HASH = '#/chats';

export const chatHash = (chatId: string) => `#/chat/${encodeURIComponent(chatId)}`;
export const newHash = (repoId?: string | null) => (repoId ? `#/new/${repoId}` : NEW_HASH);
export const setupHash = (repoId: string) => `#/setup/${repoId}`;
export const setupSubHash = (repoId: string, sub: SetupSub): string => {
  const base = `#/setup/${repoId}`;
  switch (sub.page) {
    case 'hub':
      return base;
    case 'workflows':
      return `${base}/workflows`;
    case 'workflow':
      return `${base}/workflows/${encodeURIComponent(sub.workflowId)}`;
    case 'stage':
      return `${base}/workflows/${encodeURIComponent(sub.workflowId)}/stages/${sub.n}/${sub.step}`;
    default:
      return `${base}/${sub.page}`;
  }
};
export const workflowsHash = (repoId: string) => setupSubHash(repoId, { page: 'workflows' });
export const workflowHash = (repoId: string, workflowId: string) =>
  setupSubHash(repoId, { page: 'workflow', workflowId });
export const stageHash = (
  repoId: string,
  workflowId: string,
  n: number,
  step: StageStep = 'basics',
) => setupSubHash(repoId, { page: 'stage', workflowId, n, step });
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
  if (h === '/setup' || h === '/setup/')
    return { kind: 'legacy', view: 'setup', repoId: null, chatId: null };
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
  if (m) return { kind: 'setup', repoId: m[1], sub: { page: 'hub' }, draftId: m[2] };
  m = /^\/setup\/([0-9a-f]+)\/workflows\/([^/?]+)\/stages\/(\d+)(?:\/([^/?]*))?(?:[?].*)?$/.exec(h);
  if (m) {
    const workflowId = decode(m[2]);
    const n = Number(m[3]);
    if (workflowId && Number.isSafeInteger(n) && n >= 1) {
      const step = STAGE_STEPS.find((x) => x === m![4]) ?? 'basics';
      return {
        kind: 'setup',
        repoId: m[1],
        sub: { page: 'stage', workflowId, n, step },
        draftId: null,
      };
    }
  }
  m = /^\/setup\/([0-9a-f]+)\/workflows\/([^/?]+)\/?(?:[?].*)?$/.exec(h);
  if (m) {
    const workflowId = decode(m[2]);
    if (workflowId)
      return {
        kind: 'setup',
        repoId: m[1],
        sub: { page: 'workflow', workflowId },
        draftId: null,
      };
  }
  m = /^\/setup\/([0-9a-f]+)\/workflows\/?(?:[?].*)?$/.exec(h);
  if (m) return { kind: 'setup', repoId: m[1], sub: { page: 'workflows' }, draftId: null };
  m = /^\/setup\/([0-9a-f]+)\/(guardrails|agents|ci|phone|config)\/?(?:[?].*)?$/.exec(h);
  if (m) {
    return {
      kind: 'setup',
      repoId: m[1],
      sub: { page: m[2] as 'guardrails' | 'agents' | 'ci' | 'phone' | 'config' },
      draftId: null,
    };
  }
  m = /^\/setup\/([0-9a-f]+)(?:[/?].*)?$/.exec(h);
  if (m) return { kind: 'setup', repoId: m[1], sub: { page: 'hub' }, draftId: null };
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
