import { Link } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useProjects } from '@/services/projects/projects.hooks';
import EmptyState from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import JiraConnectionCard from '@/pages/settings/components/jira-connection-card';

/** Register projects (and their chat key prefix), open their settings, connect Jira. */
export default function ProjectsTab() {
  const { data, isPending } = useProjects();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>Each project's key prefix builds its chat keys (for example LL gives LL-12).</CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-16" />
          ) : data && data.length > 0 ? (
            <ul className="divide-y">
              {data.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="text-muted-foreground">
                      {p.githubRepo} · key {p.keyPrefix}-n · Jira {p.jiraProjectKey}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/projects/${p.id}/settings`}>
                      <Settings /> Settings
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState message="No projects yet. Register one to start chatting." />
          )}
        </CardContent>
      </Card>
      <JiraConnectionCard />
    </>
  );
}
