import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from '@/contexts/auth-context';
import AppShell from '@/components/layout/app-shell';
import ChatsLayout from '@/components/layout/chats-layout';
import PageContainer from '@/components/layout/page-container';
import PageLoading from '@/components/shared/page-loading';
import LoginPage from '@/pages/login/login-page';
import AuthCallbackPage from '@/pages/auth-callback/auth-callback-page';
import AdminPage from '@/pages/admin/admin-page';
import TemplateEditorPage from '@/pages/admin/templates/template-editor-page';
import HomePage from '@/pages/home/home-page';
import TicketWorkspacePage from '@/pages/ticket-workspace/ticket-workspace-page';
import ProjectsPage from '@/pages/projects/projects-page';
import ProjectBoardPage from '@/pages/projects/board/project-board-page';
import ProjectSettingsPage from '@/pages/projects/settings/project-settings-page';
import SettingsPage from '@/pages/settings/settings-page';

function RedirectToChat() {
  const { ticketId = '' } = useParams();
  return <Navigate to={`/chats/${ticketId}`} replace />;
}

function ProtectedRoutes() {
  const { isAuthenticated, loading } = useAuth();
  if (loading) {
    return (
      <PageContainer>
        <PageLoading />
      </PageContainer>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route element={<ProtectedRoutes />}>
        {/* Chats module: the chat list beside the new-chat screen (home) or the open chat. */}
        <Route element={<ChatsLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/chats/:ticketId" element={<TicketWorkspacePage />} />
        </Route>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectBoardPage />} />
        <Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/templates/:templateId" element={<TemplateEditorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* Old locations from before the chat-first workspace. */}
        <Route path="/tickets/:ticketId" element={<RedirectToChat />} />
        <Route path="/work" element={<Navigate to="/" replace />} />
        <Route path="/admin/projects" element={<Navigate to="/projects" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
