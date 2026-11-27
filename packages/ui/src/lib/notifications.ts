// Browser notifications for what needs you (a permission prompt, a question, a stage gate, a finished turn, a chat that
// stopped) and the tab-title badge. Per device: the choices live in localStorage. No library, no service worker: they
// only work while a Shipline tab is open.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, subscribeChat } from '@/lib/events';
import { chatHash } from '@/lib/routes';
import type { ChatListItem, PromptEvent } from '@/lib/types';
import { inputSummary, toMs } from '@/pages/chat/timeline';

export type NotifyKind = 'prompt' | 'stage' | 'turn' | 'ended';

/** The per-device toggles, in the order the popover lists them. */
export const NOTIFY_KINDS: { kind: NotifyKind; label: string; hint: string }[] = [
  { kind: 'prompt', label: 'Permission prompts and questions', hint: 'Claude waits for an answer' },
  { kind: 'stage', label: 'Stage gates', hint: 'A stage asks to move on' },
  { kind: 'turn', label: 'Turn finished', hint: 'Only while this tab is hidden' },
  { kind: 'ended', label: 'Chat stopped unexpectedly', hint: 'Claude crashed or exited' },
];

export type NotifyPrefs = Record<NotifyKind, boolean>;

const PREFS_KEY = 'shipline.notify.prefs';
const BANNER_KEY = 'shipline.notify.bannerDismissed';
const NOTIFIED_KEY = 'shipline.notify.notified';
const DEFAULT_PREFS: NotifyPrefs = { prompt: true, stage: true, turn: true, ended: true };
/** The last minute of a prompt's wait: it turns warning-coloured and notifies once more. */
export const LAST_MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts until the page reloads.
  }
};

/** True where the Notification API exists (not on iOS Safari outside a home-screen app). */
export const notificationsSupported = () =>
  typeof window !== 'undefined' && 'Notification' in window;

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Asks the browser (must come from a click). */
export async function enableNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    await Notification.requestPermission();
  } catch {
    // Older Safari takes a callback only; the permission is read below either way.
  }
  changed();
  return Notification.permission;
}

export function getPrefs(): NotifyPrefs {
  try {
    const raw = read(PREFS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      return {
        prompt: p.prompt !== false,
        stage: p.stage !== false,
        turn: p.turn !== false,
        ended: p.ended !== false,
      };
    }
  } catch {
    // Unreadable: the defaults.
  }
  return { ...DEFAULT_PREFS };
}

export function setPref(kind: NotifyKind, on: boolean) {
  write(PREFS_KEY, JSON.stringify({ ...getPrefs(), [kind]: on }));
  changed();
}

export const bannerDismissed = () => read(BANNER_KEY) === '1';
export function dismissBanner() {
  write(BANNER_KEY, '1');
  changed();
}

/** Re-renders when the permission, the toggles or the banner choice changed (here or in another tab). */
export function useNotifyState() {
  const [, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN((n) => n + 1);
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_KEY || e.key === BANNER_KEY) fn();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return {
    permission: notificationPermission(),
    prefs: getPrefs(),
    dismissed: bannerDismissed(),
  };
}

// The chat on screen: a prompt of that chat does not notify while the tab is in front.
let viewing: string | null = null;
export function setViewingChat(chatId: string | null) {
  viewing = chatId;
}

export interface NotifyOptions {
  title: string;
  body: string;
  chatId: string;
  /** Same tag, one notification: a later one replaces it. */
  tag: string;
}

/**
 * Shows one notification when the device allows it (permission granted and the toggle on). Prompts and chat endings
 * stay quiet while that chat is on screen in a visible tab; a finished turn only notifies while the tab is hidden.
 * Returns whether it was shown.
 */
export function notify(kind: NotifyKind, o: NotifyOptions): boolean {
  if (notificationPermission() !== 'granted' || !getPrefs()[kind]) return false;
  const visible = document.visibilityState === 'visible';
  if (kind === 'turn' ? visible : visible && viewing === o.chatId) return false;
  try {
    const n = new Notification(o.title, { body: o.body, tag: o.tag });
    n.onclick = () => {
      window.focus();
      window.location.hash = chatHash(o.chatId);
      n.close();
    };
    return true;
  } catch {
    return false; // Some mobile browsers only allow notifications from a service worker.
  }
}

/** `(n) Shipline` while n chats wait for you. */
export function useTitleBadge(n: number) {
  useEffect(() => {
    document.title = n > 0 ? `(${n}) Shipline` : 'Shipline';
  }, [n]);
}

