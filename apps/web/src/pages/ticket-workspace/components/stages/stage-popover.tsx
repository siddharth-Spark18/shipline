import { ComponentProps, ReactNode, forwardRef } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { TicketDetail, StageView } from '@/services/tickets/tickets.types';
import OverrideDialog from './override-dialog';
import PolicySummary from './policy-summary';
import { progressLabel, stageProgress } from './stage-progress';

function StageIcon({ status }: { status: StageView['status'] }) {
  if (status === 'DONE') {
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-2.5" />
      </span>
    );
  }
  if (status === 'IN_PROGRESS') return <span className="size-4 shrink-0 rounded-full border-2 border-primary" />;
  if (status === 'SKIPPED') return <span className="size-4 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/50" />;
  return <span className="size-4 shrink-0 rounded-full border-2 border-border" />;
}

const STATUS_TEXT: Record<StageView['status'], string> = {
  DONE: '',
  IN_PROGRESS: 'in progress',
  PENDING: '',
  SKIPPED: 'skipped',
};

interface StagePopoverProps {
  ticket: TicketDetail;
  /** The element that opens the popover: the header pill or the status bar item. */
  trigger: ReactNode;
  side?: 'top' | 'bottom';
  onOpenArtifact?: (stage: StageView) => void;
}

/** Every stage of the chat, on demand: opened from the header pill and from the status bar. */
export default function StagePopover({ ticket, trigger, side = 'bottom', onOpenArtifact }: StagePopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side={side} align="end" className="w-80 space-y-3">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold">Stages</p>
          <p
            className="text-xs text-muted-foreground"
            title="Chats stay on the template version they started on. Edits to the template apply to new chats."
          >
            {ticket.template.name} v{ticket.template.version}
            {ticket.template.latestVersion > ticket.template.version && ` (latest v${ticket.template.latestVersion})`}
            {ticket.template.archived && ' · archived'}
          </p>
        </div>
        <ol className="space-y-0.5">
          {ticket.stages.map((s) => {
            const latest = s.artifacts[s.artifacts.length - 1];
            const clickable = !!latest && !!onOpenArtifact;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => onOpenArtifact?.(s)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm',
                    clickable && 'cursor-pointer hover:bg-accent',
                    s.status === 'IN_PROGRESS' && 'font-semibold',
                  )}
                  aria-current={s.status === 'IN_PROGRESS' ? 'step' : undefined}
                >
                  <StageIcon status={s.status} />
                  <span className={cn(s.status === 'SKIPPED' && 'text-muted-foreground line-through')}>
                    {s.name}
                    {s.optional && s.status === 'PENDING' && <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>}
                    {s.reopenedCount > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">reopened x{s.reopenedCount}</span>}
                  </span>
                  <span className="ml-auto truncate text-xs font-normal text-muted-foreground">
                    {latest ? `${latest.type.toLowerCase().replace('_', ' ')} v${latest.version}` : STATUS_TEXT[s.status]}
                  </span>
                </button>
                {s.status === 'SKIPPED' && s.skippedReason && <p className="pl-8 text-xs text-muted-foreground">{s.skippedReason}</p>}
              </li>
            );
          })}
        </ol>
        <div className="space-y-1.5 border-t pt-2">
          <p className="text-xs font-medium text-muted-foreground">This stage</p>
          <PolicySummary stage={ticket.currentStage} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <Badge variant={ticket.gates.pass ? 'secondary' : 'outline'} title={ticket.gates.lines.join('\n')}>
            shipline/gates: {ticket.gates.pass ? (ticket.gates.overridden ? 'bypassed' : 'passing') : 'not satisfied'}
          </Badge>
          {ticket.myAccess.isAdmin && <OverrideDialog ticketId={ticket.id} />}
        </div>
        {ticket.overrides.map((o) => (
          <p key={o.id} className="text-xs text-destructive">
            {o.kind} override by {o.admin.name}: {o.reason}
          </p>
        ))}
      </PopoverContent>
    </Popover>
  );
}

type StagePillProps = { stages: TicketDetail['stages'] } & ComponentProps<'button'>;

/** The header pill ("Build · 4/8 v"). Forwards its ref and props so Radix can use it as the popover trigger. */
export const StagePill = forwardRef<HTMLButtonElement, StagePillProps>(function StagePill({ stages, className, ...props }, ref) {
  const label = progressLabel(stageProgress(stages));
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-primary-foreground',
        className,
      )}
    >
      {label}
      <ChevronDown className="size-3" />
    </button>
  );
});
