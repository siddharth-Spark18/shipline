import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useProject } from '@/services/projects/projects.hooks';
import PageContainer from '@/components/layout/page-container';
import EmptyState from '@/components/shared/empty-state';
import PageLoading from '@/components/shared/page-loading';
import GeneralForm from './components/general-form';
import GuardrailsCard from './components/guardrails-card';
import MembersSection from './components/members-section';
import GithubWarningsPanel from './components/github-warnings-panel';
import TemplatesCard from './components/templates-card';
import LocalFolderCard from './components/local-folder-card';

export default function ProjectSettingsPage() {
  const { projectId = '' } = useParams();
  const { data, isPending } = useProject(projectId);

  if (isPending) {
    return (
      <PageContainer>
        <PageLoading />
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer>
        <EmptyState message="Project not found." />
      </PageContainer>
    );
  }
  const isAdmin = data.myAccess.isAdmin;

  return (
    <PageContainer>
      <div>
        <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft className="size-3" /> Back to chats
        </Link>
        <h1 className="text-xl font-semibold">{data.name} settings</h1>
        {!isAdmin && <p className="text-sm text-muted-foreground">Only project admins can change these settings.</p>}
      </div>
      <LocalFolderCard projectId={projectId} />
      {/* key: the forms seed their defaults from the project once; remount when their fields change. */}
      <GeneralForm key={`g-${JSON.stringify({ ...data, members: undefined, editPolicy: undefined })}`} project={data} readOnly={!isAdmin} />
      <TemplatesCard projectId={projectId} readOnly={!isAdmin} />
      <GuardrailsCard project={data} readOnly={!isAdmin} />
      <MembersSection project={data} readOnly={!isAdmin} />
      <GithubWarningsPanel projectId={projectId} />
    </PageContainer>
  );
}
