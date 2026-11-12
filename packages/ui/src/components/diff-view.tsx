import { useState } from 'react';
import { cn } from 'cn';
import { useIsMobile } from '@/hooks/use-mobile';
import type { DiffHunk } from '@/lib/types';

/**
 * Renders parsed unified-diff hunks. Removed comment lines get a stronger highlight. Long lines
 * scroll sideways inside the box (the rows are as wide as their longest line, so the tint
 * covers the whole row), and the line-number gutter stays on the left while scrolling.
 * On a phone a small Wrap toggle wraps the long lines instead.
 */
export function DiffView({ hunks, className }: { hunks: DiffHunk[]; className?: string }) {
  const mobile = useIsMobile();
  const [wrapped, setWrapped] = useState(false);
  const wrap = mobile && wrapped;
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
      {mobile && (
        <div className="sticky left-0 flex w-full justify-end border-b bg-card px-2 py-1">
          <button
            type="button"
            aria-pressed={wrapped}
            onClick={() => setWrapped((w) => !w)}
            className={cn(
              'flex h-7 items-center rounded-md border px-2 font-sans text-[11px] font-medium',
              wrapped
                ? 'border-primary/40 bg-accent text-accent-foreground'
                : 'text-muted-foreground',
            )}
          >
            Wrap
          </button>
        </div>
      )}
      <div className={wrap ? 'w-full' : 'w-max min-w-full'}>
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
                  <span
                    className={cn(
                      'pr-3',
                      wrap ? 'min-w-0 break-words whitespace-pre-wrap' : 'whitespace-pre',
                    )}
                  >
                    {line.text}
                  </span>
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
