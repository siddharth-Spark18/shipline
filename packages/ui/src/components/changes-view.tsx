import { useMemo, useState, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRightIcon,
  FileMinusIcon,
  FilePenIcon,
  FilePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  ArrowRightLeftIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DiffView } from '@/components/diff-view';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { Change, ChangeStatus, DiffHunk } from '@/lib/types';

/** A change, optionally with its diff already in hand (the Setup save preview); otherwise it is loaded when expanded. */
export interface ChangeEntry extends Change {
  hunks?: DiffHunk[];
}

const STATUS: Record<
  ChangeStatus,
  { label: string; Icon: ComponentType<{ className?: string }>; className: string }
> = {
  added: { label: 'Added', Icon: FilePlusIcon, className: 'text-change-added' },
  modified: { label: 'Modified', Icon: FilePenIcon, className: 'text-change-modified' },
  deleted: { label: 'Deleted', Icon: FileMinusIcon, className: 'text-change-deleted' },
  renamed: { label: 'Renamed', Icon: ArrowRightLeftIcon, className: 'text-change-renamed' },
};

/** `+N` and `-M` line counts from parsed hunks. */
export function countDiff(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  }
  return { additions, deletions };
}

/** A file that is only additions was created, one that is only removals was deleted; anything else is modified. */
export function statusFromDiff(hunks: DiffHunk[]): ChangeStatus {
  const { additions, deletions } = countDiff(hunks);
  if (additions > 0 && deletions === 0) return 'added';
  if (deletions > 0 && additions === 0) return 'deleted';
  return 'modified';
}

interface FolderNode {
  name: string;
  folders: FolderNode[];
  files: ChangeEntry[];
}

function buildTree(entries: ChangeEntry[]): FolderNode {
  const root: FolderNode = { name: '', folders: [], files: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(e);
  }
  const tidy = (n: FolderNode): FolderNode => {
    n.folders = n.folders.map(tidy).sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    // a/b/c with nothing else in a or b reads better as one row
    if (n.name && n.files.length === 0 && n.folders.length === 1) {
      const only = n.folders[0];
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return tidy(root);
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function LazyDiff({ entry }: { entry: ChangeEntry }) {
  // The counts are part of the key: when the file changes again, the diff is fetched again.
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: [...queryKeys.file(entry.path, 'diff'), entry.additions, entry.deletions],
    queryFn: () => api.file(entry.path, 'diff'),
    staleTime: Infinity,
  });

  if (isPending) return <p className="text-xs text-muted-foreground">Loading diff...</p>;
  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
        <span>Could not load the diff: {error.message}</span>
        <Button variant="outline" size="xs" disabled={isFetching} onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if ('binary' in data)
    return <p className="text-xs text-muted-foreground">Binary file, no preview</p>;
  if (!('hunks' in data)) return <p className="text-xs text-muted-foreground">No preview.</p>;
  return <DiffView hunks={data.hunks} />;
}

function DiffBody({ entry }: { entry: ChangeEntry }) {
  if (entry.hunks) return <DiffView hunks={entry.hunks} />;
  if (entry.additions === null && entry.deletions === null)
    return <p className="text-xs text-muted-foreground">Binary file, no preview</p>;
  return <LazyDiff entry={entry} />;
}

function Counts({ entry }: { entry: ChangeEntry }) {
  if (entry.additions === null || entry.deletions === null) {
    return <span className="shrink-0 text-xs text-muted-foreground">binary</span>;
  }
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-change-added">+{entry.additions}</span>{' '}
      <span className="text-change-deleted">
        {'−'}
        {entry.deletions}
      </span>
    </span>
  );
}

function FileRow({
  entry,
  depth,
  defaultExpanded,
}: {
  entry: ChangeEntry;
  depth: number;
  defaultExpanded: boolean;
}) {
  const s = STATUS[entry.status];
  const name =
    entry.status === 'renamed' && entry.oldPath
      ? `${baseName(entry.oldPath)} → ${baseName(entry.path)}`
      : baseName(entry.path);
  return (
    <Collapsible defaultOpen={defaultExpanded} className="min-w-0">
      <CollapsibleTrigger
        className="group flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-sm hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        style={{ paddingLeft: `${depth * 0.875 + 0.25}rem` }}
        title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
      >
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        <s.Icon className={cn('size-4 shrink-0', s.className)} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
        <span className={cn('shrink-0 text-xs font-medium', s.className)}>{s.label}</span>
        <Counts entry={entry} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="min-w-0 py-1" style={{ paddingLeft: `${depth * 0.875 + 1.5}rem` }}>
          <DiffBody entry={entry} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FolderRow({
  node,
  depth,
  defaultExpanded,
}: {
  node: FolderNode;
  depth: number;
  defaultExpanded: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger
        className="group flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-sm text-muted-foreground hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        style={{ paddingLeft: `${depth * 0.875 + 0.25}rem` }}
      >
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        {open ? (
          <FolderOpenIcon className="size-4 shrink-0" aria-hidden />
        ) : (
          <FolderIcon className="size-4 shrink-0" aria-hidden />
        )}
        <span className="truncate font-mono text-xs">{node.name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TreeChildren node={node} depth={depth + 1} defaultExpanded={defaultExpanded} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function TreeChildren({
  node,
  depth,
  defaultExpanded,
}: {
  node: FolderNode;
  depth: number;
  defaultExpanded: boolean;
}) {
  return (
    <>
      {node.folders.map((f) => (
        <FolderRow key={f.name} node={f} depth={depth} defaultExpanded={defaultExpanded} />
      ))}
      {node.files.map((e) => (
        <FileRow key={e.path} entry={e} depth={depth} defaultExpanded={defaultExpanded} />
      ))}
    </>
  );
}

/**
 * Changed files as a collapsible folder tree: status (icon, colour and word) and `+N -M` per file,
 * and the file's unified diff inline when its row is expanded. Diffs are fetched lazily from
 * /api/file unless the entry carries its own `hunks`.
 */
export function ChangesView({
  changes,
  defaultExpanded = false,
  className,
}: {
  changes: ChangeEntry[];
  /** Open every file's diff at first (the save preview). */
  defaultExpanded?: boolean;
  className?: string;
}) {
  const tree = useMemo(() => buildTree(changes), [changes]);
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">No changes</p>;
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <TreeChildren node={tree} depth={0} defaultExpanded={defaultExpanded} />
    </div>
  );
}

/** "Working tree changes" as a card (Tasks page, task cards). */
export function ChangesCard({ changes }: { changes: Change[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Working tree changes</CardTitle>
      </CardHeader>
      <CardContent>
        <ChangesView changes={changes} />
      </CardContent>
    </Card>
  );
}
