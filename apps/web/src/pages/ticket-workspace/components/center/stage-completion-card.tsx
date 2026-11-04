import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StageView, TicketDetail } from '@/services/tickets/tickets.types';

interface StageCompletionCardProps {
  ticket: TicketDetail;
  transition: { kind: 'complete' | 'skip' | 'reopen'; fromStageName: string };
  /** Name of the stage the chat moved to (null when everything is finished). */
  toStageName: string | null;
  onOpenArtifact: (stage: StageView) => void;
}

const stepClass: Record<StageView['status'], string> = {
  DONE: 'bg-primary text-primary-foreground',
  IN_PROGRESS: 'border border-primary bg-background font-semibold text-foreground',
  SKIPPED: 'bg-muted text-muted-foreground line-through',
  PENDING: 'bg-muted text-muted-foreground',
};

// OPEN-QUESTION: the stepper shows the chat's CURRENT progress, and only the newest completion card in
// the chat renders it (older stage changes collapse to thin markers).
/**
 * Inline card shown in the chat when a stage finishes: a compact stepper, the deliverable chip and
 * the next step. The stepper reflects the chat's current progress.
 */
export default function StageCompletionCard({ ticket, transition, toStageName, onOpenArtifact }: StageCompletionCardProps) {
  const from = ticket.stages.find((s) => s.name === transition.fromStageName);
  const deliverable = transition.kind === 'complete' && from && from.artifacts.length > 0 ? from : null;
  const title =
    transition.kind === 'complete'
      ? `${transition.fromStageName} complete`
      : transition.kind === 'skip'
        ? `${transition.fromStageName} skipped`
        : `Back to ${toStageName ?? 'an earlier stage'}`;
  const next = ticket.stages.find((s) => s.status === 'IN_PROGRESS');

  return (
    <Card className="bg-muted/50 py-3">
      <CardContent className="space-y-2 px-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <Check className="size-4 text-primary" /> {title}
        </div>
        <ol className="flex flex-wrap items-center gap-1" aria-label="Stages">
          {ticket.stages.map((s) => (
            <li key={s.key} className={cn('rounded-full px-2 py-0.5 text-[11px]', stepClass[s.status])}>
              {s.name}
              {s.status === 'SKIPPED' && ' (skipped)'}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {deliverable && (
            <Button variant="outline" size="xs" onClick={() => onOpenArtifact(deliverable)}>
              {deliverable.name} v{deliverable.artifacts[deliverable.artifacts.length - 1].version}
            </Button>
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowRight className="size-3" />
            {next ? `Next: ${next.name}${next.optional ? ' (optional)' : ''}` : 'All stages are finished'}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
