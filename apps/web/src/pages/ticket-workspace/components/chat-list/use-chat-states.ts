import { SessionState } from '@shipline/shared';
import { useLocalReady, useLocalSessions } from '@/services/local/local.hooks';
import { SessionRow } from '@/services/local/local.types';
import { useChats } from '@/services/tickets/tickets.hooks';
import { ChatRow } from '@/services/tickets/tickets.types';

/** running: Claude is working a turn. waiting: a prompt, a proposal or review comments need you. idle: neither. */
export function chatState(chat: ChatRow, sessions: SessionRow[]): SessionState {
  if (chat.status === 'DONE') return 'idle';
  const session = sessions.find((s) => s.ticketId === chat.ticketId);
  if (chat.hasPendingTransition || chat.newComments > 0 || session?.state === 'waiting') return 'waiting';
  if (session?.state === 'running') return 'running';
  return 'idle';
}

/** The user's chats with their live state: the chat list, the module badge and the status bar read this. */
export function useChatStates() {
  const chats = useChats();
  const local = useLocalReady();
  const sessions = useLocalSessions(local.ready);
  const rows = chats.data ?? [];
  const live = sessions.data ?? [];
  const states = rows.map((c) => ({ chat: c, state: chatState(c, live) }));
  return {
    isPending: chats.isPending,
    sessions: live,
    states,
    waiting: states.filter((s) => s.state === 'waiting').length,
  };
}
