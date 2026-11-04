import { StageStatus } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STYLES: Record<StageStatus, string> = {
  PENDING: 'bg-muted text-muted-foreground',
  IN_PROGRESS: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  DONE: 'bg-green-500/15 text-green-700 dark:text-green-300',
  SKIPPED: 'bg-muted text-muted-foreground line-through',
};

export default function StageStatusBadge({ status, className }: { status: StageStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(STYLES[status], className)}>
      {status.replace('_', ' ')}
    </Badge>
  );
}
