import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppSidebar, type View } from '@/components/app-sidebar';
import { Banners, useBanners } from '@/components/banners';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { api } from '@/lib/api';
import { connectEvents, queryKeys } from '@/lib/events';
import { useChatSelection } from '@/lib/use-chat-selection';
import SetupPage from '@/pages/setup/setup-page';
import TasksPage from '@/pages/tasks/tasks-page';
import ChatPage from '@/pages/chat/chat-page';
import { DiagnosticsSheet } from '@/pages/diagnostics';

const VIEWS = ['setup', 'tasks', 'chat'] as const;

const TITLES: Record<View, string> = { chat: 'Chat', setup: 'Setup', tasks: 'Tasks' };

function viewFromHash(): View {
  const h = window.location.hash.replace('#', '');
  return (VIEWS as readonly string[]).includes(h) ? (h as View) : 'chat';
}

export default function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>(viewFromHash);
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

  const navigate = (next: View) => {
    window.location.hash = next;
    setView(next);
  };

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
            chats={chats}
            selectedId={selectedId}
            onSelect={select}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl p-4">
              {view === 'setup' ? (
                <SetupPage versionState={status.data?.versionState} />
              ) : (
                <TasksPage />
              )}
            </div>
          </div>
        )}
      </SidebarInset>
      <DiagnosticsSheet open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} />
    </SidebarProvider>
  );
}
