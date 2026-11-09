import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DiffView } from '@/components/diff-view';
import type { InstallPreview, InstallPreviewFile, InstallSelection } from '@/lib/types';

const ACTION_LABEL: Record<InstallPreviewFile['action'], string> = {
  create: 'create',
  overwrite: 'overwrite',
  merge: 'merge',
};

/**
 * The last step: every file that will be written, with its text (create, overwrite) or its diff (the two merged
 * files), the agents recorded as not installed, and anything that blocks the install. Nothing is written here.
 */
export function ReviewStep({
  preview,
  loading,
  error,
  selection,
}: {
  selection?: InstallSelection;
  preview: InstallPreview | undefined;
  loading: boolean;
  error: Error | null;
}) {
  const [viewing, setViewing] = useState<InstallPreviewFile | null>(null);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not prepare the preview</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!preview || loading)
    return <p className="text-sm text-muted-foreground">Preparing preview...</p>;

  const created = preview.files.filter((f) => f.action === 'create');
  const overwritten = preview.files.filter((f) => f.action === 'overwrite');
  const merged = preview.files.filter((f) => f.action === 'merge');

  const row = (f: InstallPreviewFile) => (
    <li key={f.path} className="flex items-center gap-2 font-mono text-xs">
      <Badge variant="outline">{ACTION_LABEL[f.action]}</Badge>
      <span className="break-all">{f.path}</span>
      {f.text !== undefined && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setViewing(f)}>
          view
        </Button>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-5">
      {selection && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Settings</h3>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Confirmations</dt>
            <dd>{selection.confirmations === 'light' ? 'Light' : 'Standard'}</dd>
            <dt className="text-muted-foreground">Guardrails</dt>
            <dd>{selection.guardrails === 'off' ? 'Off' : 'On'}</dd>
            <dt className="text-muted-foreground">Branch pattern</dt>
            <dd className="font-mono">{selection.branchPattern ?? '{type}/{key}-{slug}'}</dd>
          </dl>
        </section>
      )}

      {preview.collisions.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Install is blocked</AlertTitle>
          <AlertDescription>
            <p>These paths already exist:</p>
            <ul className="list-disc pl-4 font-mono text-xs">
              {preview.collisions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="mt-1">Rename or move them, then reload this page.</p>
          </AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Files to create ({created.length})</h3>
        <ul className="flex flex-col gap-1">{created.map(row)}</ul>
      </section>

      {overwritten.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Your files to overwrite ({overwritten.length})</h3>
          <ul className="flex flex-col gap-1">{overwritten.map(row)}</ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Files to merge into</h3>
        {merged.length === 0 && (
          <p className="text-xs text-muted-foreground">
            None: .claude/settings.json and CLAUDE.md are created new (see the list above).
          </p>
        )}
        {merged.map((f) => (
          <Collapsible key={f.path} className="rounded-lg border bg-card px-3 py-2">
            <CollapsibleTrigger className="font-mono text-sm">{f.path}</CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <DiffView hunks={f.diff ?? []} className="max-h-96 overflow-auto" />
            </CollapsibleContent>
          </Collapsible>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Agents not installed ({preview.excluded.length})</h3>
        {preview.excluded.length === 0 ? (
          <p className="text-xs text-muted-foreground">Every Shipline agent is installed.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5 font-mono text-xs">
              {preview.excluded.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Recorded as excluded, so <code>upgrade</code> will not add them. Add them later in
              Setup.
            </p>
          </>
        )}
      </section>

      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm break-all">{viewing?.path}</DialogTitle>
            <DialogDescription>The file as it will be written</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh]">
            <pre className="pr-3 font-mono text-xs whitespace-pre-wrap">{viewing?.text}</pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
