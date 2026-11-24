import type { QueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { keysFor, queryKeys, subscribeReconnect } from '@/lib/events';
import type { PromptEvent } from '@/lib/types';
import { chatStore, subscribeSync } from '@/pages/chat/chat-store';

const RETRIES = 3;
const inflight = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loads the chat's page again (it is on screen), or forgets what this tab holds of it (it is not: the next open loads it). */
async function reload(queryClient: QueryClient, repoId: string, chatId: string) {
  const key = keysFor(repoId).chat(chatId);
  const onScreen =
    (queryClient.getQueryCache().find({ queryKey: key })?.getObserversCount() ?? 0) > 0;
  if (onScreen) await queryClient.invalidateQueries({ queryKey: key });
  else chatStore.unload(chatId);
}

/**
 * Brings one chat's entries up to date: asks the server what changed after the version this tab has applied, and takes
 * busy / ended / pending prompts / the queue from the answer (so nothing local is left over from before a missed
 * stretch). When the log was rebuilt (410 gap), or the request keeps failing, the page is loaded again instead.
 */
export async function catchUpChat(
  queryClient: QueryClient,
  chatId: string,
  reason: 'gap' | 'epoch' | 'reconnect' = 'gap',
) {
  if (inflight.has(chatId)) return;
  const first = chatStore.get(chatId);
  if (!first.loaded || first.repoId === undefined || first.epoch === undefined) return;
  const repoId = first.repoId;
  inflight.add(chatId);
  try {
    if (reason === 'epoch') return await reload(queryClient, repoId, chatId);
    for (let attempt = 0; ; attempt++) {
      const s = chatStore.get(chatId);
      if (s.epoch === undefined) return;
      try {
        const c = await api.chatCatchUp(repoId, chatId, s.version, s.epoch);
        chatStore.applyCatchUp(chatId, c);
        queryClient.setQueryData<PromptEvent[]>(queryKeys.prompts, (old = []) => [
          ...old.filter((p) => p.chatId !== chatId),
          ...c.prompts.map((p) => ({ ...p, repoId })),
        ]);
        return;
      } catch (e) {
        if ((e instanceof ApiError && e.code === 'gap') || attempt >= RETRIES - 1)
          return await reload(queryClient, repoId, chatId);
        await sleep(1000 * 2 ** attempt);
      }
    }
  } finally {
    inflight.delete(chatId);
  }
}

/** Catches up every chat this tab holds a log of (after the event stream came back). */
export function catchUpAll(queryClient: QueryClient) {
  for (const c of chatStore.syncable()) void catchUpChat(queryClient, c.id, 'reconnect');
}

/** Answers the store's `gap` / `epoch` signals and every event-stream reconnect; returns what stops it. */
export function startChatSync(queryClient: QueryClient): () => void {
  const stopSync = subscribeSync((chatId, reason) => void catchUpChat(queryClient, chatId, reason));
  const stopReconnect = subscribeReconnect(() => catchUpAll(queryClient));
  return () => {
    stopSync();
    stopReconnect();
  };
}
