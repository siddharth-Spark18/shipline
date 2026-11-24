import { useSyncExternalStore } from 'react';
import { subscribeChat, subscribeShell } from '@/lib/events';
import type {
  ChatCatchUp,
  ChatDetail,
  ChatEntry,
  ChatEvent,
  ContextUsage,
  ModelOption,
  PickedControls,
  QueuedMessage,
  ShellEvent,
} from '@/lib/types';
import { lastResult, type ChatResult, type Item } from '@/pages/chat/timeline';

export interface FatalInfo {
  reason?: 'parse' | 'exit' | 'resume-failed';
  code?: number | null;
  stderrTail?: string;
  resumeCommand?: string;
}

type ShellItem = Extract<Item, { kind: 'shell' }>;

/** Live state of one chat. Immutable: every change makes a new object. */
export interface ChatLive {
  /** The repo the chat belongs to (set when its page loads); catch-up requests are made against it. */
  repoId?: string;
  /** The chat's log entries in pos order: the last page loaded from the server, older pages, and what streamed in since. */
  entries: ChatEntry[];
  /** The log's epoch and the version this page has applied up to; unknown until the first page has loaded. */
  epoch?: string;
  version: number;
  /** True once a page has been applied: only then can events be folded in. */
  loaded: boolean;
  /** Entries older than the first one exist (the "Load earlier" button). */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** `!` command blocks: this page session only, never in the log. */
  shells: ShellItem[];
  /** Server readings; set by every page load, catch-up and event. */
  busy?: boolean;
  /** ISO time the running turn started. */
  busySince?: string | null;
  ended?: boolean;
  fatal?: FatalInfo;
  /** Processes the stopped chat left running (after Stop, POSIX); cleared by a kill or when they end. */
  orphans?: boolean;
  /** The message typed ahead (null: none). Unknown until the first page. */
  queue?: QueuedMessage | null;
  /** The chat's current model, effort and mode as the server last reported them. */
  controls?: PickedControls;
  /** The model list from `initialize`; absent until a chat started in this page session. */
  models?: ModelOption[];
  /** Changes picked during a turn, sent after it. */
  pending?: PickedControls | null;
  /** The latest context reading. */
  context?: ContextUsage;
}

// SSE `chat` events are streams, not cache entries, and the Chat tab unmounts when another tab is
// open. So the events are folded here, at module level, and the page reads them back.
const states = new Map<string, ChatLive>();
const listeners = new Set<() => void>();
const EMPTY: ChatLive = {
  entries: [],
  version: 0,
  loaded: false,
  hasEarlier: false,
  loadingEarlier: false,
  shells: [],
};

type SyncReason = 'gap' | 'epoch';
type SyncListener = (chatId: string, reason: SyncReason) => void;
const syncListeners = new Set<SyncListener>();

/**
 * Told when an event cannot be folded in: `gap` (a version was skipped: ask the server for what changed) or `epoch` (the
 * log was rebuilt: load the page again). lib/chat-sync.ts answers.
 */
export function subscribeSync(listener: SyncListener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function update(id: string, fn: (s: ChatLive) => Partial<ChatLive>) {
  const cur = states.get(id) ?? EMPTY;
  states.set(id, { ...cur, ...fn(cur) });
  listeners.forEach((l) => l());
}

/** Puts `e` at its pos: replaces the entry there, or goes in order. `entries` is a copy the caller owns. */
function put(entries: ChatEntry[], e: ChatEntry) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].pos === e.pos) {
      entries[i] = e;
      return;
    }
    if (entries[i].pos < e.pos) {
      entries.splice(i + 1, 0, e);
      return;
    }
  }
  entries.unshift(e);
}

/**
 * Folds the entries of one SSE message in. Each one must be the next version: an older one was already applied (a
 * duplicate), a later one means something was missed (`gap`). A text delta needs the entry it grows. Entries of another
 * epoch mean the log was rebuilt (`epoch`).
 */
