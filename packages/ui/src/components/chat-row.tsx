import { Badge } from '@/components/ui/badge';
import { StageDot, StageTrail } from '@/components/stage-dots';
import type { ChatSummary, Task } from '@/lib/types';

/** Active chats first, then the most recently active; the server already sends newest first. */
export function sortChats(chats: ChatSummary[]): ChatSummary[] {
  const stamp = (c: ChatSummary) => new Date(c.last_active).getTime() || 0;
  return [...chats].sort(
    (a, b) => Number(b.status === 'active') - Number(a.status === 'active') || stamp(b) - stamp(a),
  );
}

/** The folder name of a task, used as its title when the task is finished and so not in the unfinished list. */
const taskName = (dir: string) =>
  dir
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? dir;

/**
 * What one chat shows in a list: title, "Needs answer" badge, the task it works on and its stage dots.
 * The sidebar wraps it in a menu button, the phone's Chats tab in a 64px row.
 */
export function ChatRow({
  chat,
  task,
  waiting,
}: {
  chat: ChatSummary;
  /** The task the chat works in, when it is among the unfinished ones. */
  task: Task | undefined;
  /** The chat has a prompt waiting for an answer. */
  waiting: boolean;
}) {
  const active = chat.status === 'active';
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <StageDot status={active ? 'in_progress' : 'done'} className="size-2 ring-2" />
        <span className="min-w-0 flex-1 truncate">{chat.title || 'Untitled chat'}</span>
        {waiting && <Badge className="h-4 px-1.5 text-[10px]">Needs answer</Badge>}
      </div>
      {chat.task_dir && (
        <div className="flex min-w-0 items-center gap-2 pl-4 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {task ? task.title || task.slug : taskName(chat.task_dir)}
          </span>
          {task && <StageTrail stages={task.stages} />}
        </div>
      )}
    </div>
  );
}
