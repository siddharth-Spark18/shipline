import type { QueryClient } from '@tanstack/react-query';
import { getCurrentRepo, reportAccessIssue } from '@/lib/api';
import { applyPalette, isPaletteId } from '@/lib/palette';
import type {
  AccessEndedEvent,
  BannerEvent,
  ChatEvent,
  ChatListItem,
  PromptEvent,
  PromptResolvedEvent,
  Preferences,
  Project,
  ShellEvent,
  TasksData,
  WorkflowDraftInfo,
} from '@/lib/types';

/** The query keys of one repo's data. Events carry a repoId and write to these, whichever repo is on screen. */
export const keysFor = (repoId: string) => ({
  status: ['status', repoId] as const,
  setup: ['setup', repoId] as const,
  tasks: ['tasks', repoId] as const,
  drafts: ['drafts', repoId] as const,
  banners: ['banners', repoId] as const,
  chats: ['chats', repoId] as const,
  chat: (id: string) => ['chat', repoId, id] as const,
  file: (path: string, mode: string) => ['file', repoId, path, mode] as const,
});

const cur = () => keysFor(getCurrentRepo() ?? '');

/**
 * The keys components use: the repo's own ones are for the repo on screen (the app is keyed by it, so they never mix);
 * prompts, remote, projects and overview are server-wide.
 */
export const queryKeys = {
  get status() {
    return cur().status;
  },
  get setup() {
    return cur().setup;
  },
  get tasks() {
    return cur().tasks;
  },
  get drafts() {
    return cur().drafts;
  },
  get banners() {
    return cur().banners;
  },
  get chats() {
    return cur().chats;
  },
  chat: (id: string) => cur().chat(id),
  file: (path: string, mode: string) => cur().file(path, mode),
  /** Pending prompts of every repo; each carries its repoId. */
  prompts: ['prompts'] as const,
  remote: ['remote'] as const,
  /** Server-wide UI preferences (the palette). */
  preferences: ['preferences'] as const,
  projects: ['projects'] as const,
  overview: ['overview'] as const,
  /** The flat chat list across every project. (`chats` above is one project's own list.) */
  allChats: ['all-chats'] as const,
  health: ['health'] as const,
  /** One project's diagnostics, for its Health row. */
  diagnostics: (repoId: string) => ['diagnostics', repoId] as const,
  /** One project's status, for its Health row. */
  statusOf: (repoId: string) => ['status-of', repoId] as const,
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
 * Opens GET /api/events (one stream for every repo) and routes events into the query cache by their repoId. Reconnects with backoff when the
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
        for (const key of ['tasks', 'drafts', 'status', 'chats', 'chat', 'banners'])
          void queryClient.invalidateQueries({ queryKey: [key] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
        void queryClient.invalidateQueries({ queryKey: queryKeys.allChats });
        void queryClient.invalidateQueries({ queryKey: queryKeys.health });
        void queryClient.invalidateQueries({ queryKey: queryKeys.preferences });
      }
      delay = MIN_DELAY;
    };

    // The projects list (registration, state, waiting count, chat running).
    es.addEventListener('projects', (e) => {
      const data = parse<Project[]>(e as MessageEvent);
      if (!data) return;
      queryClient.setQueryData(queryKeys.projects, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      // The health dot follows registration, state and waiting changes.
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
    });

    // The palette was changed (by this browser, another tab or a phone).
    es.addEventListener('preferences', (e) => {
      const data = parse<Preferences>(e as MessageEvent);
      if (!data || !isPaletteId(data.palette)) return;
      queryClient.setQueryData(queryKeys.preferences, { palette: data.palette });
      applyPalette(data.palette);
    });

    // The flat chat list: a chat was added, a task's stage or a waiting state changed.
    es.addEventListener('chats', (e) => {
      const data = parse<ChatListItem[]>(e as MessageEvent);
      if (data) queryClient.setQueryData(queryKeys.allChats, data);
    });

    es.addEventListener('tasks', (e) => {
      const data = parse<TasksData & { repoId?: string }>(e as MessageEvent);
      if (!data || !data.repoId) return;
      queryClient.setQueryData(keysFor(data.repoId).tasks, data);
      // A chat's task list is part of GET /api/repos/<id>/chats/<id>; refresh the chats being shown.
      void queryClient.invalidateQueries({ queryKey: ['chat', data.repoId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    });

    // Workflow drafts: one was made, replaced, saved or discarded.
    es.addEventListener('drafts', (e) => {
      const data = parse<{ repoId?: string; drafts: WorkflowDraftInfo[] }>(e as MessageEvent);
      if (!data || !data.repoId || !Array.isArray(data.drafts)) return;
      queryClient.setQueryData(keysFor(data.repoId).drafts, data.drafts);
    });

    es.addEventListener('banner', (e) => {
      const data = parse<BannerEvent>(e as MessageEvent);
      if (!data || !data.repoId) return;
      queryClient.setQueryData<BannerEvent[]>(keysFor(data.repoId).banners, (old = []) => [
        ...old.filter((b) => b.id !== data.id),
        data,
      ]);
    });

    es.addEventListener('chat', (e) => {
      const data = parse<ChatEvent>(e as MessageEvent);
      if (!data) return;
      chatListeners.forEach((fn) => fn(data));
      const keys = data.repoId ? keysFor(data.repoId) : null;
      if (!keys) return;
      // The list shows status and last activity; refresh it when a chat ends or a turn finishes.
      const type = (data.event as { type?: unknown } | undefined)?.type;
      const subtype = (data.event as { subtype?: unknown } | undefined)?.subtype;
      // controls, context and busy are live readings, not a change to the chat list.
      if (data.kind === 'controls' || data.kind === 'context' || data.kind === 'busy') return;
      // system/init carries the connector list, which GET /api/chats/<id> reports as `jira`.
      if (type === 'system' && subtype === 'init')
        void queryClient.invalidateQueries({ queryKey: keys.chat(data.chatId) });
      if (data.kind !== 'event' || type === 'result') {
        void queryClient.invalidateQueries({ queryKey: keys.chats });
        void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
        void queryClient.invalidateQueries({ queryKey: queryKeys.allChats });
        if (data.kind !== 'event') {
          void queryClient.invalidateQueries({ queryKey: keys.chat(data.chatId) });
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
