import { Navigate, useSearchParams } from 'react-router-dom';
import { Rocket } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { AuthService } from '@/services/auth/auth.service';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const ERRORS: Record<string, string> = {
  domain_not_allowed: 'That Google account is not on the allowed domain.',
  unverified_email: 'Your Google email is not verified.',
  invalid_state: 'Sign-in expired. Please try again.',
  no_id_token: 'Google did not return an identity. Please try again.',
};

export default function LoginPage() {
  const { isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const error = params.get('error');

  if (isAuthenticated) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader>
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Rocket className="size-5" />
          </div>
          <CardTitle className="text-2xl">Shipline</CardTitle>
          <CardDescription>One guardrailed workflow from Jira ticket to merged PR.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{ERRORS[error] ?? 'Sign-in failed.'}</AlertDescription>
            </Alert>
          )}
          <Button className="w-full" onClick={() => AuthService.signInWithGoogle()}>
            Sign in with Google
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
