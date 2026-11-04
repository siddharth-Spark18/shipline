import { cn } from 'cn';
import type { DiffHunk } from '@/lib/types';

/**
 * Renders parsed unified-diff hunks. Removed comment lines get a stronger highlight. Long lines
 * scroll sideways inside the box (the rows are as wide as their longest line, so the tint
 * covers the whole row), and the line-number gutter stays on the left while scrolling.
 */
export function DiffView({ hunks, className }: { hunks: DiffHunk[]; className?: string }) {
  if (hunks.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes.</p>;
  }
  return (
    <div
      className={cn(
        'min-w-0 max-w-full overflow-x-auto rounded-md border bg-card font-mono text-xs',
        className,
      )}
    >
      <div className="w-max min-w-full">
        {hunks.map((hunk, i) => (
          <div key={i}>
            <div className="sticky left-0 w-full bg-muted px-3 py-1 text-muted-foreground">
              {hunk.header}
            </div>
            {hunk.lines.map((line, j) => {
              const tint = cn(
                line.type === 'add' && 'bg-stage-done/15',
                line.type === 'del' && !line.comment && 'bg-enf-block/15',
                line.type === 'del' && line.comment && 'bg-enf-warn/25',
              );
              return (
                <div key={j} className={cn('flex', tint)}>
                  <span className={cn('sticky left-0 z-[1] flex shrink-0 bg-card')}>
                    <span className={cn('flex', tint)}>
                      <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                        {line.oldNo ?? ''}
                      </span>
                      <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                        {line.newNo ?? ''}
                      </span>
                      <span className="w-4 shrink-0 select-none text-center">
                        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                      </span>
                    </span>
                  </span>
                  <span className="pr-3 whitespace-pre">{line.text}</span>
                  {line.type === 'del' && line.comment && (
                    <span className="ml-auto shrink-0 pl-3 pr-2 font-sans whitespace-nowrap text-enf-warn select-none">
                      comment removed
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
