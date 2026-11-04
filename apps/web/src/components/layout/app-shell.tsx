import { CSSProperties, ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import AppSidebar from './app-sidebar';

// The module sidebar is slim: icons only until expanded.
const SIDEBAR_STYLE = { '--sidebar-width': '12rem' } as CSSProperties;

/**
 * App shell: the far-left module sidebar and the area beside it. `children` fill the area: pages
 * that scroll wrap themselves in PageContainer; the Chats module fills it itself (chat list, chat
 * and status bar).
 */
export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen={false} style={SIDEBAR_STYLE}>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <div className="relative min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
