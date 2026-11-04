import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PageContainer from '@/components/layout/page-container';
import DataTable from '@/components/shared/data-table';
import EmptyState from '@/components/shared/empty-state';
import PageLoading from '@/components/shared/page-loading';
import StageStatusBadge from '@/components/shared/stage-status-badge';
import { useBoard, useProject } from '@/services/projects/projects.hooks';
import { BoardChat } from '@/services/projects/projects.types';

export default function ProjectBoardPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const board = useBoard(projectId);

  const columns = useMemo<ColumnDef<BoardChat, unknown>[]>(
    () => [
      {
        accessorKey: 'key',
        header: 'Chat',
        cell: ({ row }) => (
          <div className="max-w-md">
            <Link to={`/chats/${row.original.id}`} className="font-medium hover:underline">
              {row.original.key}
            </Link>
            {row.original.jiraKey && (
              <Badge variant="outline" className="ml-2">
                Jira {row.original.jiraKey}
              </Badge>
            )}
            <Badge variant="outline" className="ml-2" title={`Template version ${row.original.template.version}`}>
              {row.original.template.name}
            </Badge>
            <p className="truncate text-sm text-muted-foreground">{row.original.title}</p>
          </div>
        ),
      },
      { id: 'owner', header: 'Owner', cell: ({ row }) => row.original.owner.name },
      {
        id: 'branch',
        header: 'Branch',
        cell: ({ row }) => (row.original.branch ? <code className="text-xs">{row.original.branch}</code> : <span className="text-muted-foreground">none yet</span>),
      },
      {
        id: 'stage',
        header: 'Stage',
        cell: ({ row }) =>
          row.original.currentStage ? (
            <div className="flex items-center gap-2">
              {row.original.currentStage.name}
              <StageStatusBadge status={row.original.currentStage.status} />
            </div>
          ) : (
            <Badge variant="secondary">Done</Badge>
          ),
      },
      {
        id: 'pr',
        header: 'PR',
        cell: ({ row }) => (row.original.prState ? <Badge variant="outline">{row.original.prState.toLowerCase()}</Badge> : '-'),
      },
    ],
    [],
  );

  if (project.isPending || board.isPending) {
    return (
      <PageContainer>
        <PageLoading />
      </PageContainer>
    );
  }
  if (!project.data || !board.data) {
    return (
      <PageContainer>
        <EmptyState message="Project not found." />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{project.data.name}</h1>
          <p className="text-sm text-muted-foreground">
            {project.data.githubRepo} · chats are keyed {project.data.keyPrefix}-n. Only a chat's owner can run it; you can see where it stands.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to={`/projects/${projectId}/settings`}>
            <Settings /> Settings
          </Link>
        </Button>
      </div>
      <DataTable columns={columns} data={board.data} emptyMessage="No chats yet. Start one from the Chats module." />
    </PageContainer>
  );
}