// ---------- what notifies ----------

const PRUNE_AT = 200;
const notified = (() => {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(NOTIFIED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set<string>();
  }
})();
/** Remembers (for this tab's session) that a prompt was announced, so a reconnect that sends it again does not repeat it. */
const markNotified = (id: string): boolean => {
  if (notified.has(id)) return false;
  notified.add(id);
  if (notified.size > PRUNE_AT) notified.delete(notified.values().next().value as string);
  try {
    sessionStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified]));
  } catch {
    // Not remembered across a reload.
  }
  return true;
};

const STAGE_HEADER = /stage|gate/i;

function describePrompt(
  p: PromptEvent,
  chatTitle: string,
): { kind: NotifyKind; title: string; body: string } {
  if (p.tool === 'AskUserQuestion') {
    const qs = (p.input as { questions?: unknown } | null)?.questions;
    const first = Array.isArray(qs)
      ? (qs[0] as { header?: unknown; question?: unknown } | undefined)
      : undefined;
    const header = typeof first?.header === 'string' ? first.header.trim() : '';
    const question = typeof first?.question === 'string' ? first.question : '';
    const stage = STAGE_HEADER.test(header);
    return {
      kind: stage ? 'stage' : 'prompt',
      title: stage
        ? `Stage gate: ${header}`
        : header
          ? `Question: ${header}`
          : 'Claude has a question',
      body: [chatTitle, question].filter(Boolean).join(' · '),
    };
  }
  return {
    kind: 'prompt',
    title: `Claude wants to use ${p.tool}`,
    body: [chatTitle, inputSummary(p.tool, p.input)].filter(Boolean).join(' · '),
  };
}

/**
 * Notifies when a prompt arrives (and once more in its last minute if it is still waiting), when a turn finishes in a
 * hidden tab, and when a chat stops unexpectedly. Mounted once, for the whole app.
 */
export function useChatNotifications(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const titleOf = (chatId: string) =>
      queryClient.getQueryData<ChatListItem[]>(queryKeys.allChats)?.find((c) => c.id === chatId)
        ?.title ?? '';
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const announce = (p: PromptEvent, lastMinute: boolean) => {
      const d = describePrompt(p, titleOf(p.chatId));
      notify(d.kind, {
        title: lastMinute ? `Answer soon: ${d.title}` : d.title,
        body: d.body,
        chatId: p.chatId,
        tag: `prompt:${p.id}`,
      });
    };

    const check = () => {
      const prompts = queryClient.getQueryData<PromptEvent[]>(queryKeys.prompts) ?? [];
      const live = new Set(prompts.map((p) => p.id));
      for (const [id, t] of timers)
        if (!live.has(id)) {
          clearTimeout(t);
          timers.delete(id);
        }
      for (const p of prompts) {
        if (!markNotified(p.id)) continue;
        announce(p, false);
        const wait = toMs(p.expiresAt) - Date.now() - LAST_MINUTE_MS;
        if (wait > 0 && !timers.has(p.id))
          timers.set(
            p.id,
            setTimeout(() => {
              timers.delete(p.id);
              const still = queryClient.getQueryData<PromptEvent[]>(queryKeys.prompts) ?? [];
              if (still.some((x) => x.id === p.id)) announce(p, true);
            }, wait),
          );
      }
    };
    const stopCache = queryClient.getQueryCache().subscribe((e) => {
      if (e.type === 'updated' && e.query.queryKey[0] === queryKeys.prompts[0]) check();
    });

    const stopChat = subscribeChat((e) => {
      if (e.kind === 'fatal') {
        notify('ended', {
          title: 'Chat stopped',
          body: [
            titleOf(e.chatId),
            e.reason === 'resume-failed' ? 'Claude could not resume' : 'Claude exited unexpectedly',
          ]
            .filter(Boolean)
            .join(' · '),
          chatId: e.chatId,
          tag: `ended:${e.chatId}`,
        });
      } else if (e.kind === 'event' && e.entries?.some((x) => x.type === 'result')) {
        notify('turn', {
          title: 'Claude finished',
          body: titleOf(e.chatId),
          chatId: e.chatId,
          tag: `turn:${e.chatId}`,
        });
      }
    });

    return () => {
      stopCache();
      stopChat();
      timers.forEach((t) => clearTimeout(t));
    };
  }, [enabled, queryClient]);
}
