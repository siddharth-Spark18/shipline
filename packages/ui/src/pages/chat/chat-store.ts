import { useSyncExternalStore } from 'react';
import { subscribeChat, subscribeShell } from '@/lib/events';
import type {
  ChatEvent,
  ContextUsage,
  ImageData,
  ModelOption,
  PickedControls,
  ShellEvent,
} from '@/lib/types';
import {
  applyEvent,
  newCtx,
  resultSummary,
  type ChatResult,
  type Item,
  type StreamCtx,
} from '@/pages/chat/timeline';

export interface FatalInfo {
  reason?: 'parse' | 'exit' | 'resume-failed';
  code?: number | null;
  stderrTail?: string;
  resumeCommand?: string;
}

/** Live (this page session) state of one chat. Immutable: every change makes a new object. */
export interface ChatLive {
  /** Items since the page loaded (or since the last history fetch). */
  items: Item[];
  /** Unknown until this page sees a turn start or end; then the server's `chat.busy` applies. */
  busy?: boolean;
  /** ISO time the running turn started, from a local send or the `busy` event; never from the fetched chat. */
  busySince?: string | null;
  /** Unknown until an `ended`/`fatal` event or a continue; then the server's status applies. */
  ended?: boolean;
  fatal?: FatalInfo;
  /** Processes the stopped chat left running (after Stop, POSIX); cleared by a kill or when they end. */
  orphans?: boolean;
  result: ChatResult | null;
  ctx: StreamCtx;
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
const EMPTY: ChatLive = { items: [], result: null, ctx: newCtx() };

function update(id: string, fn: (s: ChatLive) => Partial<ChatLive>) {
  const cur = states.get(id) ?? { ...EMPTY, ctx: newCtx() };
  states.set(id, { ...cur, ...fn(cur) });
  listeners.forEach((l) => l());
}

function ingest(e: ChatEvent) {
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
    if (e.kind === 'controls')
      return {
        controls: e.controls ?? s.controls,
        models: e.models && e.models.length > 0 ? e.models : s.models,
        pending: e.pending ?? null,
      };
    if (e.kind === 'context') return { context: e.context ?? s.context };
    // 'task' only refreshes queries (events.ts); it carries no stream event.
    if (e.kind !== 'event') return {};
    const items = applyEvent(s.items, e.event, s.ctx);
    const result = resultSummary(e.event);
    return result ? { items, result, busy: false, busySince: null } : { items };
  });
}

subscribeChat(ingest);

function ingestShell(e: ShellEvent) {
  update(e.chatId, (s) => {
    const at = s.items.findIndex((i) => i.kind === 'shell' && i.id === e.runId);
    const cur = at >= 0 ? s.items[at] : undefined;
    const put = (item: Item) => {
      const items = [...s.items];
      if (at >= 0) items[at] = item;
      else items.push(item);
      return { items };
    };
    if (e.kind === 'start') {
      if (cur) return {};
      return put({
        kind: 'shell',
        id: e.runId,
        command: e.command ?? '',
        startedAt: e.startedAt,
        output: '',
        truncated: false,
        running: true,
      });
    }
    if (!cur || cur.kind !== 'shell') return {};
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
  /** The composer echoes the user's message; stream-json does not. `prepend` is for a new chat. */
  addUser(id: string, text: string, prepend = false, images: ImageData[] = []): string {
    const item: Item = {
      kind: 'user',
      id: `u-local-${Date.now()}-${Math.random()}`,
      text,
      ...(images.length > 0 ? { images } : {}),
    };
    update(id, (s) => ({
      items: prepend ? [item, ...s.items] : [...s.items, item],
      busy: true,
      busySince: new Date().toISOString(),
    }));
    return item.id;
  },
  /** Takes back an echoed message whose POST failed. */
  dropItem: (id: string, itemId: string) =>
    update(id, (s) => ({ items: s.items.filter((i) => i.id !== itemId) })),
  /** After a failed send: `busy` true means a turn this page didn't know about, so its start time comes from the server. */
  setBusy: (id: string, busy: boolean) =>
    update(id, () => ({ busy, busySince: busy ? undefined : null })),
  resumed: (id: string) => update(id, () => ({ ended: false, fatal: undefined, orphans: false })),
  clearOrphans: (id: string) => update(id, () => ({ orphans: false })),
  recordDenied: (id: string, tool: string) =>
    update(id, (s) => {
      s.ctx.denied.push(tool);
      return {};
    }),
  liveCount: (id: string) => states.get(id)?.items.length ?? 0,
  /** Drops the first `n` live items once a history fetch has them. */
  trimLive: (id: string, n: number) => {
    if (n > 0) update(id, (s) => ({ items: s.items.slice(n) }));
  },
};

export function useChatLive(id: string | null): ChatLive {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (id ? chatStore.get(id) : EMPTY),
  );
}
