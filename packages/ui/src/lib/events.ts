import type { QueryClient } from '@tanstack/react-query';
import { reportAccessIssue } from '@/lib/api';
import type {
  AccessEndedEvent,
  BannerEvent,
  ChatEvent,
  PromptEvent,
  PromptResolvedEvent,
  ShellEvent,
  TasksData,
} from '@/lib/types';

export const queryKeys = {
  status: ['status'] as const,
  setup: ['setup'] as const,
  tasks: ['tasks'] as const,
  banners: ['banners'] as const,
  prompts: ['prompts'] as const,
  chats: ['chats'] as const,
  chat: (id: string) => ['chat', id] as const,
  diagnostics: ['diagnostics'] as const,
  remote: ['remote'] as const,
  file: (path: string, mode: string) => ['file', path, mode] as const,
};

type ChatListener = (event: ChatEvent) => void;
const chatListeners = new Set<ChatListener>();

/** The chat store subscribes here; `chat` events are streams, not cache entries. */
export function subscribeChat(listener: ChatListener): () => void {
  chatListeners.add(listener);
  return () => chatListeners.delete(listener);
}

type ShellListener = (event: ShellEvent) => void;
const shellListeners = new Set<ShellListener>();

/** The chat store subscribes here too: `shell` events are streams of `!` command output. */
export function subscribeShell(listener: ShellListener): () => void {
  shellListeners.add(listener);
  return () => shellListeners.delete(listener);
}

const MIN_DELAY = 1000;
const MAX_DELAY = 15000;

/**
 * Opens GET /api/events and routes events into the query cache. Reconnects with backoff when the
 * connection is closed for good (EventSource retries by itself only while it is still CONNECTING).
 * Returns a function that closes the stream.
 */
export function connectEvents(queryClient: QueryClient): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = MIN_DELAY;
  let stopped = false;

  const parse = <T>(e: MessageEvent): T | null => {
    try {
      return JSON.parse(e.data) as T;
    } catch {
      return null;
    }
  };

  const open = () => {
    if (stopped) return;
    const es = new EventSource('/api/events', { withCredentials: true });
    source = es;

    es.onopen = () => {
      // The server re-sends every pending prompt on connect, so start from an empty list; this
      // also drops cards resolved while the stream was down.
      queryClient.setQueryData<PromptEvent[]>(queryKeys.prompts, []);
      // After a reconnect, anything missed in between is picked up by refetching.
      if (delay !== MIN_DELAY) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
        void queryClient.invalidateQueries({ queryKey: queryKeys.status });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      }
      delay = MIN_DELAY;
    };

    es.addEventListener('tasks', (e) => {
      const data = parse<TasksData>(e as MessageEvent);
      if (!data) return;
      queryClient.setQueryData(queryKeys.tasks, data);
      // A chat's task list is part of GET /api/chats/<id>; refresh the chats being shown.
      void queryClient.invalidateQueries({ queryKey: ['chat'] });
    });

    es.addEventListener('banner', (e) => {
      const data = parse<BannerEvent>(e as MessageEvent);
      if (!data) return;
      queryClient.setQueryData<BannerEvent[]>(queryKeys.banners, (old = []) => [
        ...old.filter((b) => b.id !== data.id),
        data,
      ]);
    });

    es.addEventListener('chat', (e) => {
      const data = parse<ChatEvent>(e as MessageEvent);
      if (!data) return;
      chatListeners.forEach((fn) => fn(data));
      // The list shows status and last activity; refresh it when a chat ends or a turn finishes.
      const type = (data.event as { type?: unknown } | undefined)?.type;
      const subtype = (data.event as { subtype?: unknown } | undefined)?.subtype;
      // controls, context and busy are live readings, not a change to the chat list.
      if (data.kind === 'controls' || data.kind === 'context' || data.kind === 'busy') return;
      // system/init carries the connector list, which GET /api/chats/<id> reports as `jira`.
      if (type === 'system' && subtype === 'init')
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat(data.chatId) });
      if (data.kind !== 'event' || type === 'result') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
        if (data.kind !== 'event') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat(data.chatId) });
        }
      }
    });

    es.addEventListener('shell', (e) => {
      const data = parse<ShellEvent>(e as MessageEvent);
      if (data) shellListeners.forEach((fn) => fn(data));
    });

    es.addEventListener('prompt', (e) => {
      const data = parse<PromptEvent>(e as MessageEvent);
      if (!data) return;
      queryClient.setQueryData<PromptEvent[]>(queryKeys.prompts, (old = []) => [
        ...old.filter((p) => p.id !== data.id),
        data,
      ]);
    });

    es.addEventListener('prompt-resolved', (e) => {
      const data = parse<PromptResolvedEvent>(e as MessageEvent);
      if (!data) return;
      queryClient.setQueryData<PromptEvent[]>(queryKeys.prompts, (old = []) =>
        old.filter((p) => p.id !== data.id),
      );
    });

    // The server cut this device off (revoked, or phone access turned off) and closed the stream: do not
    // reconnect; show the "not paired" screen with the reason.
    es.addEventListener('access-ended', (e) => {
      const data = parse<AccessEndedEvent>(e as MessageEvent);
      stopped = true;
      es.close();
      source = null;
      reportAccessIssue(data?.reason === 'remote-off' ? 'remote-off' : 'revoked');
    });

    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return; // the browser is retrying on its own
      es.close();
      if (source === es) source = null;
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  };

  open();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = null;
  };
}
