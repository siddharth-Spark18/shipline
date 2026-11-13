import { useEffect, useState } from 'react';
import { SparklesIcon } from 'lucide-react';
import { toMs, type Item } from '@/pages/chat/timeline';

const COMMAND_CHARS = 40;

const field = (input: unknown, ...keys: string[]): string => {
  if (typeof input !== 'object' || input === null) return '';
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
};

/** What Claude is doing right now, from this turn's items (those after the last user message). */
export function activityOf(items: Item[]): string {
  let streaming = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') break;
    if (it.kind === 'text' && it.streaming && !it.streaming.done) streaming = true;
    if (it.kind !== 'tool' || it.result) continue;
    const path = field(it.input, 'file_path', 'notebook_path');
    switch (it.name) {
      case 'Bash':
        return `Running Bash: ${field(it.input, 'command').split('\n')[0].slice(0, COMMAND_CHARS)}`;
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
        return path ? `Editing ${path}` : `Using ${it.name}`;
      case 'Read':
        return path ? `Reading ${path}` : `Using ${it.name}`;
      case 'Grep':
      case 'Glob':
        return 'Searching';
      case 'Task':
      case 'Agent':
        return 'Running an agent';
      default:
        return `Using ${it.name}`;
    }
  }
  return streaming ? 'Writing…' : 'Thinking…';
}

/** `12s` under a minute, `1m 05s` after. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const start = toMs(since);
  if (Number.isNaN(start)) return null;
  return <span aria-hidden>· {formatElapsed((now - start) / 1000)}</span>;
}

/**
 * The last row of the message list while a turn runs: an animated mark, the current activity, the time since the
 * turn started and (on desktop) the Esc hint. Only the activity is announced, not every second.
 */
export function WorkingIndicator({
  items,
  busySince,
  mobile,
}: {
  items: Item[];
  busySince: string | null;
  mobile: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-sm text-muted-foreground">
      <SparklesIcon
        className="size-4 shrink-0 animate-pulse text-primary motion-reduce:animate-none"
        aria-hidden
      />
      <span role="status" aria-live="polite" className="min-w-0 truncate">
        {activityOf(items)}
      </span>
      {busySince && <Elapsed since={busySince} />}
      {!mobile && <span aria-hidden>· Esc to stop</span>}
    </div>
  );
}
