import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ChangesView,
  countDiff,
  statusFromDiff,
  type ChangeEntry,
} from '@/components/changes-view';
import type { ImpactEntry, PreviewFile, PreviewResponse, ValidationIssue } from '@/lib/types';

export function fileLabel(f: { kind: string; id?: string }): string {
  switch (f.kind) {
    case 'config':
      return 'config.yml';
    case 'workflow':
      return `workflows/${f.id}.yml`;
    case 'agent':
      return `.claude/agents/${f.id}.md`;
    default:
      return `rules/${f.id}.md`;
  }
}

export const isError = (i: ValidationIssue) => i.severity !== 'warning';

export function previewHasErrors(preview: PreviewResponse | undefined): boolean {
  return !!preview?.files.some((f) => f.errors.some(isError));
}

function taskName(t: ImpactEntry['task']): string {
  if (typeof t === 'string') return t;
  return t.slug ?? t.dir ?? t.title ?? 'task';
}

function impactText(e: ImpactEntry): string {
  const parts: string[] = [];
  if (e.reordered) parts.push('keeps old order');
  if (e.added.length)
    parts.push(
      `will not get ${e.added.length === 1 ? 'stage' : 'stages'} ${e.added.map((s) => `\`${s}\``).join(', ')}`,
    );
  if (e.removed.length)
    parts.push(
      `keeps ${e.removed.length === 1 ? 'stage' : 'stages'} ${e.removed.map((s) => `\`${s}\``).join(', ')}`,
    );
  return `${taskName(e.task)}: ${parts.join('; ') || 'keeps its stage list'}`;
}

function Issues({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {issues.map((i, k) => (
        <li key={k} className={isError(i) ? 'text-destructive' : 'text-enf-warn'}>
          {i.path && <span className="font-mono">{i.path}: </span>}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

/** The preview's files as changes: status from the shape of the diff, counts from its hunks. */
export function previewChanges(files: PreviewFile[]): ChangeEntry[] {
  return files.map((f) => ({
    path: fileLabel(f),
    status: statusFromDiff(f.diff),
    ...countDiff(f.diff),
    hunks: f.diff,
  }));
}

/** Errors, warnings and removed comments per file; they must be visible without opening a diff. */
export function FileNotes({ files }: { files: PreviewFile[] }) {
  const noted = files.filter((f) => f.errors.length > 0 || f.removedComments.length > 0);
  if (noted.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {noted.map((file) => (
        <section key={fileLabel(file)} className="flex flex-col gap-2">
          <h3 className="font-mono text-sm font-medium">{fileLabel(file)}</h3>
          <Issues issues={file.errors} />
          {file.removedComments.length > 0 && (
            <div className="rounded-md border border-enf-warn/40 bg-enf-warn/10 p-2 text-xs">
              <p className="mb-1 font-medium">Comments that would be removed</p>
              <ul className="flex flex-col gap-0.5 font-mono">
                {file.removedComments.map((c, i) => (
                  <li key={i} className="whitespace-pre-wrap">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export interface SaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: PreviewResponse | undefined;
  previewLoading: boolean;
  previewError: Error | null;
  /** The repo is newer than this UI: saving is refused. */
  readOnly: boolean;
  saving: boolean;
  saveError: Error | null;
  /** Issues from a 400 `invalid` response. */
  saveIssues: ValidationIssue[];
  /** A 409 `changed` / `exists` response: the files on disk are not the ones that were loaded. */
  conflict: boolean;
  removedStages: { workflow: string; stage: string }[];
  onSave: () => void;
  onReload: () => void;
}

/** Shows the diff, removed comments, open-task impact and errors before anything is written. */
export function SaveDialog(props: SaveDialogProps) {
  const { preview, readOnly } = props;
  const blocked =
    readOnly ||
    props.previewLoading ||
    !preview ||
    !!props.previewError ||
    previewHasErrors(preview) ||
    props.saving;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Review changes</DialogTitle>
          <DialogDescription>
            Nothing is written until you save. Shipline never commits for you.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-4 pr-3">
            {readOnly && (
              <Alert variant="destructive">
                <AlertTitle>Saving is disabled</AlertTitle>
                <AlertDescription>
                  This repo was set up with a newer Shipline than this UI. See the banner at the
                  top.
                </AlertDescription>
              </Alert>
            )}
            {props.previewLoading && (
              <p className="text-sm text-muted-foreground">Preparing preview...</p>
            )}
            {props.previewError && (
              <p className="text-sm text-destructive">{props.previewError.message}</p>
            )}

            {preview && preview.impact.length > 0 && (
              <Alert>
                <AlertTitle>Open tasks that keep the old stage list</AlertTitle>
                <AlertDescription>
                  <ul className="mt-1 list-disc pl-4">
                    {preview.impact.map((e, i) => (
                      <li key={i}>{impactText(e)}</li>
                    ))}
                  </ul>
                  <p className="mt-1">
                    Shipline never edits a manifest. These tasks continue with their own list.
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {props.removedStages.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Removed stages leave their rules files in place:{' '}
                {props.removedStages.map((r) => `${r.stage} (${r.workflow})`).join(', ')}.
              </p>
            )}

            {preview && <FileNotes files={preview.files} />}
            {preview && <ChangesView changes={previewChanges(preview.files)} defaultExpanded />}

            {props.conflict && (
              <Alert variant="destructive">
                <AlertTitle>Files changed on disk</AlertTitle>
                <AlertDescription>
                  A file was changed outside this page, so nothing was written. Reload to see the
                  current files; your edits on this page will be discarded.
                  <div className="mt-2">
                    <Button variant="outline" size="sm" onClick={props.onReload}>
                      Reload from disk
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
            {props.saveError && !props.conflict && (
              <Alert variant="destructive">
                <AlertTitle>Save failed</AlertTitle>
                <AlertDescription>
                  {props.saveError.message}
                  <Issues issues={props.saveIssues} />
                </AlertDescription>
              </Alert>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={blocked} onClick={props.onSave}>
            {props.saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
