import { useState } from 'react';
import { DiffFileDTO, DiffMode } from '@shipline/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api';
import { useDiffFile } from '@/services/local/local.hooks';

interface DiffFileViewProps {
  ticketId: string;
  mode: DiffMode;
  file: DiffFileDTO;
}

/** Unified diff of one file, fetched when its row is expanded and kept fresh by query invalidation. */
export default function DiffFileView({ ticketId, mode, file }: DiffFileViewProps) {
  const [full, setFull] = useState(false);
  const { data, isPending, error } = useDiffFile(
    { ticketId, mode, path: file.path, oldPath: file.oldPath, full },
    true,
  );

  if (isPending) return <Skeleton className="m-2 h-16" />;
  if (error) {
    return (
      <Alert variant="destructive" className="m-2">
        <AlertDescription>{errorMessage(error)}</AlertDescription>
      </Alert>
    );
  }
  if (data.binary || file.binary) return <p className="px-3 py-2 text-xs text-muted-foreground">Binary file: no diff shown.</p>;
  if (data.hunks.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No textual changes (mode change or empty file).</p>;
  }

  return (
    <div className="overflow-x-auto border-t bg-background font-mono text-xs">
      {data.hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted px-3 py-1 text-muted-foreground">{h.header}</div>
          {h.lines.map((l, j) => (
            <div
              key={j}
              className={cn(
                'flex whitespace-pre',
                l.type === 'add' && 'bg-green-500/10',
                l.type === 'del' && 'bg-red-500/10',
              )}
            >
              <span className="w-10 shrink-0 px-1 text-right text-muted-foreground select-none">{l.oldNo ?? ''}</span>
              <span className="w-10 shrink-0 px-1 text-right text-muted-foreground select-none">{l.newNo ?? ''}</span>
              <span
                className={cn(
                  'w-4 shrink-0 text-center select-none',
                  l.type === 'add' && 'text-green-700 dark:text-green-400',
                  l.type === 'del' && 'text-red-700 dark:text-red-400',
                )}
              >
                {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
              </span>
              <span className="pr-3">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
      {data.truncated && (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground">Large diff truncated ({data.totalLines} lines).</span>
          <Button size="xs" variant="outline" onClick={() => setFull(true)}>
            Show full
          </Button>
        </div>
      )}
    </div>
  );
}
