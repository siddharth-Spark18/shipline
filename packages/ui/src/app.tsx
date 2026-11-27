import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AppSidebar, type NavItem } from '@/components/app-sidebar';
import { Banners, HealthCard, useBanners } from '@/components/banners';
import { MobileChatList } from '@/components/mobile-chat-list';
import { MobileTabBar, type MobileTab } from '@/components/mobile-tab-bar';
import { ProjectPicker } from '@/components/project-picker';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVisualViewport } from '@/hooks/use-visual-viewport';
import { api, setCurrentRepo } from '@/lib/api';
import { startChatSync } from '@/lib/chat-sync';
import { connectEvents, queryKeys } from '@/lib/events';
import { useChatNotifications, useTitleBadge } from '@/lib/notifications';
import { usePalette } from '@/lib/palette';
import { useAccessIssue, useAllChats, useHealth, useProjects } from '@/lib/queries';
import {
  ALL_HASH,
  CHATS_HASH,
  HEALTH_HASH,
  NEW_HASH,
  chatHash,
  draftHash,
  lastRepo,
  newHash,
  parseHash,
  rememberRepo,
  setupHash,
  type Route,
  type SetupSub,
} from '@/lib/routes';
import type { ChatListItem, HealthDot, Project } from '@/lib/types';
import { useChatRepo } from '@/lib/use-chat-selection';
import SetupPage from '@/pages/setup/setup-page';
import ChatPage from '@/pages/chat/chat-page';
import { HealthPage } from '@/pages/health/health-page';
import { InstallWizard } from '@/pages/install/install-wizard';
import { OverviewPage } from '@/pages/overview/overview-page';
import NotPaired from '@/pages/pair/not-paired';
import PairPage from '@/pages/pair/pair-page';

/** /pair is the phone's pairing screen (it has no cookie yet); everything else is the app. */
export default function App() {
  if (window.location.pathname === '/pair') return <PairPage />;
  return <MainApp />;
}

/** The header title of a Setup page. */
const SETUP_TITLES: Record<SetupSub['page'], string> = {
  hub: 'Setup',
  workflows: 'Setup: Workflows',
  workflow: 'Setup: Workflow',
  stage: 'Setup: Stage',
  guardrails: 'Setup: Guardrails',
  agents: 'Setup: Agents & skills',
  ci: 'Setup: CI check',
  phone: 'Setup: Phone access',
  config: 'Setup: Project config',
};

const TITLES: Record<Route['kind'], string> = {
  chat: 'Chat',
  chats: 'Chats',
  new: 'New chat',
  all: 'All projects',
  setup: 'Setup',
  health: 'Health',
  legacy: 'Shipline',
};

interface Redirect {
  to: string;
  /** Said once after the redirect: the address named something that doesn't exist. */
  message?: string;
}

/**
 * Where an address that names nothing usable goes. Old hashes (#chat, #setup, #chats, #/r/<id>/...) go to the chat
 * (`#/chat/<id>`), to Setup (`#/setup/<id>`) or to All projects; an empty hash lands on the new-chat screen on a laptop
 * and on All projects on a phone; an unknown project goes to All projects with a toast.
 */
