import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useRemoteMutations } from '@/lib/queries';
import type { AccessIssue } from '@/lib/types';

const NAME_MAX = 40;

const TEXT: Record<AccessIssue, { title: string; body: string }> = {
  'not-paired': {
    title: 'This device is not paired',
    body: 'On your computer, open Setup > Phone access and scan a new QR code with this phone, or press Pair a phone there and enter the code below.',
  },
  revoked: {
    title: 'This device was removed',
    body: 'Its pairing was revoked. To use Shipline here again, open Setup > Phone access on your computer and scan a new QR code, or press Pair a phone there and enter the code below.',
  },
  'remote-off': {
    title: 'Phone access is off',
    body: 'Turn it back on in Setup > Phone access on your computer, then reload this page.',
  },
  'wrong-tailscale-user': {
    title: 'Wrong Tailscale account',
    body: "This phone is signed in to Tailscale as a different user than your computer. Sign in with the computer's Tailscale account, then reload.",
  },
};

/** The two reasons a short code can be entered for: this device has no (or lost its) pairing. */
const CAN_ENTER_CODE: AccessIssue[] = ['not-paired', 'revoked'];

/** "Enter pairing code": the short code from Setup > Phone access on the computer, and a name for this device. */
function CodeForm() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const { claim } = useRemoteMutations();

  const trimmed = name.trim();
  const nameError = trimmed.length > NAME_MAX ? `At most ${NAME_MAX} characters` : null;
  // Upper case, no dash or spaces: what the server compares. 8 characters.
  const clean = code.replace(/[\s-]+/g, '');

  const error = claim.error;
  const message =
    error instanceof ApiError
      ? error.code === 'bad-code'
        ? 'Wrong or expired code. Check it, or make a new one on the computer.'
        : error.code === 'bad-name'
          ? `Give the device a name of 1 to ${NAME_MAX} characters.`
          : error.code === 'pairing-cancelled'
            ? 'Pairing was cancelled after too many wrong codes. Make a new one on the computer.'
            : error.message
      : error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean.length === 8 && trimmed && !nameError)
          claim.mutate(
            { shortCode: code, name: trimmed },
            // A full load: the cookie is set now, and the app starts clean.
            { onSuccess: () => window.location.replace('/') },
          );
      }}
    >
      <h3 className="text-sm font-medium">Enter pairing code</h3>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pair-code">Pairing code</Label>
        <Input
          id="pair-code"
          value={code}
          className="h-11 font-mono text-lg tracking-widest uppercase"
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pair-name">Device name</Label>
        <Input
          id="pair-name"
          value={name}
          className="h-11"
          placeholder="My phone"
          onChange={(e) => setName(e.target.value)}
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </div>
      {message && (
        <Alert variant="destructive">
          <AlertTitle>Could not pair</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <Button
        type="submit"
        className="h-11"
        disabled={clean.length !== 8 || !trimmed || !!nameError || claim.isPending}
      >
        Pair
      </Button>
    </form>
  );
}

/** Shown when the server refuses this device: one line on how to fix it, and the short-code form where it applies. */
export default function NotPaired({ reason }: { reason: AccessIssue }) {
  const t = TEXT[reason];
  return (
    <div className="mx-auto flex min-h-svh max-w-sm items-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">{t.body}</p>
          {CAN_ENTER_CODE.includes(reason) && <CodeForm />}
        </CardContent>
      </Card>
    </div>
  );
}
