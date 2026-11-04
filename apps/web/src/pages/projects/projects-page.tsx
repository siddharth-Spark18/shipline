import { Link } from 'react-router-dom';
import { useProjects } from '@/services/projects/projects.hooks';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import PageContainer from '@/components/layout/page-container';
import EmptyState from '@/components/shared/empty-state';

export default function ProjectsPage() {
  const { data, isPending } = useProjects();

  return (
    <PageContainer>
      <div>
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground">Repositories registered with Shipline and the chats in each. Admins register projects under Admin.</p>
      </div>
      {isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardHeader>
                  <CardTitle>{p.name}</CardTitle>
                  <CardDescription>
                    {p.githubRepo} · key {p.keyPrefix}-n · Jira {p.jiraProjectKey} · base {p.baseBranch}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState message="You are not on any project yet. Ask an admin to add you." />
      )}
    </PageContainer>
  );
}
