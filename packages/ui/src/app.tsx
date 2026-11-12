import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar, type View } from '@/components/app-sidebar';
import { Banners, useBanners } from '@/components/banners';
import { MobileChatList } from '@/components/mobile-chat-list';
import { MobileTabBar, type MobileTab } from '@/components/mobile-tab-bar';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVisualViewport } from '@/hooks/use-visual-viewport';
import { api } from '@/lib/api';
import { connectEvents, queryKeys } from '@/lib/events';
import { useChatSelection } from '@/lib/use-chat-selection';
import SetupPage from '@/pages/setup/setup-page';
import ChatPage from '@/pages/chat/chat-page';
import { DiagnosticsSheet } from '@/pages/diagnostics';
import { InstallWizard } from '@/pages/install/install-wizard';
import NotPaired from '@/pages/pair/not-paired';
import PairPage from '@/pages/pair/pair-page';
import { useAccessIssue, usePrompts } from '@/lib/queries';

/** `chats` is the phone's Chats tab (the chat list); the desktop has the sidebar for that and shows the chat. */
type AppView = View | 'chats';

const VIEWS = ['setup', 'chat', 'chats'] as const;

const TITLES: Record<View, string> = { chat: 'Chat', setup: 'Setup' };

function viewFromHash(): AppView {
  const h = window.location.hash.replace('#', '');
  if ((VIEWS as readonly string[]).includes(h)) return h as AppView;
  // A phone opens on its chat list.
  return window.innerWidth < 768 ? 'chats' : 'chat';
}

/** /pair is the phone's pairing screen (it has no cookie yet); everything else is the app. */
export default function App() {
  if (window.location.pathname === '/pair') return <PairPage />;
  return <MainApp />;
}

/** Install mode (no repo installed yet) shows only the setup wizard; everything else needs an installed repo. */
function MainApp() {
  const issue = useAccessIssue();
  const status = useQuery({ queryKey: queryKeys.status, queryFn: api.status });
  // A phone the server refuses (not paired, phone access off, wrong Tailscale user, revoked).
  if (issue) return <NotPaired reason={issue} />;
  if (status.isPending) return null;
  if (status.data?.mode === 'install') return <InstallWizard />;
  return <RepoApp />;
}

function RepoApp() {
  const queryClient = useQueryClient();
  const [appView, setView] = useState<AppView>(viewFromHash);
  const isMobile = useIsMobile();
  const viewport = useVisualViewport();
  const prompts = usePrompts();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  // One SSE connection for the whole app; events land in the query cache.
  useEffect(() => connectEvents(queryClient), [queryClient]);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const status = useQuery({ queryKey: queryKeys.status, queryFn: api.status });
  const banners = useBanners(status.data);
  const { chats, selectedId, select } = useChatSelection();

  const navigate = (next: AppView) => {
    window.location.hash = next;
    setView(next);
  };
  const view: View = appView === 'setup' ? 'setup' : 'chat';
  const openDiagnostics = () => setDiagnosticsOpen(true);

  if (isMobile) {
    const waitingChats = new Set(prompts.map((p) => p.chatId)).size;
    const tab: MobileTab | null =
      appView === 'setup' ? 'setup' : appView === 'chat' && !selectedId ? 'new' : 'chats';
    const openChat = (id: string) => {
      select(id);
      navigate('chat');
    };
    const newChat = () => {
      select(null);
      navigate('chat');
    };
    return (
      // Fills the visible area: above the keyboard while it is open (see useVisualViewport).
      <div
        className="fixed inset-x-0 flex flex-col bg-background pt-[env(safe-area-inset-top)]"
        style={{ top: viewport.offsetTop, bottom: viewport.bottomInset }}
      >
        <Banners
          banners={banners.visible}
          isDestructive={banners.isDestructive}
          onDismiss={banners.dismiss}
          onOpenDiagnostics={openDiagnostics}
        />
        {appView === 'chat' ? (
          <ChatPage
            versionState={status.data?.versionState}
            versionMessage={status.data?.versionMessage ?? null}
            chats={chats}
            selectedId={selectedId}
            onSelect={select}
            onBack={() => navigate('chats')}
          />
        ) : appView === 'setup' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <h1 className="px-4 pt-3 text-base font-semibold">Setup</h1>
            <div className="p-4 pt-2">
              <SetupPage
                versionState={status.data?.versionState}
                onChatStarted={openChat}
                warnings={banners.all.length}
                hasBlocker={banners.all.some(banners.isDestructive)}
                onOpenDiagnostics={openDiagnostics}
              />
            </div>
          </div>
        ) : (
          <>
            <h1 className="shrink-0 border-b px-4 py-3 text-base font-semibold">Chats</h1>
            <MobileChatList
              chats={chats.data?.chats ?? []}
              selectedId={selectedId}
              onSelectChat={openChat}
              onNewChat={newChat}
            />
          </>
        )}
        <MobileTabBar
          active={tab}
          waitingChats={waitingChats}
          hidden={viewport.keyboardOpen}
          onSelect={(t) => (t === 'new' ? newChat() : navigate(t))}
        />
        <DiagnosticsSheet open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} />
      </div>
    );
  }

  return (
    <SidebarProvider className="h-svh">
      <AppSidebar
        view={view}
        onNavigate={navigate}
        chats={chats.data?.chats ?? []}
        selectedId={selectedId}
        onSelectChat={(id) => {
          select(id);
          navigate('chat');
        }}
        onNewChat={() => {
          select(null);
          navigate('chat');
        }}
        status={status.data}
        warnings={banners.all.length}
        hasBlocker={banners.all.some(banners.isDestructive)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
      />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-semibold">{TITLES[view]}</h1>
        </header>
        <Banners
          banners={banners.visible}
          isDestructive={banners.isDestructive}
          onDismiss={banners.dismiss}
          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        />
        {view === 'chat' ? (
          <ChatPage
            versionState={status.data?.versionState}
            versionMessage={status.data?.versionMessage ?? null}
            chats={chats}
            selectedId={selectedId}
            onSelect={select}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl p-4">
              <SetupPage
                versionState={status.data?.versionState}
                onChatStarted={(id) => {
                  select(id);
                  navigate('chat');
                }}
              />
            </div>
          </div>
        )}
      </SidebarInset>
      <DiagnosticsSheet open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} />
    </SidebarProvider>
  );
}
