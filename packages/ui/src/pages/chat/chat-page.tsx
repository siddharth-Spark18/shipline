import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { PanelRightCloseIcon, PanelRightOpenIcon, SquareIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChatTasksPanel } from '@/components/task-panel';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { useMediaQuery, usePrompts, useTasks } from '@/lib/queries';
import { sameStage } from '@/lib/stages';
import type {
  ChatSummary,
  ChatsResponse,
  ImageData,
  PromptEvent,
  Task,
  VersionState,
} from '@/lib/types';
import { chatStore, useChatLive } from '@/pages/chat/chat-store';
import { ChatControls } from '@/pages/chat/chat-controls';
import { Composer } from '@/pages/chat/composer';
import { MessageList } from '@/pages/chat/message-list';
import {
  ClaudeMissingNotice,
  FatalNotice,
  LockHeldNotice,
  OrphansNotice,
  ResultLine,
  ResumeCommand,
  TicketNotice,
} from '@/pages/chat/notices';
import { mergeHistory, normalizeHistory } from '@/pages/chat/timeline';

/** Why the chat can't be started or continued right now. Cleared by the next success. */
interface Blocker {
  code: string;
  message: string;
  heldBy?: unknown;
}

const NOTE_KEY = 'shipline.chat.terminalNote';

const normDir = (p: string) => p.replace(/\/+$/, '');

/**
 * GET /api/chats/<id>: the history, the ticket notice's data and the chat's tasks. Shared by the page (right
 * panel) and the open chat; they use one query. Refetched on `tasks` and chat `task` events (see lib/events.ts).
 */
function useChatDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.chat(id ?? ''),
    // History from Claude's session file overlaps what this page already streamed. The overlap
    // is removed when the two are merged (by tool id / text), not by trimming live items:
    // the session file keeps growing during a turn, so a count taken before the fetch is wrong.
    queryFn: () => api.chat(id as string),
    enabled: id !== null,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
}

/** The first stage not done or skipped: what the task is at (the one in progress, else the first pending). */
function currentStageOf(task: Task | undefined) {
  return (
    task?.stages.find((s) => s.status === 'in_progress') ??
    task?.stages.find((s) => s.status === 'pending')
  );
}

