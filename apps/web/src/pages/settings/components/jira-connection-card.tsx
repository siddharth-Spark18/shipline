import { useSearchParams } from 'react-router-dom';
import { useJiraStatus } from '@/services/jira/jira.hooks';
import { JiraService } from '@/services/jira/jira.service';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function JiraConnectionCard() {
  const { data } = useJiraStatus();
  const [params] = useSearchParams();
  const result = params.get('jira');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jira connection (admin)</CardTitle>
        <CardDescription>
          Claude can search and link Jira tickets for a chat through this connection. It is read-only: Shipline never writes to Jira.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.connected && <p className="text-sm text-green-700 dark:text-green-400">Connected to {data.siteName ?? data.siteUrl}</p>}
        {data && !data.configured ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">Jira OAuth credentials are not configured on the server.</p>
        ) : (
          <Button onClick={() => JiraService.connect()}>{data?.connected ? 'Reconnect Jira' : 'Connect Jira'}</Button>
        )}
        {result === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>Jira connection failed.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
