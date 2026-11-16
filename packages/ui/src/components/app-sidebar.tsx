import { useMemo } from 'react';
import {
  HeartPulseIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from 'cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { ChatRow, sortChats } from '@/components/chat-row';
import { Badge } from '@/components/ui/badge';
import type { ChatListItem, HealthDot, Project } from '@/lib/types';

/** The highlighted item: a chat (the list row is highlighted instead), or one of the four fixed items. */
export type NavItem = 'new' | 'all' | 'setup' | 'health' | 'chat';

/** The dot colour classes (the same ones the stage dots and banners use). */
export const DOT_CLASS: Record<HealthDot, string> = {
  green: 'bg-stage-done',
  amber: 'bg-enf-warn',
  red: 'bg-enf-block',
};
export const DOT_LABEL: Record<HealthDot, string> = {
  green: 'Healthy',
  amber: 'Needs a look',
  red: 'Needs attention',
};

export const THEMES = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
] as const;

function ThemeMenu() {
  const { theme = 'system', setTheme } = useTheme();
  const current = THEMES.find((t) => t.value === theme) ?? THEMES[0];
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton tooltip="Theme">
          <Icon />
          <span>Theme: {current.label}</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value}>
              <t.icon />
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar({
  active,
  chats,
  projects,
  selectedChatId,
  waitingTotal,
  healthDot,
  onNavigate,
}: {
  active: NavItem;
  /** The flat chat list across every project, newest first. */
  chats: ChatListItem[];
  projects: Project[];
  selectedChatId: string | null;
  /** Chats waiting for you, across all projects. */
  waitingTotal: number;
  /** The worst health state across projects, or null while it loads. */
  healthDot: HealthDot | null;
  onNavigate: (target: 'new' | 'all' | 'setup' | 'health' | { chat: string }) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const sorted = useMemo(() => sortChats(chats), [chats]);
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  // Chats of a project that is gone from the list (or not served) are not listed.
  const listed = useMemo(
    () => sorted.filter((c) => byId.get(c.repoId)?.state === 'ok'),
    [sorted, byId],
  );

  // Close the mobile drawer after a navigation; no-op on desktop.
  const go = (target: Parameters<typeof onNavigate>[0]) => {
    onNavigate(target);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New chat"
                className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                onClick={() => go('new')}
              >
                <PlusIcon />
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="All projects"
                isActive={active === 'all'}
                onClick={() => go('all')}
              >
                <LayoutDashboardIcon />
                <span>All projects</span>
                {waitingTotal > 0 && (
                  <Badge
                    className="ml-auto h-4 min-w-4 px-1.5 text-[10px] group-data-[collapsible=icon]:hidden"
                    aria-label={`${waitingTotal} waiting for you`}
                  >
                    {waitingTotal}
                  </Badge>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Setup"
                isActive={active === 'setup'}
                onClick={() => go('setup')}
              >
                <SettingsIcon />
                <span>Setup</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={healthDot ? `Health: ${DOT_LABEL[healthDot]}` : 'Health'}
                isActive={active === 'health'}
                onClick={() => go('health')}
              >
                <HeartPulseIcon />
                <span>Health</span>
                {healthDot && (
                  <span
                    role="img"
                    aria-label={DOT_LABEL[healthDot]}
                    className={cn(
                      'ml-auto size-2.5 shrink-0 rounded-full group-data-[collapsible=icon]:hidden',
                      DOT_CLASS[healthDot],
                    )}
                  />
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {listed.length === 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <p className="px-2 text-xs text-muted-foreground">No chats yet.</p>
          </SidebarGroup>
        )}
        {listed.length > 0 && (
          <SidebarGroup className="border-t py-1 group-data-[collapsible=icon]:hidden">
            <SidebarMenu>
              {listed.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton
                    className="h-auto py-1.5"
                    isActive={active === 'chat' && c.id === selectedChatId}
                    onClick={() => go({ chat: c.id })}
                  >
                    <ChatRow chat={c} project={byId.get(c.repoId)} />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
