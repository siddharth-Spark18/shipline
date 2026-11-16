import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAllChats } from '@/lib/queries';

/**
 * The project of the chat an address names (#/chat/<chatId>). The flat chat list has it; a chat that isn't in the list
 * yet (just started, or the list hasn't arrived) is asked of the server. `unknown` is a chat no project has.
 */
export function useChatRepo(chatId: string | null) {
  const all = useAllChats();
  const known = chatId ? all.data?.find((c) => c.id === chatId)?.repoId : undefined;
  const lookup = useQuery({
    queryKey: ['chat-repo', chatId],
    queryFn: () => api.chatRepo(chatId ?? ''),
    enabled: Boolean(chatId) && !known && !all.isPending,
    retry: false,
    staleTime: Infinity,
  });
  const repoId = known ?? lookup.data?.repoId ?? null;
  const unknown =
    !repoId && lookup.error instanceof ApiError && lookup.error.code === 'unknown-chat';
  return { repoId, unknown, pending: !repoId && !unknown };
}
