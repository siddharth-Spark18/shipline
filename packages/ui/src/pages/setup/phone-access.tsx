import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api';
import { useRemote, useRemoteMutations } from '@/lib/queries';
import type { PairResponse, TailscaleState } from '@/lib/types';

const FIX: Record<Exclude<TailscaleState, 'ok'>, string> = {
  missing: 'Install Tailscale on this computer and sign in, then reload this page.',
  'logged-out': 'Open the Tailscale app on this computer and sign in, then reload this page.',
  'no-https':
    'Turn on HTTPS certificates for your tailnet (Tailscale admin console, DNS page), then reload this page.',
  'no-free-port': 'Stop one of the other Tailscale serve mappings, then reload this page.',
  error: 'Check that Tailscale is running, then reload this page.',
};

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** A QR code as an inline SVG (one path), built from the module matrix. */
function QrCode({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, d };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label="QR code to pair a phone"
      viewBox={`0 0 ${svg.size} ${svg.size}`}
      className="size-56 rounded-md border bg-white"
      shapeRendering="crispEdges"
    >
      <rect width={svg.size} height={svg.size} fill="#fff" />
      <path d={svg.d} fill="#000" />
    </svg>
  );
}

function Pairing({ pairing, onClose }: { pairing: PairResponse; onClose: () => void }) {
  const expires = new Date(pairing.expiresAt).getTime();
  const [left, setLeft] = useState(() => Math.max(0, Math.round((expires - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(
      () => setLeft(Math.max(0, Math.round((expires - Date.now()) / 1000))),
      1000,
    );
    return () => clearInterval(t);
  }, [expires]);

  if (left === 0)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">This code expired. Make a new one.</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairing.url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <QrCode text={pairing.url} />
      <p className="text-xs text-muted-foreground">
        Scan with the phone's camera. The phone must be on your Tailscale network. The link works
        once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          Or, on the phone, choose &quot;Enter pairing code&quot; and type:
        </p>
        <p
          className="font-mono text-3xl font-semibold tracking-widest select-all"
          aria-label={`Pairing code ${pairing.shortCode.split('').join(' ')}`}
        >
          {pairing.shortCode}
        </p>
        <p className="text-xs text-muted-foreground">
          Using the link or the code uses up both. After 5 wrong codes the pairing is cancelled.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          Copy link
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Setup > Phone access: use this UI from your own phone over Tailscale. */
export function PhoneAccess() {
  const [pairing, setPairing] = useState<PairResponse | null>(null);
  const { data, error, isPending } = useRemote(true, pairing !== null);
  const { setEnabled, pair, revoke } = useRemoteMutations();

  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data)
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load phone access</AlertTitle>
        <AlertDescription>
          {error instanceof Error ? error.message : 'Unknown error'}
        </AlertDescription>
      </Alert>
    );

  const state = data.tailscale.state;
  const unavailable = !data.enabled && state !== 'ok';
  const fail = (e: unknown) =>
    toast.error(e instanceof ApiError ? e.message : 'Something went wrong');

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-sm font-medium">Phone access</h2>

      <section className="flex flex-col gap-4" aria-labelledby="phone-heading">
        <div>
          <h3 id="phone-heading" className="text-sm font-medium">
            Use this UI from your phone
          </h3>
          <p className="text-xs text-muted-foreground">
            Opens this same UI on your own phone through your Tailscale network (HTTPS, only for
            your Tailscale account). A paired phone can do everything this page can, including
            answering a chat that waits for you.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="phone-enabled"
            checked={data.enabled}
            disabled={setEnabled.isPending || unavailable}
            onCheckedChange={(v) => {
              setPairing(null);
              setEnabled.mutate(v, { onError: fail });
            }}
          />
          <Label htmlFor="phone-enabled">Phone access</Label>
          <span className="ml-auto text-xs text-muted-foreground">
            {data.enabled ? 'On' : 'Off'}
          </span>
        </div>

        {!data.enabled && state !== 'ok' && (
          <Alert>
            <AlertTitle>Phone access is not available</AlertTitle>
            <AlertDescription>
              <p>{data.tailscale.message}</p>
              <p>{FIX[state]}</p>
            </AlertDescription>
          </Alert>
        )}

        {data.enabled && data.url && (
          <p className="text-xs text-muted-foreground">
            Address: <code className="font-mono break-all">{data.url}</code>
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Keep this computer awake and Shipline running: if it sleeps, the phone cannot reach it.
        </p>
      </section>

      {data.enabled && (
        <section className="flex flex-col gap-3" aria-labelledby="pair-heading">
          <h3 id="pair-heading" className="text-sm font-medium">
            Pair a phone
          </h3>
          {data.pairing?.cancelled && (
            <Alert variant="destructive">
              <AlertTitle>Pairing cancelled</AlertTitle>
              <AlertDescription>
                Pairing cancelled after too many wrong codes. Make a new one.
              </AlertDescription>
            </Alert>
          )}
          {pairing && !data.pairing?.cancelled ? (
            <Pairing pairing={pairing} onClose={() => setPairing(null)} />
          ) : (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={pair.isPending}
                onClick={() => pair.mutate(undefined, { onSuccess: setPairing, onError: fail })}
              >
                Pair a phone
              </Button>
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="devices-heading">
        <h3 id="devices-heading" className="text-sm font-medium">
          Paired devices
        </h3>
        {data.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No phone is paired yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {data.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {d.name}
                    {d.current && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        (this device)
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Paired {dateText(d.pairedAt)}. Last seen {dateText(d.lastSeenAt)}.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(d.id, { onError: fail })}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Paired devices stay paired until you revoke them, across every repo. Revoking cuts a phone
          off at once.
        </p>
      </section>
    </div>
  );
}
