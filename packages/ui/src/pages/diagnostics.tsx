import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { VersionInfo } from '@/lib/types';

function versionText(v: string | VersionInfo | undefined): string {
  if (v === undefined) return 'unknown';
  if (typeof v === 'string') return v;
  return `${v.package ?? 'legacy'} (interface ${v.interface})`;
}

/** The same diagnostics as before, in a right-hand Sheet opened from the sidebar status row. */
export function DiagnosticsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Diagnostics</SheetTitle>
          <SheetDescription>
            Redacted by the server. Safe to paste into a bug report.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {open && <DiagnosticsBody />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DiagnosticsBody() {
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: queryKeys.diagnostics,
    queryFn: api.diagnostics,
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load diagnostics</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  // The server returns redacted data; the copy button copies exactly that.
  const json = JSON.stringify(data, null, 2);
  const watchMode =
    data.watchMode ?? (typeof data.watch === 'string' ? data.watch : data.watch?.mode);
  const logLines = data.logTail ?? data.log ?? [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast.success('Copied the diagnostics to the clipboard');
    } catch {
      toast.error('Could not copy. Select the text below and copy it by hand.');
    }
  };

  const rows: [string, string][] = [
    ['Shipline UI version', versionText(data.uiVersion)],
    ['Repo version', versionText(data.repoVersion)],
    ['Version check', data.versionState ?? 'unknown'],
    ['Repo root', data.root ?? 'unknown'],
    ['Watch mode', watchMode ?? 'unknown'],
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-2">
        <Button size="sm" onClick={copy}>
          Copy for a bug report
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          Refresh
        </Button>
      </div>

      <Section title="Summary">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Last log lines">
        {logLines.length === 0 ? (
          <p className="text-sm text-muted-foreground">The log is empty.</p>
        ) : (
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {logLines.join('\n')}
          </pre>
        )}
      </Section>

      <Section title="Raw data (redacted)">
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs">
          {json}
        </pre>
      </Section>
    </div>
  );
}