function redirectFor(
  route: Route,
  rawHash: string,
  projects: Project[],
  mobile: boolean,
): Redirect | null {
  const known = (id: string | null) => (id && projects.some((p) => p.id === id) ? id : null);
  const stateOf = (id: string) => projects.find((p) => p.id === id)?.state;
  switch (route.kind) {
    case 'legacy': {
      if (route.view === 'chat' && route.chatId) return { to: chatHash(route.chatId) };
      if (route.view === 'setup') {
        const id = known(route.repoId) ?? known(lastRepo());
        return { to: id ? setupHash(id) : ALL_HASH };
      }
      if (route.view === null && route.repoId === null && rawHash.replace(/^#\/?/, '') === '')
        return { to: mobile ? ALL_HASH : NEW_HASH };
      return { to: ALL_HASH };
    }
    case 'setup':
      return known(route.repoId)
        ? null
        : { to: ALL_HASH, message: 'That project is not in the list.' };
    case 'new':
      if (!route.repoId) return null;
      if (!known(route.repoId))
        return { to: ALL_HASH, message: 'That project is not in the list.' };
      // A project that can't be served has nothing to chat in: its Setup page says why.
      return stateOf(route.repoId) === 'ok' ? null : { to: setupHash(route.repoId) };
    default:
      return null;
  }
}

/** The worst dot across projects. */
function worstDot(dots: HealthDot[]): HealthDot {
  if (dots.includes('red')) return 'red';
  if (dots.includes('amber')) return 'amber';
  return 'green';
}

/** Everything the views share. */
interface Nav {
  projects: Project[];
  navigate: (hash: string) => void;
  /** After a project was removed from the list: leave it if it was on screen. */
  removed: (id: string) => void;
}

function MainApp() {
  const queryClient = useQueryClient();
  const issue = useAccessIssue();
  const isMobile = useIsMobile();
  const projectsQuery = useProjects();
  const allChats = useAllChats();
  const health = useHealth();
  usePalette(!issue);
  const [hash, setHash] = useState(() => window.location.hash);
  // Projects seen "Not set up" in this session keep showing the wizard after Install (its last step), until a reload.
  const installSeen = useRef(new Set<string>());

  // One SSE connection for the whole app, for every repo; events land in the query cache by their repoId.
  useEffect(() => (issue ? undefined : connectEvents(queryClient)), [queryClient, issue]);
  // Chat logs catch up by version after a missed stretch (an SSE reconnect, a skipped version).
  useEffect(() => (issue ? undefined : startChatSync(queryClient)), [queryClient, issue]);
  // What needs you: browser notifications, and the tab title's `(n)` while chats wait.
  useChatNotifications(!issue);
  useTitleBadge(allChats.data?.filter((c) => c.waiting).length ?? 0);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const projects = projectsQuery.data ?? [];
  const route = parseHash(hash);
  const chatRepo = useChatRepo(route.kind === 'chat' ? route.chatId : null);

  let redirect = projectsQuery.data ? redirectFor(route, hash, projects, isMobile) : null;
  // A chat no project has, or one of a project that is gone.
  if (
    !redirect &&
    route.kind === 'chat' &&
    projectsQuery.data &&
    (chatRepo.unknown || (chatRepo.repoId && !projects.some((p) => p.id === chatRepo.repoId)))
  )
    redirect = { to: ALL_HASH, message: 'That chat was not found.' };
  const redirectTo = redirect?.to ?? null;
  const redirectMessage = redirect?.message;

  useEffect(() => {
    if (!redirectTo) return;
    if (redirectMessage) toast.error(redirectMessage);
    window.location.replace(redirectTo);
  }, [redirectTo, redirectMessage]);

  // The project of the view on screen: per-repo API calls and query keys follow it (see lib/api.ts).
  const okProjects = projects.filter((p) => p.state === 'ok');
  const preset = (explicit: string | null): string | null => {
    if (explicit && okProjects.some((p) => p.id === explicit)) return explicit;
    const last = lastRepo();
    if (last && okProjects.some((p) => p.id === last)) return last;
    return okProjects[0]?.id ?? null;
  };
  let repoId: string | null = null;
  if (route.kind === 'chat') repoId = chatRepo.repoId;
  else if (route.kind === 'new') repoId = preset(route.repoId);
  else if (route.kind === 'setup') repoId = route.repoId;
  const current = repoId ? (projects.find((p) => p.id === repoId) ?? null) : null;
  // Only a served project (or one being set up) has routes to call: a missing, repo-newer or pre-1.0 one answers 410 or
  // 409, so nothing is requested for it.
  setCurrentRepo(
    current && (current.state === 'ok' || current.state === 'install') ? current.id : null,
  );

  const currentId = current?.id ?? null;
  useEffect(() => {
    // The last project used: the chat last opened, or the project picked in New chat or Setup.
    if (currentId) rememberRepo(currentId);
  }, [currentId]);

  // A phone the server refuses (not paired, phone access off, wrong Tailscale user, revoked).
  if (issue) return <NotPaired reason={issue} />;
  if (projectsQuery.isPending) return null;
  if (projectsQuery.error) {
    return <p className="p-4 text-sm text-destructive">{projectsQuery.error.message}</p>;
  }
  if (redirectTo) return null;

  const navigate = (next: string) => {
    if (window.location.hash !== next) window.location.hash = next;
    setHash(next);
  };
  const nav: Nav = {
    projects,
    navigate,
    removed: (id) => {
      if (id === currentId) navigate(ALL_HASH);
    },
  };

  const chats: ChatListItem[] = allChats.data ?? [];
  const waitingTotal = chats.filter((c) => c.waiting).length;
  const healthDot: HealthDot | null = health.data
    ? worstDot(health.data.projects.map((r) => r.dot))
    : null;
  // Setup's target: the last project used, else any project.
  const setupTarget = () => {
    const last = lastRepo();
    const id =
      (last && projects.some((p) => p.id === last) ? last : null) ?? currentId ?? projects[0]?.id;
    return id ? setupHash(id) : ALL_HASH;
  };
  const newTarget = () => newHash(preset(null));

  const sidebarActive: NavItem =
    route.kind === 'chat' ||
    route.kind === 'new' ||
    route.kind === 'all' ||
    route.kind === 'setup' ||
    route.kind === 'health'
      ? route.kind
      : 'all';
  const selectedChatId = route.kind === 'chat' ? route.chatId : null;

  let content: ReactNode;
  switch (route.kind) {
    case 'all':
      content = (
        <Scroll>
          <OverviewPage
            onOpenChat={(id) => navigate(chatHash(id))}
            onNewChat={(id) => navigate(newHash(id))}
            onSetup={(id) => navigate(setupHash(id))}
            onOpenHealth={() => navigate(HEALTH_HASH)}
          />
        </Scroll>
      );
      break;
    case 'health':
      content = (
        <Scroll>
          <HealthPage />
        </Scroll>
      );
      break;
    case 'chats':
      content = (
        <MobileChatList
          chats={chats}
          projects={projects}
          selectedId={null}
          onSelectChat={(id) => navigate(chatHash(id))}
          onNewChat={() => navigate(newTarget())}
        />
      );
      break;
    case 'setup': {
      if (!current) {
        content = null;
        break;
      }
      if (current.state === 'install') installSeen.current.add(current.id);
      content = (
        <Scroll>
          <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
            <ProjectPicker
              projects={projects}
              value={current.id}
              onChange={(id) => {
                rememberRepo(id);
                navigate(setupHash(id));
              }}
            />
            {installSeen.current.has(current.id) ? (
              <InstallWizard key={current.id} />
            ) : current.state === 'ok' ? (
              <RepoScope key={current.id} nav={nav} withBanners>
                {(status) => (
                  <SetupPage
                    repoId={current.id}
                    sub={route.kind === 'setup' ? route.sub : { page: 'hub' }}
                    navigate={navigate}
                    versionState={status?.versionState}
                    versionMessage={status?.versionMessage ?? null}
                    onChatStarted={(id) => navigate(chatHash(id))}
                    draftId={route.kind === 'setup' ? route.draftId : null}
                    onOpenDraft={(workflowId) => navigate(draftHash(current.id, workflowId))}
                    onCloseDraft={() => navigate(setupHash(current.id))}
                  />
                )}
              </RepoScope>
            ) : (
              <StateCard project={current} nav={nav} />
            )}
          </div>
        </Scroll>
      );
      break;
    }
    case 'new':
    case 'chat': {
      if (route.kind === 'chat' && !current) {
        content = null; // The chat's project is being looked up.
        break;
      }
      if (!current) {
        content = (
          <Scroll>
            <p className="p-4 text-sm text-muted-foreground">
              No project is set up for chats yet. Open Setup to set one up, or All projects to see
              them.
            </p>
          </Scroll>
        );
        break;
      }
      if (current.state !== 'ok') {
        content = (
          <Scroll>
            <StateCard project={current} nav={nav} />
          </Scroll>
        );
        break;
      }
      content = (
        <RepoScope key={current.id} nav={nav} withBanners>
          {(status, chatsQuery) => (
            <ChatPage
              versionState={status?.versionState}
              versionMessage={status?.versionMessage ?? null}
              chats={chatsQuery}
              selectedId={route.kind === 'chat' ? route.chatId : null}
              onSelect={(id) => navigate(id ? chatHash(id) : newHash(current.id))}
              onBack={() => navigate(CHATS_HASH)}
              project={current}
              onOpenProject={(id) => navigate(setupHash(id))}
              newChatTop={
                route.kind === 'new' ? (
                  <ProjectPicker
                    projects={projects}
                    value={current.id}
                    onlyOk
                    onChange={(id) => {
                      rememberRepo(id);
                      navigate(newHash(id));
                    }}
                  />
                ) : undefined
              }
            />
          )}
        </RepoScope>
      );
      break;
    }
    default:
      content = null;
  }

  if (isMobile) {
    const tab: MobileTab | null =
      route.kind === 'all'
        ? 'all'
        : route.kind === 'chats' || route.kind === 'chat'
          ? 'chats'
          : route.kind === 'new'
            ? 'new'
            : route.kind === 'setup'
              ? 'setup'
              : route.kind === 'health'
                ? 'health'
                : null;
    return (
      <MobileShell
        tab={tab}
        waitingTotal={waitingTotal}
        healthDot={healthDot}
        onSelect={(t) =>
          navigate(
            t === 'all'
              ? ALL_HASH
              : t === 'chats'
                ? CHATS_HASH
                : t === 'new'
                  ? newTarget()
                  : t === 'setup'
                    ? setupTarget()
                    : HEALTH_HASH,
          )
        }
      >
        {content}
      </MobileShell>
    );
  }

  return (
    <SidebarProvider className="h-svh">
      <AppSidebar
        active={sidebarActive}
        chats={chats}
        projects={projects}
        selectedChatId={selectedChatId}
        waitingTotal={waitingTotal}
        healthDot={healthDot}
        onNavigate={(t) =>
          navigate(
            typeof t === 'object'
              ? chatHash(t.chat)
              : t === 'new'
                ? newTarget()
                : t === 'all'
                  ? ALL_HASH
                  : t === 'setup'
                    ? setupTarget()
                    : HEALTH_HASH,
          )
        }
      />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <h1 className="text-sm font-semibold">
            {route.kind === 'setup' ? SETUP_TITLES[route.sub.page] : TITLES[route.kind]}
          </h1>
        </header>
        {content}
      </SidebarInset>
    </SidebarProvider>
  );
}

/** A page that scrolls inside the shell. */
function Scroll({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** The phone's layout: the view above, the tab bar below, both above the on-screen keyboard (see useVisualViewport). */
function MobileShell({
  tab,
  waitingTotal,
  healthDot,
  onSelect,
  children,
}: {
  tab: MobileTab | null;
  waitingTotal: number;
  healthDot: HealthDot | null;
  onSelect: (tab: MobileTab) => void;
  children: ReactNode;
}) {
  const viewport = useVisualViewport();
  return (
    <div
      className="fixed inset-x-0 flex flex-col bg-background pt-[env(safe-area-inset-top)]"
      style={
        viewport.height === null
          ? { top: 0, bottom: 0 }
          : { top: viewport.offsetTop, height: viewport.height }
      }
    >
      {children}
      <MobileTabBar
        active={tab}
        waitingTotal={waitingTotal}
        healthDot={healthDot}
        hidden={viewport.keyboardOpen}
        onSelect={onSelect}
      />
    </div>
  );
}

/**
 * One served project's data: its status, banners and chat list. Keyed by the project, so a switch starts clean. The
 * banners sit above the page.
 */
function RepoScope({
  nav,
  withBanners,
  children,
}: {
  nav: Nav;
  withBanners?: boolean;
  children: (
    status: Awaited<ReturnType<typeof api.status>> | undefined,
    chats: ReturnType<typeof useRepoChats>,
  ) => ReactNode;
}) {
  const status = useQuery({ queryKey: queryKeys.status, queryFn: api.status });
  const banners = useBanners(status.data);
  const chats = useRepoChats();
  return (
    <>
      {withBanners && (
        <Banners
          banners={banners.visible}
          isDestructive={banners.isDestructive}
          onDismiss={banners.dismiss}
          onOpenHealth={() => nav.navigate(HEALTH_HASH)}
        />
      )}
      {children(status.data, chats)}
    </>
  );
}

/** The project on screen's own chat list (history, status), which the chat page reads beside the flat list. */
function useRepoChats() {
  return useQuery({ queryKey: queryKeys.chats, queryFn: api.chats });
}

/** A project that isn't served (needs reinstall, newer Shipline, folder gone): why, and what to do. */
function StateCard({ project, nav }: { project: Project; nav: Nav }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeProject(project.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChats });
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
      nav.removed(project.id);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove this project"),
  });
  return (
    <div className="mx-auto max-w-xl">
      <HealthCard
        health={{
          repoId: project.id,
          name: project.name,
          root: project.root,
          state: project.state,
          version: project.version,
          uiVersion: '',
          upgradeAvailable: false,
          setupDone: project.setupDone,
          message: project.message,
        }}
        onRemove={() => remove.mutate()}
      />
    </div>
  );
}
