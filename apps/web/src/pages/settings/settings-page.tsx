import { useAuth } from '@/contexts/auth-context';
import PageContainer from '@/components/layout/page-container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import GithubLinkCard from './components/github-link-card';
import LocalServiceCard from './components/local-service-card';

export default function SettingsPage() {
  const { user } = useAuth();
  return (
    <PageContainer>
      <h1 className="text-xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {user?.name} &middot; {user?.email}
        </CardContent>
      </Card>
      <LocalServiceCard />
      <GithubLinkCard />
    </PageContainer>
  );
}