function foldLive(
  s: ChatLive,
  epoch: string | undefined,
  incoming: ChatEntry[],
): { patch: Partial<ChatLive>; sync?: SyncReason } {
  if (!s.loaded || s.epoch === undefined) return { patch: {} }; // the page load will have them
  if (epoch !== s.epoch) return { patch: {}, sync: 'epoch' };
  const entries = [...s.entries];
  let version = s.version;
  let result = false;
  let sync: SyncReason | undefined;
  for (const e of incoming) {
    if (e.ver <= version) continue;
    if (e.ver !== version + 1) {
      sync = 'gap';
      break;
    }
    if (e.type === 'text' && e.delta !== undefined) {
      const at = entries.findIndex((x) => x.pos === e.pos);
      const cur = at >= 0 ? entries[at] : undefined;
      if (!cur || cur.type !== 'text') {
        sync = 'gap';
        break;
      }
      entries[at] = { ...cur, text: cur.text + e.delta, ver: e.ver };
    } else {
      put(entries, e);
      if (e.type === 'result') result = true;
    }
    version = e.ver;
  }
  if (version === s.version) return { patch: {}, sync };
  return {
    patch: { entries, version, ...(result ? { busy: false, busySince: null } : {}) },
    sync,
  };
}

function ingest(e: ChatEvent) {
  let sync: SyncReason | undefined;
  update(e.chatId, (s) => {
    if (e.kind === 'fatal') {
      return {
        busy: false,
        busySince: null,
        ended: true,
        fatal: {
          reason: e.reason,
          code: e.code,
          stderrTail: e.stderrTail,
          resumeCommand: e.resumeCommand,
        },
      };
    }
    if (e.kind === 'ended') return { busy: false, busySince: null, ended: true };
    if (e.kind === 'busy')
      return { busy: e.busy === true, busySince: e.busy === true ? (e.busySince ?? null) : null };
    if (e.kind === 'orphans') return { orphans: true };
    if (e.kind === 'orphans-cleared') return { orphans: false };
    if (e.kind === 'queue') return { queue: e.queue ?? null };
    if (e.kind === 'controls')
      return {
        controls: e.controls ?? s.controls,
        models: e.models && e.models.length > 0 ? e.models : s.models,
        pending: e.pending ?? null,
      };
    if (e.kind === 'context') return { context: e.context ?? s.context };
    // 'task' only refreshes queries (events.ts); it carries no entries.
    if (e.kind !== 'event' && e.kind !== 'user' && e.kind !== 'tools_cancelled') return {};
    if (!e.entries || e.entries.length === 0) return {};
    const r = foldLive(s, e.epoch, e.entries);
    sync = r.sync;
    return r.patch;
  });
  if (sync) {
    const reason = sync;
    syncListeners.forEach((fn) => fn(e.chatId, reason));
  }
}

subscribeChat(ingest);

function ingestShell(e: ShellEvent) {
  update(e.chatId, (s) => {
    const at = s.shells.findIndex((i) => i.id === e.runId);
    const cur = at >= 0 ? s.shells[at] : undefined;
    const put = (item: ShellItem) => {
      const shells = [...s.shells];
      if (at >= 0) shells[at] = item;
      else shells.push(item);
      return { shells };
    };
    if (e.kind === 'start') {
      if (cur) return {};
      const last = s.entries[s.entries.length - 1];
      return put({
        kind: 'shell',
        id: e.runId,
        afterPos: last ? last.pos : 0,
        command: e.command ?? '',
        startedAt: e.startedAt,
        output: '',
        truncated: false,
        running: true,
      });
    }
    if (!cur) return {};
    if (e.kind === 'output') return put({ ...cur, output: cur.output + (e.data ?? '') });
    if (e.kind === 'truncated') return put({ ...cur, truncated: true });
    return put({
      ...cur,
      running: false,
      code: e.code ?? null,
      signal: e.signal ?? null,
      durationMs: e.durationMs,
    });
  });
}

