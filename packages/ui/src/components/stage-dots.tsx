import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import type { StageStatus, TaskStage } from '@/lib/types';

export const STATUS_LABEL: Record<StageStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  skipped: 'Skipped',
};

/**
 * One stage state as a dot. Colour is never the only cue: done is filled, in progress is
 * filled with a halo, pending is a ring, skipped is a dashed ring (--stage-* tokens).
 */
export function StageDot({
  status,
  className,
  title,
}: {
  status: StageStatus;
  className?: string;
  title?: string;
}) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={title}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        status === 'done' && 'bg-stage-done',
        status === 'in_progress' && 'bg-stage-progress ring-4 ring-stage-progress/25',
        status === 'pending' && 'border-2 border-stage-pending',
        status === 'skipped' && 'border-2 border-dashed border-stage-skipped',
        className,
      )}
    />
  );
}

/** A row of small dots, one per stage: the compact "where is this task" trail. */
export function StageTrail({
  stages,
  className,
}: {
  stages: TaskStage[];
  className?: string;
}) {
  return (
    <span className={cn('flex items-center gap-0.5', className)} aria-hidden>
      {stages.map((s) => (
        <span
          key={s.id}
          title={`${s.name}: ${STATUS_LABEL[s.status]}`}
          className={cn(
            'size-1.5 rounded-full',
            s.status === 'done' && 'bg-stage-done',
            s.status === 'in_progress' && 'bg-stage-progress',
            s.status === 'pending' && 'bg-stage-pending/40',
            s.status === 'skipped' && 'bg-stage-skipped/60',
          )}
        />
      ))}
    </span>
  );
}

const ENFORCEMENT_TONE: Record<string, string> = {
  guide: 'border-enf-guide/40 bg-enf-guide/10 text-enf-guide',
  warn: 'border-enf-warn/40 bg-enf-warn/10 text-enf-warn',
  block: 'border-enf-block/40 bg-enf-block/10 text-enf-block',
};

/** guide / warn / block as an outline Badge in the matching --enf-* colour. */
export function EnforcementBadge({
  enforcement,
  className,
}: {
  enforcement: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(ENFORCEMENT_TONE[enforcement], className)}>
      {enforcement}
    </Badge>
  );
}
