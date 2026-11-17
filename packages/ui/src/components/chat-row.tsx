import { StageTrail } from '@/components/stage-dots';
import type { ChatListItem, Project, WaitingReason } from '@/lib/types';

export const WAITING_LABEL: Record<WaitingReason, string> = {
  permission: 'Permission needed',
  question: 'Question or confirmation waiting',
  error: 'Stopped with an error',
};

/** Newest activity first (the server sends it that way; this keeps a list that was patched in place in order). */
export function sortChats(chats: ChatListItem[]): ChatListItem[] {
  const stamp = (c: ChatListItem) => (c.updatedAt ? new Date(c.updatedAt).getTime() : 0) || 0;
  return [...chats].sort((a, b) => stamp(b) - stamp(a));
}

/** The project's name, plus the worktree folder when it isn't the main worktree ("repo / worktree"). */
export function projectLabel(p: Pick<Project, 'name' | 'groupName'> | undefined): string {
  if (!p) return 'Unknown project';
  return p.groupName && p.groupName !== p.name ? `${p.groupName} / ${p.name}` : p.name;
}

/**
 * What one chat shows in the flat list: title and waiting dot, then its project, workflow and stage dots. The sidebar
 * wraps it in a menu button, the phone's Chats tab in a 64px row.
 */
export function ChatRow({
  chat,
  project,
  onSidebar,
}: {
  chat: ChatListItem;
  project: Project | undefined;
  /** In the sidebar, which has its own colours (a branded background in most palettes). */
  onSidebar?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{chat.title || 'Untitled chat'}</span>
        {chat.waiting && (
          <span
            role="img"
            className={`size-2 shrink-0 rounded-full ${onSidebar ? 'bg-sidebar-primary group-data-[active=true]/menu-button:bg-(color:--sidebar-active-foreground)' : 'bg-primary'}`}
            aria-label={WAITING_LABEL[chat.waiting]}
            title={WAITING_LABEL[chat.waiting]}
          />
        )}
      </div>
      <div
        className={`flex min-w-0 items-center gap-2 text-xs ${onSidebar ? 'text-sidebar-foreground/70 group-data-[active=true]/menu-button:text-(color:--sidebar-active-foreground)' : 'text-muted-foreground'}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {projectLabel(project)}
          {chat.task ? ` · ${chat.task.workflow}` : ''}
        </span>
        {chat.task && <StageTrail stages={chat.task.stages} />}
      </div>
    </div>
  );
}
