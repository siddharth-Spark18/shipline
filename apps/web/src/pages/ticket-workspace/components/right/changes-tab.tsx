import { useEffect, useState } from 'react';
import { ChevronRight, FileDiff, GitCompare } from 'lucide-react';
import { DiffFileDTO, DiffFileStatus, DiffMode } from '@shipline/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { errorMessage } from '@/lib/api';
import { useDiff } from '@/services/local/local.hooks';
import EmptyState from '@/components/shared/empty-state';
import DiffFileView from './diff-file-view';

const STATUS_LABEL: Record<DiffFileStatus, string> = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' };
const STATUS_STYLE: Record<DiffFileStatus, string> = {
  added: 'text-green-700 dark:text-green-400',
  modified: 'text-amber-700 dark:text-amber-400',
  deleted: 'text-red-700 dark:text-red-400',
  renamed: 'text-blue-700 dark:text-blue-400',
};

interface ChangesTabProps {
  ticketId: string;
  /** Local service ready and the chat has a worktree. */
  enabled: boolean;
  /** A file to expand on open (from the chat's summary card). */
  focusPath?: string;
}

/** Read-only diffs. The branch-vs-base / uncommitted toggle lives here; live refresh is page-level. */
export default function ChangesTab({ ticketId, enabled, focusPath }: ChangesTabProps) {
  const [mode, setMode] = useState<DiffMode>('branch');
  const diff = useDiff(ticketId, mode, enabled);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as DiffMode)}
        >
          <ToggleGroupItem value="branch" title="Everything on the branch since it left the base branch, plus uncommitted work">
            Branch vs base
          </ToggleGroupItem>
          <ToggleGroupItem value="uncommitted" title="Only changes not committed yet">
            Uncommitted
          </ToggleGroupItem>
        </ToggleGroup>
        {diff.data && (
          <span className="text-xs text-muted-foreground">
            {diff.data.files.length} file{diff.data.files.length === 1 ? '' : 's'}{' '}
            <span className="text-green-700 dark:text-green-400">+{diff.data.additions}</span>{' '}
            <span className="text-red-700 dark:text-red-400">-{diff.data.deletions}</span>
          </span>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!enabled ? (
          <EmptyState message="Start the chat to see its changes here." />
        ) : diff.isPending ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : diff.error ? (
          <Alert variant="destructive" className="m-3">
            <AlertDescription>{errorMessage(diff.error)}</AlertDescription>
          </Alert>
        ) : diff.data.files.length === 0 ? (
          <EmptyState message={mode === 'branch' ? `No changes yet compared with ${diff.data.baseBranch}.` : 'No uncommitted changes.'}>
            <GitCompare className="size-5" />
          </EmptyState>
        ) : (
          <div className="divide-y">
            {diff.data.files.map((f) => (
              <FileRow key={`${f.oldPath ?? ''}>${f.path}`} ticketId={ticketId} mode={mode} file={f} defaultOpen={f.path === focusPath} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function FileRow({ ticketId, mode, file, defaultOpen }: { ticketId: string; mode: DiffMode; file: DiffFileDTO; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <FileDiff className={`size-3.5 shrink-0 ${STATUS_STYLE[file.status]}`} />
        <span className="min-w-0 flex-1 truncate font-mono" title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
        </span>
        {file.status !== 'modified' && <Badge variant="outline">{STATUS_LABEL[file.status]}</Badge>}
        {file.binary ? (
          <Badge variant="outline">binary</Badge>
        ) : (
          <span className="shrink-0 font-mono">
            <span className="text-green-700 dark:text-green-400">+{file.additions}</span>{' '}
            <span className="text-red-700 dark:text-red-400">-{file.deletions}</span>
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>{open && <DiffFileView ticketId={ticketId} mode={mode} file={file} />}</CollapsibleContent>
    </Collapsible>
  );
}
