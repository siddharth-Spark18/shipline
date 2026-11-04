import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/auth-context';
import PageContainer from '@/components/layout/page-container';
import EmptyState from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import CreateProjectDialog from '@/pages/projects/components/create-project-dialog';
import AgentsTab from './components/agents-tab';
import OrgGuardrailsTab from './components/org-guardrails-tab';
import ProjectsTab from './components/projects-tab';
import TemplatesTab from './components/templates-tab';

const TABS = ['projects', 'templates', 'agents', 'guardrails'] as const;
type AdminTab = (typeof TABS)[number];

/**
 * Admin module (org admins): projects and the Jira connection, the workflow template library, custom
 * agents and the org-wide guardrail baseline. The tab is kept in the URL (`?tab=templates`).
 */
export default function AdminPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: AdminTab = TABS.find((t) => t === requested) ?? 'projects';

  if (!user?.isAdmin) {
    return (
      <PageContainer>
        <EmptyState message="Only admins can open this page." />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Admin</h1>
          <p className="text-sm text-muted-foreground">
            Projects and the Jira connection, the workflow templates every project can use, custom agents, and the org-wide guardrails.
          </p>
        </div>
        {tab === 'projects' && (
          <CreateProjectDialog
            trigger={
              <Button>
                <Plus /> New project
              </Button>
            }
          />
        )}
      </div>
      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="templates">Workflow templates</TabsTrigger>
          <TabsTrigger value="agents">Custom agents</TabsTrigger>
          <TabsTrigger value="guardrails">Org guardrails</TabsTrigger>
        </TabsList>
        <TabsContent value="projects" className="space-y-6">
          <ProjectsTab />
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab />
        </TabsContent>
        <TabsContent value="guardrails">
          <OrgGuardrailsTab />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
