import { Link, useMatch } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { SessionState } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ChatRow } from '@/services/tickets/tickets.types';
import { useChatStates } from './use-chat-states';

const GROUPS: Array<{ state: SessionState; label: string }> = [
  { state: 'waiting', label: 'Waiting on you' },
  { state: 'running', label: 'Running' },
  { state: 'idle', label: 'Idle' },
];

const DOT: Record<SessionState, string> = {
  running: 'bg-green-500 animate-pulse',
  waiting: 'bg-amber-500',
  idle: 'bg-border',
};

function ChatItem({ chat, state, active }: { chat: ChatRow; state: SessionState; active: boolean }) {
  return (
    <Link
      to={`/chats/${chat.ticketId}`}
      className={cn('flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent', active && 'bg-accent font-medium')}
      title={chat.title}
    >
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[state])} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{chat.title}</span>
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <span className="font-mono">{chat.key}</span>
          {chat.status === 'DONE' && <span>done</span>}
          {chat.jiraKey && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]" title={`Jira ${chat.jiraKey}`}>
              Jira
            </Badge>
          )}
        </span>
      </span>
    </Link>
  );
}

/** The Chats module's list, grouped Waiting on you / Running / Idle. It is the chat switcher. */
export default function ChatListPanel() {
  const { states, isPending } = useChatStates();
  const activeId = useMatch('/chats/:ticketId')?.params.ticketId;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="p-2">
        <Button variant="outline" size="sm" className="w-full" asChild>
          <Link to="/">
            <Plus /> New chat
          </Link>
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-2">
          {isPending ? (
            <div className="space-y-2 pt-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : states.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">No chats yet. Start one: pick a project and describe the work.</p>
          ) : (
            GROUPS.map((g) => {
              const rows = states.filter((s) => s.state === g.state);
              if (rows.length === 0) return null;
              return (
                <section key={g.state}>
                  <h3 className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">{g.label}</h3>
                  {rows.map((r) => (
                    <ChatItem key={r.chat.ticketId} chat={r.chat} state={r.state} active={r.chat.ticketId === activeId} />
                  ))}
                </section>
              );
            })
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
