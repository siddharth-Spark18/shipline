import { CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import PairingDialog from '@/components/local/pairing-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/api';
import { useLocalLogout, useLocalReady, useStartLogin } from '@/services/local/local.hooks';

/** Shipline Local: connection status, pairing and sign-in. Working copies are set per project (project settings). */
export default function LocalServiceCard() {
  const { state, status, hello } = useLocalReady();
  const login = useStartLogin();
  const logout = useLocalLogout();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipline Local</CardTitle>
        <CardDescription>
          The small service on your computer that runs your own Claude Code. Choose each project's local folder in that project's
          settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1 text-sm">
          <Row ok={state !== 'unreachable' && state !== 'checking'} label={state === 'unreachable' ? 'Not running: open the Shipline tray app or run `pnpm dev:local`' : `Running${hello ? ` (app ${hello.appVersion}, plugin ${hello.pluginVersion})` : ''}`} />
          <Row ok={state === 'ready'} label={state === 'needs-pairing' ? 'This browser is not paired yet' : 'This browser is paired'} action={state === 'needs-pairing' ? <PairingDialog /> : undefined} />
          {status && (
            <>
              <Row
                ok={status.signedIn}
                label={status.signedIn ? 'Signed in to Shipline' : 'Not signed in to Shipline'}
                action={
                  status.signedIn ? (
                    <Button size="xs" variant="ghost" onClick={() => logout.mutate()}>
                      Sign out
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      onClick={() => login.mutate(undefined, { onSuccess: (url) => window.open(url, '_blank'), onError: (e) => toast.error(errorMessage(e)) })}
                    >
                      Sign in
                    </Button>
                  )
                }
              />
              <Row
                ok={status.claude.installed && status.claude.loggedIn && status.claude.meetsMinVersion}
                label={status.claude.guidance ?? `Claude Code ${status.claude.version} is installed and signed in with your own account`}
              />
              <Row ok={status.ghInstalled} label={status.ghInstalled ? 'GitHub CLI (gh) found' : 'GitHub CLI (gh) not found: needed for the Raise PR stage'} />
            </>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

function Row({ ok, label, action }: { ok: boolean; label: string; action?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? <CheckCircle2 className="size-4 text-green-600" /> : <XCircle className="size-4 text-amber-600" />}
      <span>{label}</span>
      {action}
    </li>
  );
}
