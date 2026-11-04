import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyState from '@/components/shared/empty-state';
import LocalBanner from '@/components/local/local-banner';
import { errorMessage } from '@/lib/api';
import { useLocalReady, useLocalSessions, useStartSession, useStopSession } from '@/services/local/local.hooks';
import { useTicket } from '@/services/tickets/tickets.hooks';
import { ticketKeys } from '@/services/tickets/tickets.types';
import { useChatStates } from './components/chat-list/use-chat-states';
import CenterPanel from './components/center/center-panel';
import RightPanel, { RightPanelTab } from './components/right/right-panel';
import StatusBar from './components/status-bar/status-bar';
import { useArtifactOpener } from './hooks/use-artifact-opener';
import { useLiveDiffRefresh } from './hooks/use-live-diff-refresh';
import { useSessionStream } from './hooks/use-session-stream';
import { AssetRef } from './types';

/**
 * The chat workspace: a wide chat in the middle (the chat list sits beside it, in the Chats
 * layout), a read-only diff/file panel on the right that stays hidden until something opens it, and
 * the status bar along the bottom. Stages show on demand (header pill, status bar, completion card).
 */
export default function TicketWorkspacePage() {
  const { ticketId = '' } = useParams();
  // Everything below is per chat: remount on switch so no chat/asset state leaks across chats.
  return <Workspace key={ticketId} ticketId={ticketId} />;
}

interface PanelState {
  open: boolean;
  tab: RightPanelTab;
  /** A changed file to expand when the Changes tab opens. */
  focusPath?: string;
}

function Workspace({ ticketId }: { ticketId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const ticket = useTicket(ticketId, true);
  const local = useLocalReady();
  const sessions = useLocalSessions(local.ready);
  const start = useStartSession();
  const stop = useStopSession();
  const { waiting } = useChatStates();
  const session = sessions.data?.find((s) => s.ticketId === ticketId) ?? null;
  const stream = useSessionStream(ticketId, !!session && local.ready);
  useLiveDiffRefresh(ticketId, stream);

  const [panel, setPanel] = useState<PanelState>({ open: false, tab: 'changes' });
  const [asset, setAsset] = useState<AssetRef | null>(null);
  const openAsset = (a: AssetRef) => {
    setAsset(a);
    setPanel({ open: true, tab: 'asset' });
  };
  const openChanges = (focusPath?: string) => setPanel({ open: true, tab: 'changes', focusPath });
  const openArtifact = useArtifactOpener(openAsset);

  // The new-chat screen hands over the first message: it starts the session, and Claude gets the
  // message as its first turn. Kept in a ref so a failed start can be retried with the same text.
  const firstMessage = useRef<string | undefined>((location.state as { firstMessage?: string } | null)?.firstMessage);
  const autoStarted = useRef(false);
  const detail = ticket.data;

  const startSession = (mode?: 'chat' | 'terminal') =>
    start.mutate(
      { ticketId, mode, firstMessage: session ? undefined : firstMessage.current },
      {
        onSuccess: () => {
          if (firstMessage.current && !session) {
            firstMessage.current = undefined;
            navigate(location.pathname, { replace: true, state: null }); // a reload must not resend it
          }
          toast.success(mode === 'terminal' ? 'Terminal mode started' : 'Session started');
        },
      },
    );

  // OPEN-QUESTION: the first message is delivered together with the stage announcement as ONE Claude turn
  // (see session-manager announceStage), so Claude's first reply answers it and asks about Jira.
  // A fresh chat starts by itself with its first message; a chat started before (it has a Claude
  // conversation) resumes by itself once the local service is reachable again: restart the tray,
  // the banner clears and the session comes back.
  useEffect(() => {
    if (autoStarted.current || !local.ready || !sessions.isSuccess || session || !detail) return;
    if (!detail.isOwner || detail.status !== 'ACTIVE') return;
    if (firstMessage.current || detail.started) {
      autoStarted.current = true;
      startSession();
    }
  }, [local.ready, sessions.isSuccess, session, detail]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first file edit creates the named branch: refresh the header and status bar right away.
  const branchMessages = stream.messages.filter((m) => m.kind === 'branch').length;
  useEffect(() => {
    if (branchMessages > 0) void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
  }, [branchMessages, qc, ticketId]);

  if (ticket.isPending) return <WorkspaceSkeleton />;
  if (!detail) {
    return (
      <div className="p-6">
        <EmptyState message={ticket.error ? errorMessage(ticket.error) : 'Chat not found.'} />
      </div>
    );
  }

  const hasWorktree = !!session || !!detail.worktreePath;

  return (
    <div className="absolute inset-0 flex flex-col">
      <LocalBanner />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="chat" minSize="35%">
          <CenterPanel
            ticket={detail}
            session={session}
            stream={stream}
            localReady={local.ready}
            ghInstalled={local.status?.ghInstalled ?? null}
            starting={start.isPending}
            startError={start.error}
            onStart={startSession}
            onStop={() => stop.mutate(ticketId)}
            stopping={stop.isPending}
            onOpenAsset={openAsset}
            onOpenChanges={openChanges}
            onOpenArtifact={(stage) => void openArtifact(stage)}
            panelOpen={panel.open}
            onTogglePanel={() => setPanel((p) => ({ ...p, open: !p.open }))}
          />
        </ResizablePanel>
        {panel.open && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="viewer" defaultSize="42%" minSize="22%" maxSize="70%">
              <RightPanel
                ticketId={ticketId}
                tab={panel.tab}
                onTabChange={(tab) => setPanel((p) => ({ ...p, tab }))}
                focusPath={panel.focusPath}
                asset={asset}
                localReady={local.ready}
                hasWorktree={hasWorktree}
                onClose={() => setPanel((p) => ({ ...p, open: false }))}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <StatusBar
        projectName={detail.project.name}
        ticket={detail}
        sessionRunning={!!session}
        waiting={waiting}
        onOpenArtifact={(stage) => void openArtifact(stage)}
      />
    </div>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="absolute inset-0 flex gap-px">
      <Skeleton className="h-full flex-1 rounded-none" />
    </div>
  );
}
