import { FileDiff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useDiff } from '@/services/local/local.hooks';

const SHOWN_FILES = 3;

interface ChangesSummaryCardProps {
  ticketId: string;
  /** Local service ready and the chat has a worktree. */
  enabled: boolean;
  /** Opens the right panel on the Changes tab (optionally with one file expanded). */
  onOpenChanges: (focusPath?: string) => void;
}

/** "N files changed +x -y": the way into the read-only diff panel from the chat. */
export default function ChangesSummaryCard({ ticketId, enabled, onOpenChanges }: ChangesSummaryCardProps) {
  const diff = useDiff(ticketId, 'branch', enabled);
  const data = diff.data;
  if (!data || data.files.length === 0) return null;

  return (
    <Card className="py-3">
      <CardContent className="space-y-2 px-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-medium">
            <FileDiff className="size-4 text-muted-foreground" />
            {data.files.length} file{data.files.length === 1 ? '' : 's'} changed{' '}
            <span className="text-green-700 dark:text-green-400">+{data.additions}</span>{' '}
            <span className="text-red-700 dark:text-red-400">-{data.deletions}</span>
          </span>
          <Button size="xs" variant="outline" onClick={() => onOpenChanges()}>
            Review changes
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {data.files.slice(0, SHOWN_FILES).map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onOpenChanges(f.path)}
              className="max-w-full cursor-pointer truncate rounded-lg border bg-card px-2 py-0.5 font-mono text-xs hover:bg-accent"
              title={f.path}
            >
              {f.path}
            </button>
          ))}
          {data.files.length > SHOWN_FILES && <span className="px-1 text-xs text-muted-foreground">+{data.files.length - SHOWN_FILES} more</span>}
        </div>
      </CardContent>
    </Card>
  );
}
