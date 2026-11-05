import { useMemo } from 'react';
import {
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { StageDot, StageTrail } from '@/components/stage-dots';
import { findTask, usePrompts, useTasks } from '@/lib/queries';
import type { ChatSummary, Status } from '@/lib/types';

export type View = 'chat' | 'setup';

const NAV: { view: View; label: string; icon: typeof MessageSquareIcon }[] = [
  { view: 'chat', label: 'Chat', icon: MessageSquareIcon },
  { view: 'setup', label: 'Setup', icon: SettingsIcon },
];

const THEMES = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
] as const;

/** Active chats first, then the most recently active; the server already sends newest first. */
function sortChats(chats: ChatSummary[]): ChatSummary[] {
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
  view,
  onNavigate,
  chats,
  selectedId,
  onSelectChat,
  onNewChat,
  status,
  warnings,
  hasBlocker,
  onOpenDiagnostics,
}: {
  view: View;
  onNavigate: (view: View) => void;
  chats: ChatSummary[];
  selectedId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  status: Status | undefined;
  warnings: number;
  hasBlocker: boolean;
  onOpenDiagnostics: () => void;
}) {
  const tasks = useTasks();
  const prompts = usePrompts();
  const { isMobile, setOpenMobile } = useSidebar();
  const waiting = useMemo(() => new Set(prompts.map((p) => p.chatId)), [prompts]);
  const sorted = useMemo(() => sortChats(chats), [chats]);

  const repoName = status?.root
    ? (status.root.split(/[\\/]/).filter(Boolean).pop() ?? 'Shipline')
    : 'Shipline';
  // Close the mobile drawer after a navigation; no-op on desktop.
  const done = () => isMobile && setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="pointer-events-none"
              tooltip={status?.root ?? 'Shipline'}
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                S
              </div>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate font-semibold">{repoName}</span>
                <span className="truncate text-xs text-muted-foreground" title={status?.root}>
                  {status?.root ?? 'Shipline'}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New chat"
                className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                onClick={() => {
                  onNewChat();
                  done();
                }}
              >
                <PlusIcon />
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {NAV.map(({ view: v, label, icon: Icon }) => (
              <SidebarMenuItem key={v}>
                <SidebarMenuButton
                  tooltip={label}
                  isActive={view === v}
                  onClick={() => {
                    onNavigate(v);
                    done();
                  }}
                >
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        {sorted.length === 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <p className="px-2 text-xs text-muted-foreground">No chats yet.</p>
          </SidebarGroup>
        )}
        {sorted.length > 0 && (
          <SidebarGroup className="py-1 group-data-[collapsible=icon]:hidden">
            <SidebarMenu>
              {sorted.map((c) => {
                const active = c.status === 'active';
                const task = findTask(tasks.data?.tasks, c.task_dir);
                return (
                  <SidebarMenuItem key={c.id}>
                    <SidebarMenuButton
                      className="h-auto py-1.5"
                      isActive={view === 'chat' && c.id === selectedId}
                      onClick={() => {
                        onSelectChat(c.id);
                        done();
                      }}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <StageDot
                            status={active ? 'in_progress' : 'done'}
                            className="size-2 ring-2"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {c.title || 'Untitled chat'}
                          </span>
                          {waiting.has(c.id) && (
                            <Badge className="h-4 px-1.5 text-[10px]">Needs answer</Badge>
                          )}
                        </div>
                        {c.task_dir && (
                          <div className="flex min-w-0 items-center gap-2 pl-4 text-xs text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate">
                              {task ? task.title || task.slug : taskName(c.task_dir)}
                            </span>
                            {task && <StageTrail stages={task.stages} />}
                          </div>
                        )}
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              tooltip={
                warnings === 0
                  ? 'Status: all good'
                  : `Status: ${warnings} warning${warnings === 1 ? '' : 's'}`
              }
              onClick={onOpenDiagnostics}
            >
              <span
                className={cn(
                  'size-2.5 shrink-0 rounded-full',
                  warnings === 0 ? 'bg-stage-done' : hasBlocker ? 'bg-enf-block' : 'bg-enf-warn',
                )}
              />
              <span>
                Status:{' '}
                {warnings === 0 ? 'all good' : `${warnings} warning${warnings === 1 ? '' : 's'}`}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <ThemeMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
