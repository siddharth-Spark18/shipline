import { cn } from 'cn';
import type { DiffHunk } from '@/lib/types';

/** Renders parsed unified-diff hunks. Removed comment lines get a stronger highlight. */
export function DiffView({ hunks, className }: { hunks: DiffHunk[]; className?: string }) {
  if (hunks.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes.</p>;
  }
  return (
    <div className={cn('overflow-x-auto rounded-md border bg-card font-mono text-xs', className)}>
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="bg-muted px-3 py-1 text-muted-foreground">{hunk.header}</div>
          {hunk.lines.map((line, j) => (
            <div
              key={j}
              className={cn(
                'flex whitespace-pre',
                line.type === 'add' && 'bg-stage-done/15',
                line.type === 'del' && !line.comment && 'bg-enf-block/15',
                line.type === 'del' && line.comment && 'bg-enf-warn/25',
              )}
            >
              <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                {line.oldNo ?? ''}
              </span>
              <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                {line.newNo ?? ''}
              </span>
              <span className="w-4 shrink-0 select-none text-center">
                {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
              </span>
              <span className="pr-3">{line.text}</span>
              {line.type === 'del' && line.comment && (
                <span className="ml-auto shrink-0 select-none pr-2 font-sans text-enf-warn">
                  comment removed
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
