import { useMemo } from 'react';
import { PlusIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { ChatRow, sortChats } from '@/components/chat-row';
import { findTask, usePrompts, useTasks } from '@/lib/queries';
import type { ChatSummary } from '@/lib/types';

/** The phone's Chats tab: every chat as a 64px row, chats waiting for an answer pinned first. */
export function MobileChatList({
  chats,
  selectedId,
  onSelectChat,
  onNewChat,
}: {
  chats: ChatSummary[];
  selectedId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
}) {
  const tasks = useTasks();
  const prompts = usePrompts();
  const waiting = useMemo(() => new Set(prompts.map((p) => p.chatId)), [prompts]);
  const sorted = useMemo(() => {
    const all = sortChats(chats);
    return [...all.filter((c) => waiting.has(c.id)), ...all.filter((c) => !waiting.has(c.id))];
  }, [chats, waiting]);

  if (sorted.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">No chats yet.</p>
        <Button className="h-11 px-5" onClick={onNewChat}>
          <PlusIcon />
          New chat
        </Button>
      </div>
    );
  }

  return (
    <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
      {sorted.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelectChat(c.id)}
            aria-current={c.id === selectedId ? 'true' : undefined}
            className={cn(
              'flex min-h-16 w-full items-center px-4 py-2 text-left text-sm active:bg-muted',
              c.id === selectedId && 'bg-accent text-accent-foreground',
            )}
          >
            <ChatRow
              chat={c}
              task={findTask(tasks.data?.tasks, c.task_dir)}
              waiting={waiting.has(c.id)}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
