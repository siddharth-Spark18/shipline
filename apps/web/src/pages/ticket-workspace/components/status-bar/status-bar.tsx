import { GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocalReady } from '@/services/local/local.hooks';
import { StageView, TicketDetail } from '@/services/tickets/tickets.types';
import StagePopover from '../stages/stage-popover';
import { progressLabel, stageProgress } from '../stages/stage-progress';
import PrStatusItem from './pr-comments';

interface StatusBarProps {
  /** The project being worked in; on the new-chat screen it is the picked one. */
  projectName: string | null;
  /** The open chat, if any. */
  ticket?: TicketDetail | null;
  sessionRunning?: boolean;
  /** Chats of the user that wait on them (a prompt, a proposal or review comments). */
  waiting: number;
  onOpenArtifact?: (stage: StageView) => void;
}

/**
 * Bottom status bar (wireframe variant B): project, branch, the chat key or Jira key, chats waiting,
 * PR status with "N new comments -> Send to Claude", and the stage item that opens the stage popover.
 */
export default function StatusBar({ projectName, ticket, sessionRunning = false, waiting, onOpenArtifact }: StatusBarProps) {
  const local = useLocalReady();
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-hidden bg-primary px-2.5 text-xs whitespace-nowrap text-primary-foreground">
      <span>{projectName ?? 'No project'}</span>
      {ticket && (
        <span className="flex items-center gap-1" title={ticket.branch ? 'Branch' : 'The named branch is created at the first file edit'}>
          <GitBranch className="size-3" />
          {ticket.branch ?? 'no branch yet'}
        </span>
      )}
      {ticket && (
        <span className="font-medium" title={ticket.jiraKey ? `Chat ${ticket.key}, Jira ${ticket.jiraKey}` : `Chat ${ticket.key}`}>
          {ticket.jiraKey ?? ticket.key}
        </span>
      )}
      <span className="ml-auto flex items-center gap-4">
        <span className="flex items-center gap-1.5" title={local.ready ? 'Shipline Local is connected' : 'Shipline Local is not ready'}>
          <span className={cn('size-1.5 rounded-full', local.ready ? 'bg-green-400' : 'bg-amber-400')} />
          Local
        </span>
        <span>{waiting > 0 ? `${waiting} chat${waiting === 1 ? '' : 's'} waiting` : 'No chats waiting'}</span>
        {ticket && <PrStatusItem ticket={ticket} sessionRunning={sessionRunning} />}
        {ticket && (
          <StagePopover
            ticket={ticket}
            side="top"
            onOpenArtifact={onOpenArtifact}
            trigger={
              <button type="button" className="cursor-pointer rounded bg-primary-foreground px-2 py-px font-semibold text-primary">
                {progressLabel(stageProgress(ticket.stages))} &#9652;
              </button>
            }
          />
        )}
      </span>
    </div>
  );
}
