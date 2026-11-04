import { Link, useLocation } from 'react-router-dom';
import { ChevronsUpDown, FolderKanban, LogOut, MessagesSquare, Moon, Rocket, Settings, ShieldCheck, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAuth } from '@/contexts/auth-context';
import { useChatStates } from '@/pages/ticket-workspace/components/chat-list/use-chat-states';

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

// OPEN-QUESTION: "Projects" is the browse page (/projects: chats per project, read-only for non-owners)
// and "Admin" (/admin, global admins only) holds project registration and the Jira connection; the plan
// lists both modules without saying which page holds what.
/**
 * Far-left module sidebar (shadcn Sidebar, collapsible to icons): Chats, Projects, Admin, Settings.
 * The chat list itself lives next to the open chat, not here.
 */
export default function AppSidebar() {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const { isMobile } = useSidebar();
  const { resolvedTheme, setTheme } = useTheme();
  const { waiting } = useChatStates();

  const modules = [
    { to: '/', label: 'Chats', icon: MessagesSquare, active: pathname === '/' || pathname.startsWith('/chats'), badge: waiting },
    { to: '/projects', label: 'Projects', icon: FolderKanban, active: pathname.startsWith('/projects'), badge: 0 },
    ...(user?.isAdmin ? [{ to: '/admin', label: 'Admin', icon: ShieldCheck, active: pathname.startsWith('/admin'), badge: 0 }] : []),
    { to: '/settings', label: 'Settings', icon: Settings, active: pathname.startsWith('/settings'), badge: 0 },
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-1">
            <SidebarMenuButton size="lg" asChild className="group-data-[collapsible=icon]:hidden">
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Rocket className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Shipline</span>
                </div>
              </Link>
            </SidebarMenuButton>
            <SidebarTrigger className="shrink-0" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {modules.map((i) => (
                <SidebarMenuItem key={i.to}>
                  <SidebarMenuButton asChild isActive={i.active} tooltip={i.label}>
                    <Link to={i.to}>
                      <i.icon />
                      <span>{i.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  {i.badge > 0 && <SidebarMenuBadge>{i.badge}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg">{initials(user?.name ?? '?')}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user?.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-56 rounded-lg" side={isMobile ? 'bottom' : 'right'} align="end" sideOffset={4}>
                <DropdownMenuLabel className="font-normal">
                  <p className="text-sm font-medium">{user?.name}</p>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
                  {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
                  {resolvedTheme === 'dark' ? 'Light theme' : 'Dark theme'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void logout()}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
