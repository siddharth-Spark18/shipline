import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';

/**
 * Which chat is open. Lives above the chat page so the sidebar's chat list and the page share it.
 * The active chat is opened the first time the list arrives; `select(null)` is "new chat".
 */
export function useChatSelection() {
  const chats = useQuery({ queryKey: queryKeys.chats, queryFn: api.chats });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (picked || !chats.data) return;
    setPicked(true);
    const active = chats.data.chats.find((c) => c.status === 'active');
    if (active) setSelectedId(active.id);
  }, [chats.data, picked]);

  const select = (id: string | null) => {
    setPicked(true);
    setSelectedId(id);
  };

  return { chats, selectedId, select };
}
