import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useRemoteMutations } from '@/lib/queries';

const NAME_MAX = 40;

/** The phone's screen at /pair?c=<code>: name the device, then pair it. */
export default function PairPage() {
  const code = new URLSearchParams(window.location.search).get('c') ?? '';
  const [name, setName] = useState('');
  const { claim } = useRemoteMutations();

  const trimmed = name.trim();
  const nameError = trimmed.length > NAME_MAX ? `At most ${NAME_MAX} characters` : null;

  const submit = () =>
    claim.mutate(
      { code, name: trimmed },
      // A full load: the cookie is set now, and the app starts clean.
      { onSuccess: () => window.location.replace('/') },
    );

  const error = claim.error;
  const message =
    error instanceof ApiError
      ? error.code === 'bad-code'
        ? 'This pairing link is used up or expired. On the computer, open Setup > Phone access and scan a new QR code.'
        : error.code === 'bad-name'
          ? `Give the device a name of 1 to ${NAME_MAX} characters.`
          : error.message
      : error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <div className="mx-auto flex min-h-svh max-w-sm items-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Name this device</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed && !nameError) submit();
            }}
          >
            <p className="text-sm text-muted-foreground">
              Pairing lets this phone use Shipline on your computer, including answering chats.
              Revoke it any time from Setup &gt; Phone access.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-name">Device name</Label>
              <Input
                id="device-name"
                value={name}
                autoFocus
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
            <Button type="submit" disabled={!trimmed || !!nameError || !code || claim.isPending}>
              Pair
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
