import { ExternalLink, Loader2, MessageSquare, PanelRight, Play, Square, TerminalSquare } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { LocalApiError } from '@/lib/local-api';
import { SessionRow } from '@/services/local/local.types';
import { StageView, TicketDetail } from '@/services/tickets/tickets.types';
import { SessionStream } from '@/pages/ticket-workspace/hooks/use-session-stream';
import { AssetRef } from '@/pages/ticket-workspace/types';
import ChatTitle from '../header/chat-title';
import HistorySheet from '../header/history-sheet';
import StagePopover, { StagePill } from '../stages/stage-popover';
import ChatView from './chat-view';
import TerminalView from './terminal-view';

interface CenterPanelProps {
  ticket: TicketDetail;
  session: SessionRow | null;
  stream: SessionStream;
  localReady: boolean;
  ghInstalled: boolean | null;
  starting: boolean;
  startError: unknown;
  onStart: (mode?: 'chat' | 'terminal') => void;
  onStop: () => void;
  stopping: boolean;
  onOpenAsset: (asset: AssetRef) => void;
  onOpenChanges: (focusPath?: string) => void;
  onOpenArtifact: (stage: StageView) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

/** The wide chat column: header (key, title, branch, stage pill), the conversation, the composer. */
export default function CenterPanel({
  ticket,
  session,
  stream,
  localReady,
  ghInstalled,
  starting,
  startError,
  onStart,
  onStop,
  stopping,
  onOpenAsset,
  onOpenChanges,
  onOpenArtifact,
  panelOpen,
  onTogglePanel,
}: CenterPanelProps) {
  const startErr = startError instanceof LocalApiError ? startError : null;

  const header = (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <span className="shrink-0 text-sm font-semibold">{ticket.key}</span>
      <ChatTitle ticketId={ticket.id} title={ticket.title} editable={ticket.isOwner} />
      {ticket.jiraKey &&
        (ticket.jiraUrl ? (
          <Badge variant="outline" asChild>
            <a href={ticket.jiraUrl} target="_blank" rel="noreferrer" title={ticket.jiraSummary ?? undefined}>
              {ticket.jiraKey} <ExternalLink className="size-3" />
            </a>
          </Badge>
        ) : (
          <Badge variant="outline">{ticket.jiraKey}</Badge>
        ))}
      <Badge variant="outline" className="max-w-56 truncate" title={ticket.branch ?? 'Detached: the named branch is created at the first file edit'}>
        {ticket.project.name} &middot; {ticket.branch ?? 'no branch yet'}
      </Badge>
      {session && <Badge variant="outline">{session.mode === 'chat' ? 'Chat mode' : 'Terminal mode'}</Badge>}
      {ghInstalled === false && ticket.currentStage?.key === 'raise_pr' && (
        <Badge variant="destructive">gh not found: install it and run `gh auth login`</Badge>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {session &&
          (session.mode === 'terminal' ? (
            <Button size="xs" variant="outline" disabled={starting} onClick={() => onStart('chat')}>
              <MessageSquare /> Chat mode
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={starting} onClick={() => onStart('terminal')}>
              <TerminalSquare /> Terminal mode
            </Button>
          ))}
        {session && (
          <Button size="xs" variant="ghost" disabled={stopping} onClick={onStop}>
            <Square /> Stop
          </Button>
        )}
        <HistorySheet ticketId={ticket.id} />
        <Button
          size="icon-xs"
          variant={panelOpen ? 'secondary' : 'ghost'}
          onClick={onTogglePanel}
          aria-pressed={panelOpen}
          aria-label="Toggle the changes and file panel"
          title="Changes and files (read-only)"
        >
          <PanelRight />
        </Button>
        <StagePopover ticket={ticket} onOpenArtifact={onOpenArtifact} trigger={<StagePill stages={ticket.stages} />} />
      </div>
    </div>
  );

  if (!session) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <MessageSquare className="size-8 text-muted-foreground" />
          <div className="space-y-1">
            <h2 className="text-base font-semibold">
              {!ticket.isOwner ? 'This chat belongs to someone else' : ticket.started ? 'Resume this chat' : 'Start this chat'}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {ticket.status === 'DONE'
                ? 'Every stage of this chat is finished.'
                : !ticket.isOwner
                  ? `${ticket.owner.name} started it, so only they can run it. The conversation lives on their computer; you can see where it stands in the stage popover and the history.`
                  : ticket.started
                    ? 'Your Claude conversation for this chat continues where you left off.'
                    : `Creates a worktree detached at ${ticket.project.baseBranch} and starts Claude in it. The named branch is created at the first file edit.`}
            </p>
          </div>
          {startError !== null && startError !== undefined && (
            <Alert variant="destructive" className="max-w-md text-left">
              <AlertDescription>
                <p>{errorMessage(startError)}</p>
                {startErr?.guidance && <p className="mt-1">{startErr.guidance}</p>}
              </AlertDescription>
            </Alert>
          )}
          {ticket.isOwner && ticket.status === 'ACTIVE' && (
            <Button disabled={!localReady || starting} onClick={() => onStart()}>
              {starting ? <Loader2 className="animate-spin" /> : <Play />}
              {ticket.started ? 'Resume' : 'Start'}
            </Button>
          )}
          {!localReady && ticket.isOwner && <p className="text-xs text-muted-foreground">Shipline Local must be running and ready first.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1">
        {session.mode === 'chat' ? (
          <ChatView
            ticketId={ticket.id}
            ticket={ticket}
            stream={stream}
            worktreePath={session.worktreePath}
            localReady={localReady}
            onOpenAsset={onOpenAsset}
            onOpenChanges={onOpenChanges}
            onOpenArtifact={onOpenArtifact}
            onSwitchToTerminal={() => onStart('terminal')}
          />
        ) : (
          <TerminalView ticketId={ticket.id} stream={stream} />
        )}
      </div>
    </div>
  );
}