/** Unfinished tasks that no active chat is working on, each with a Resume button (new-chat screen). */
function UnfinishedTasks({ tasks, onResume }: { tasks: Task[]; onResume: (task: Task) => void }) {
  if (tasks.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Unfinished tasks</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {tasks.map((t) => (
            <li key={t.dir} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.title || t.slug}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.workflow}
                  {' · next: '}
                  {currentStageOf(t)?.name ?? 'nothing'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => onResume(t)}>
                Resume
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Said once: terminal and extension sessions are not locked out. */
function TerminalNote() {
  const [hidden, setHidden] = useState(() => localStorage.getItem(NOTE_KEY) === '1');
  if (hidden) return null;
  return (
    <div className="rounded-md border p-2 text-xs text-muted-foreground">
      Chats started in a terminal or an IDE are not listed here, and are not blocked while a chat is
      active.{' '}
      <button
        type="button"
        className="underline"
        onClick={() => {
          localStorage.setItem(NOTE_KEY, '1');
          setHidden(true);
        }}
      >
        Got it
      </button>
    </div>
  );
}

/** Shown in place of the chat for a repo that hasn't been upgraded: the old hooks write state the chat can't read. */
export default function ChatPage({
  versionState,
  versionMessage = null,
  chats,
  selectedId,
  onSelect,
}: {
  versionState?: VersionState;
  /** The pre-1.0 guidance from /api/status, shown instead of the generic text. */
  versionMessage?: string | null;
  chats: UseQueryResult<ChatsResponse>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const prompts = usePrompts();
  const tasks = useTasks();
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const readOnly = versionState === 'repo-newer' || versionState === 'pre-1.0';
  // The task panel needs room: from 1200px it sits beside the chat, below that it is an overlay sheet.
  const wide = useMediaQuery('(min-width: 1200px)');
  // Per chat: 'closed' / 'open' once the user has used the toggle. Without a choice the panel
  // follows the task: it opens when the chat has one, and stays closed otherwise.
  const [panelPref, setPanelPref] = useState<Record<string, 'open' | 'closed'>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const detail = useChatDetail(selectedId);

  const list = chats.data?.chats ?? [];
  const select = onSelect;

  /** Maps an API error to UI state. Returns nothing; callers keep their own text on failure. */
  const handleError = (e: unknown) => {
    if (!(e instanceof ApiError)) {
      toast.error('Something went wrong.');
      return;
    }
    const details = (e.details ?? {}) as { chatId?: string; heldBy?: unknown };
    switch (e.code) {
      case 'chat-active':
        if (details.chatId) {
          toast.info('A chat is already active here. Switched to it.');
          select(details.chatId);
        } else toast.error(e.message);
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
        break;
      case 'lock-held':
      case 'claude-missing':
      case 'claude-too-old':
      case 'claude-signed-out':
      case 'repo-newer':
      case 'pre-1.0':
        setBlocker({ code: e.code, message: e.message, heldBy: details.heldBy });
        break;
      default:
        toast.error(e.message);
    }
  };

  const startChat = async (text: string, images: ImageData[]): Promise<boolean> => {
    try {
      const { id } = await api.createChat(text, images);
      chatStore.addUser(id, text, true, images);
      setBlocker(null);
      select(id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      return true;
    } catch (e) {
      handleError(e);
      return false;
    }
  };

  const selected = list.find((c) => c.id === selectedId) ?? null;
  const chatInfo = detail.data?.chat ?? selected;
  const chatTasks = detail.data?.tasks ?? [];
  const changes = tasks.data?.changes ?? [];
  const hasTask = chatTasks.length > 0 || Boolean(chatInfo?.task_dir);
  // Unfinished tasks that are not the current task of an active chat: offered with Resume on the new-chat screen.
  const busyDirs = new Set(
    list
      .filter((c) => c.status === 'active' && c.task_dir)
      .map((c) => normDir(c.task_dir as string)),
  );
  const resumable = (tasks.data?.tasks ?? []).filter((t) => !busyDirs.has(normDir(t.dir)));
  const panel = (
    <ChatTasksPanel tasks={chatTasks} currentDir={chatInfo?.task_dir} changes={changes} />
  );
  const prefKey = selectedId ?? '';
  const panelOpen = (panelPref[prefKey] ?? (hasTask ? 'open' : 'closed')) === 'open';
  const sideOpen = wide && panelOpen;
  const togglePanel = () => {
    if (wide) setPanelPref((p) => ({ ...p, [prefKey]: panelOpen ? 'closed' : 'open' }));
    else setSheetOpen((o) => !o);
  };

  const stream = (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-[760px] min-w-0 flex-col gap-3 p-4">
      <TerminalNote />
      {chats.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load chats</AlertTitle>
          <AlertDescription>{chats.error.message}</AlertDescription>
        </Alert>
      )}
      {readOnly && (
        <Alert variant="destructive">
          <AlertTitle>Chat is disabled</AlertTitle>
          <AlertDescription>
            {versionState === 'pre-1.0' && versionMessage
              ? versionMessage
              : "This repo was set up with a newer Shipline, so chats can't be started or continued here."}
          </AlertDescription>
        </Alert>
      )}
      {blocker?.code === 'lock-held' && (
        <LockHeldNotice heldBy={blocker.heldBy} message={blocker.message} />
      )}
      {(blocker?.code === 'repo-newer' || blocker?.code === 'pre-1.0') && (
        <Alert variant="destructive">
          <AlertTitle>Chat is disabled</AlertTitle>
          <AlertDescription>{blocker.message}</AlertDescription>
        </Alert>
      )}

      {selectedId ? (
        <ChatView
          key={selectedId}
          id={selectedId}
          summary={selected}
          prompts={prompts.filter((p) => p.chatId === selectedId)}
          readOnly={readOnly}
          blocker={blocker}
          panelOpen={wide ? panelOpen : sheetOpen}
          onTogglePanel={togglePanel}
          onNewChat={() => select(null)}
          onError={handleError}
          onOk={() => setBlocker(null)}
        />
      ) : blocker?.code.startsWith('claude-') ? (
        <ClaudeMissingNotice code={blocker.code} message={blocker.message} />
      ) : (
        <div className="flex flex-1 flex-col justify-end gap-3">
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
            <div>
              <h2 className="text-base font-medium">New chat</h2>
              <p className="text-sm text-muted-foreground">
                Describe the work. This runs your own installed <code>claude</code> in this
                checkout, with the repo's Shipline hooks.
              </p>
            </div>
            <UnfinishedTasks
              tasks={resumable}
              onResume={(t) => void startChat(`Resume the Shipline task ${t.slug}`, [])}
            />
          </div>
          <Composer
            disabled={readOnly}
            chatId={null}
            placeholder="Describe the work to start a chat"
            onSend={startChat}
          />
        </div>
      )}
    </section>
  );

  // One tree at every width: the chat column never remounts (so the draft survives a resize), only
  // the panel beside it changes. Beside the chat the panel slides in by animating the flex-grow of
  // the two resizable panels (see `.chat-split` in index.css); below 1200px it is a sheet instead.
  return (
    <div className="flex min-h-0 flex-1">
      <ResizablePanelGroup
        orientation="horizontal"
        className="chat-split min-h-0 flex-1"
        data-closed={sideOpen ? 'false' : 'true'}
      >
        <ResizablePanel defaultSize="66" minSize="40" className="min-h-0">
          {stream}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          defaultSize="34"
          minSize="280px"
          maxSize="50"
          className="min-h-0 bg-sidebar"
          style={{ overflow: 'hidden' }}
        >
          <div
            className="h-full min-w-[280px]"
            aria-hidden={!sideOpen}
            {...(sideOpen ? {} : { inert: '' })}
          >
            {wide && panel}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <Sheet open={!wide && sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md motion-reduce:!animate-none motion-reduce:!transition-none"
        >
          <SheetHeader>
            <SheetTitle>Task panel</SheetTitle>
            <SheetDescription>
              The tasks in this chat, and the working tree changes.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">{panel}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ChatView({
  id,
  summary,
  prompts,
  readOnly,
  blocker,
  panelOpen,
  onTogglePanel,
  onNewChat,
  onError,
  onOk,
}: {
  id: string;
  summary: ChatSummary | null;
  prompts: PromptEvent[];
  readOnly: boolean;
  blocker: Blocker | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onNewChat: () => void;
  onError: (e: unknown) => void;
  onOk: () => void;
}) {
  const queryClient = useQueryClient();
  const live = useChatLive(id);
  const detail = useChatDetail(id);

  const chat = detail.data?.chat ?? summary;
  const history = useMemo(() => normalizeHistory(detail.data?.history), [detail.data]);
  const items = useMemo(() => mergeHistory(history, live.items), [history, live.items]);

  const ended = live.ended ?? chat?.status === 'ended';
  const busy = live.busy ?? chat?.busy ?? false;
  // The ticket notice: the chat's current task is at the ticket stage (`jira` in tasks from before 0.10.0) and the
  // repo's tracker can't be used. `ticket` is null when there is nothing to report (for GitHub, only at that stage).
  const chatTask = detail.data?.tasks?.find(
    (t) => chat?.task_dir && normDir(t.dir) === normDir(chat.task_dir),
  );
  const currentStage = currentStageOf(chatTask);
  const ticket = detail.data?.ticket;
  const ticketProblem =
    currentStage && sameStage(currentStage.id, 'ticket') && ticket && ticket.status !== 'connected'
      ? ticket
      : null;
  const resumeCommand = live.fatal?.resumeCommand ?? `claude --resume ${id}`;
  const missing = blocker?.code.startsWith('claude-') ? blocker : null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(id) });
  };

  const send = async (text: string, images: ImageData[] = []): Promise<boolean> => {
    const itemId = chatStore.addUser(id, text, false, images);
    try {
      await api.sendMessage(id, text, images);
      onOk();
      return true;
    } catch (e) {
      chatStore.dropItem(id, itemId);
      // 409 busy means a turn is running that this page did not know about.
      chatStore.setBusy(id, e instanceof ApiError && e.code === 'busy');
      if (e instanceof ApiError && e.code === 'chat-ended') {
        refresh();
      }
      onError(e);
      return false;
    }
  };

  const stop = async () => {
    try {
      await api.stopChat(id);
      refresh();
    } catch (e) {
      onError(e);
    }
  };

  const [killing, setKilling] = useState(false);
  const killOrphans = async () => {
    setKilling(true);
    try {
      await api.killChat(id);
      chatStore.clearOrphans(id);
    } catch (e) {
      // 404: nothing was left (they ended on their own), so the notice can go either way.
      if (e instanceof ApiError && e.status === 404) chatStore.clearOrphans(id);
      else onError(e);
    } finally {
      setKilling(false);
    }
  };

  const resume = async () => {
    try {
      await api.continueChat(id);
      chatStore.resumed(id);
      onOk();
      refresh();
    } catch (e) {
      onError(e);
    }
  };

  if (detail.error && !chat) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not open this chat</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-medium">{chat?.title || 'Chat'}</h2>
        <Badge variant={ended ? 'secondary' : 'default'}>{ended ? 'Ended' : 'Active'}</Badge>
        {!ended && (
          <Button variant="outline" size="xs" onClick={() => void stop()}>
            <SquareIcon />
            Stop
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={panelOpen ? 'Close task panel' : 'Open task panel'}
          aria-pressed={panelOpen}
          title={panelOpen ? 'Close task panel' : 'Open task panel'}
          onClick={onTogglePanel}
        >
          {panelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
        </Button>
      </div>

      {detail.data?.unavailable && (
        <p className="text-xs text-muted-foreground">
          History unavailable for this Claude version; you can still continue the chat.
        </p>
      )}

      <MessageList
        items={items}
        prompts={prompts}
        chatId={id}
        busy={busy}
        ended={Boolean(ended)}
        onSendToClaude={(text) => send(text)}
      />

      {live.fatal && <FatalNotice chatId={id} fatal={live.fatal} onNewChat={onNewChat} />}
      {live.orphans && <OrphansNotice onKill={() => void killOrphans()} killing={killing} />}
      {live.result && <ResultLine result={live.result} />}
      {ticketProblem && !ended && ticketProblem.status !== 'connected' && (
        <TicketNotice tracker={ticketProblem.tracker} status={ticketProblem.status} />
      )}

      {missing ? (
        <ClaudeMissingNotice code={missing.code} message={missing.message} />
      ) : ended ? (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm">
            This chat has ended and is read-only.
            {live.fatal?.reason === 'resume-failed'
              ? ''
              : ' You can continue it here or in a terminal.'}
          </p>
          {!live.fatal && <ResumeCommand command={resumeCommand} />}
          {live.fatal?.reason !== 'resume-failed' && (
            <ChatControls chatId={id} ended disabled={readOnly} />
          )}
          {live.fatal?.reason !== 'resume-failed' && (
            <div>
              <Button size="sm" disabled={readOnly} onClick={() => void resume()}>
                Continue
              </Button>
            </div>
          )}
        </div>
      ) : (
        <Composer
          disabled={readOnly}
          busy={busy}
          chatId={id}
          onShellError={(e) => {
            if (e instanceof ApiError && e.code === 'chat-ended') refresh();
            onError(e);
          }}
          hint={
            busy
              ? 'Claude is working. You can send the next message when this turn finishes.'
              : undefined
          }
          onSend={send}
        />
      )}
    </>
  );
}
