import { useMemo } from 'react';
import { PlusIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { ChatRow, sortChats } from '@/components/chat-row';
import type { ChatListItem, Project } from '@/lib/types';

/**
 * The phone's Chats tab: every chat of every project as a 64px row, chats waiting for you pinned first. Chats of a
 * project that isn't served are left out.
 */
export function MobileChatList({
  chats,
  projects,
  selectedId,
  onSelectChat,
  onNewChat,
}: {
  chats: ChatListItem[];
  projects: Project[];
  selectedId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
}) {
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const sorted = useMemo(() => {
    const all = sortChats(chats).filter((c) => byId.get(c.repoId)?.state === 'ok');
    return [...all.filter((c) => c.waiting), ...all.filter((c) => !c.waiting)];
  }, [chats, byId]);

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
            <ChatRow chat={c} project={byId.get(c.repoId)} />
          </button>
        </li>
      ))}
    </ul>
  );
}
