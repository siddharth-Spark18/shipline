import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/auth-context';
import { AuthService } from '@/services/auth/auth.service';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function GithubLinkCard() {
  const { user, refreshUser } = useAuth();
  const [params] = useSearchParams();
  const result = params.get('github');

  useEffect(() => {
    if (result === 'linked') void refreshUser();
  }, [result, refreshUser]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub account</CardTitle>
        <CardDescription>
          Link your GitHub account once so Shipline can match you to repository permissions. Shipline stores only your GitHub
          username. PRs are opened by Claude with your own `gh`, so you are the author.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {user?.githubLogin ? (
          <p className="text-sm text-green-700 dark:text-green-400">Linked as @{user.githubLogin}</p>
        ) : (
          <Button onClick={() => AuthService.connectGithub()}>Link GitHub account</Button>
        )}
        {result === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>GitHub linking failed.</AlertDescription>
          </Alert>
        )}
        {result === 'already_linked_to_other' && (
          <Alert variant="destructive">
            <AlertDescription>That GitHub account is linked to another user.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
