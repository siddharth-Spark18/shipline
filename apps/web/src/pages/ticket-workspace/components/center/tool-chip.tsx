import { Ban } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Short label for a tool call: the file, command, key or pattern it targets. */
export function toolTarget(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'command', 'pattern', 'path', 'url', 'key', 'query', 'description']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return null;
}

const basename = (p: string): string => p.split('/').pop() || p;

/** "Edit StreakBadge.tsx", "Run pnpm typecheck", "Read lesson-page.tsx": what the chip says. */
export function chipLabel(name: string, input: Record<string, unknown>): string {
  const target = toolTarget(input);
  const tool = name.replace(/^mcp__shipline__/, 'shipline:');
  if (!target) return tool;
  if (name === 'Bash') return `Run ${target}`;
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return `${tool === 'MultiEdit' ? 'Edit' : tool} ${basename(target)}`;
  return `${tool} ${target}`;
}

interface ToolChipProps {
  label: string;
  title?: string;
  /** Set when policy denied the call (e.g. "Designers can't edit code"): the chip turns destructive. */
  denied?: string;
}

/** Compact chip for one tool call. A denied call shows the reason on the chip itself. */
export default function ToolChip({ label, title, denied }: ToolChipProps) {
  return (
    <span
      title={denied ? `${title ?? label}\nDenied: ${denied}` : (title ?? label)}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card px-2 py-0.5 text-xs',
        denied && 'border-destructive text-destructive',
      )}
    >
      {denied && <Ban className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
      {denied && <span className="shrink-0">&middot; Denied: {denied}</span>}
    </span>
  );
}