subscribeShell(ingestShell);

export const chatStore = {
  get: (id: string): ChatLive => states.get(id) ?? EMPTY,

  /**
   * Applies a freshly fetched page (GET /api/chats/<id>). In the same epoch, entries the page has replace the local
   * ones from their pos on and older pages loaded here stay; a page older than what events already delivered is
   * ignored. Another epoch replaces everything. The server's busy / ended readings come with it.
   */
  loadPage(id: string, repoId: string, d: ChatDetail) {
    update(id, (s) => {
      const sameEpoch = s.loaded && s.epoch === d.epoch;
      if (sameEpoch && d.version < s.version) return { repoId };
      const first = d.entries.length > 0 ? d.entries[0].pos : d.version + 1;
      const older = sameEpoch ? s.entries.filter((e) => e.pos < first) : [];
      return {
        repoId,
        entries: [...older, ...d.entries],
        epoch: d.epoch,
        version: d.version,
        loaded: true,
        hasEarlier: older.length > 0 ? s.hasEarlier : d.has_earlier,
        queue: d.queue,
        busy: d.chat.busy === true,
        busySince: d.chat.busy === true ? (d.chat.busySince ?? null) : null,
        ended: d.chat.status === 'ended',
      };
    });
  },

  /** Older entries from "Load earlier". */
  prependEarlier(id: string, entries: ChatEntry[], hasEarlier: boolean) {
    update(id, (s) => {
      const first = s.entries.length > 0 ? s.entries[0].pos : Infinity;
      return {
        entries: [...entries.filter((e) => e.pos < first), ...s.entries],
        hasEarlier,
        loadingEarlier: false,
      };
    });
  },

  /** Forgets the log (not the live readings): the next page load starts from scratch. */
  unload: (id: string) =>
    update(id, () => ({
      entries: [],
      epoch: undefined,
      version: 0,
      loaded: false,
      hasEarlier: false,
      queue: undefined,
    })),

  setLoadingEarlier: (id: string, loadingEarlier: boolean) =>
    update(id, () => ({ loadingEarlier })),

  /** The answer to a catch-up request: changed entries (full content), and the server's busy / ended / queue. */
  applyCatchUp(id: string, c: ChatCatchUp) {
    update(id, (s) => {
      const entries = [...s.entries];
      for (const e of c.entries) if (e.ver > s.version) put(entries, e);
      return {
        entries,
        version: Math.max(s.version, c.version),
        busy: c.busy,
        busySince: c.busy ? c.busySince : null,
        ended: c.ended,
        queue: c.queue,
      };
    });
  },

  /** The chats whose logs this page holds: what a reconnect catches up. */
  syncable: () =>
    [...states.entries()]
      .filter(([, s]) => s.loaded && s.repoId !== undefined && s.epoch !== undefined)
      .map(([id, s]) => ({
        id,
        repoId: s.repoId as string,
        epoch: s.epoch as string,
        version: s.version,
      })),

  /** After a failed send: `busy` true means a turn this page didn't know about, so its start time comes from the server. */
  setBusy: (id: string, busy: boolean) =>
    update(id, () => ({ busy, busySince: busy ? undefined : null })),
  /** After a message was accepted: the turn has started. */
  turnStarted: (id: string) =>
    update(id, (s) => (s.busy ? {} : { busy: true, busySince: new Date().toISOString() })),
  resumed: (id: string) => update(id, () => ({ ended: false, fatal: undefined, orphans: false })),
  clearOrphans: (id: string) => update(id, () => ({ orphans: false })),
  setQueue: (id: string, queue: QueuedMessage | null) => update(id, () => ({ queue })),
};

/** The cost and usage line source of a chat. */
export const resultOf = (live: ChatLive): ChatResult | null => lastResult(live.entries);

export function useChatLive(id: string | null): ChatLive {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (id ? chatStore.get(id) : EMPTY),
  );
}
