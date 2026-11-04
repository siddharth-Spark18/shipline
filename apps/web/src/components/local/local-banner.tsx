import { AlertTriangle, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { useLocalReady, useStartLogin } from '@/services/local/local.hooks';
import PairingDialog from './pairing-dialog';

/**
 * Blocking banner for the work view. The ticket list and admin pages work without the local
 * service; this explains what is missing and retries by itself (the connection probe polls).
 */
export default function LocalBanner() {
  const { state, status, claudeReady } = useLocalReady();
  const login = useStartLogin();

  if (state === 'checking') return null;

  if (state === 'unreachable') {
    return (
      <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
        <PlugZap />
        <AlertTitle>Start Shipline Local</AlertTitle>
        <AlertDescription>
          <p>Shipline runs Claude on your computer through a small local service, and it is not reachable on 127.0.0.1. Checking again every few seconds.</p>
          <ol className="mt-1 list-decimal pl-5">
            <li>Install and open the Shipline desktop app (it lives in your menu bar / tray), or run <code>pnpm dev:local</code> in a terminal.</li>
            <li>Come back here and enter the one-time pairing code it shows.</li>
          </ol>
        </AlertDescription>
      </Alert>
    );
  }

  if (state === 'needs-pairing') {
    return (
      <Alert className="rounded-none border-x-0 border-t-0">
        <PlugZap />
        <AlertTitle>Pair this browser with Shipline Local</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>The local service is running. Enter the one-time code from the tray (or terminal) to connect.</span>
          <PairingDialog />
        </AlertDescription>
      </Alert>
    );
  }

  if (status && !status.signedIn) {
    return (
      <Alert className="rounded-none border-x-0 border-t-0">
        <AlertTriangle />
        <AlertTitle>Shipline Local is not signed in to Shipline</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>One-time sign-in so the local service can fetch your tickets and apply server-side tool policy.</span>
          <Button
            size="sm"
            disabled={login.isPending}
            onClick={() =>
              login.mutate(undefined, {
                onSuccess: (url) => window.open(url, '_blank'),
                onError: (err) => toast.error(errorMessage(err)),
              })
            }
          >
            Sign in
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (status && !claudeReady) {
    return (
      <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
        <AlertTriangle />
        <AlertTitle>Claude Code is not ready</AlertTitle>
        <AlertDescription>{status.claude.guidance}</AlertDescription>
      </Alert>
    );
  }

  return null;
}
