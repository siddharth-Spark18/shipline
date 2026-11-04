import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useGithubWarnings } from '@/services/projects/projects.hooks';

export default function GithubWarningsPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError } = useGithubWarnings(projectId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub permission check</CardTitle>
        <CardDescription>
          Repo permissions are managed manually in GitHub. Shipline only warns on a mismatch with roles; it never changes
          permissions. Branch protection must require the <code>shipline/gates</code> check, and the GitHub App must subscribe to
          the Pull request, Pull request review and Pull request review comment events.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-10" />
        ) : isError || !data?.available ? (
          <p className="text-sm text-muted-foreground">GitHub App is not installed or configured for this repository.</p>
        ) : data.warnings.length === 0 ? (
          <p className="text-sm text-green-700 dark:text-green-400">No mismatches found.</p>
        ) : (
          <div className="space-y-2">
            {data.warnings.map((w, i) => (
              <Alert key={`${w.login}-${i}`}>
                <AlertDescription>
                  <strong>{w.name ?? w.login}</strong>: {w.message}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
