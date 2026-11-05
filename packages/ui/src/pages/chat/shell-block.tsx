import { useEffect, useRef, useState } from 'react';
import { SendIcon, SquareIcon, TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import type { Item } from '@/pages/chat/timeline';

type ShellItem = Extract<Item, { kind: 'shell' }>;

const SEND_LINES = 200;
// Colour and cursor escapes: the block shows plain text, and Claude should not get them either.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
const plain = (s: string) => s.replace(ANSI, '');

function duration(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The message "Send to Claude" sends: the command, its exit and the last 200 lines of output. */
export function formatShellMessage(item: ShellItem): string {
  const lines = plain(item.output).replace(/\n+$/, '').split('\n');
  const left = Math.max(0, lines.length - SEND_LINES);
  const kept = left > 0 ? lines.slice(left) : lines;
  const body = [left > 0 ? `[${left} earlier lines left out]` : null, ...kept]
    .filter((l) => l !== null)
    .join('\n');
  const exit = item.code != null ? `exit ${item.code}` : `signal ${item.signal ?? 'unknown'}`;
  return `Output of \`${item.command}\` (${exit}):\n\`\`\`\n${body}\n\`\`\``;
}

/** A `!` command: terminal-style output with Stop while it runs and Send to Claude after. */
export function ShellBlock({
  item,
  chatId,
  busy,
  ended,
  onSendToClaude,
}: {
  item: ShellItem;
  chatId: string;
  busy: boolean;
  ended: boolean;
  onSendToClaude: (text: string) => Promise<boolean>;
}) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [item.output]);

  const stop = async () => {
    setStopping(true);
    try {
      await api.stopShell(chatId, item.id);
    } catch (e) {
      // 404: it finished in the meantime, and the exit event is on its way.
      if (!(e instanceof ApiError && e.status === 404)) {
        toast.error(e instanceof ApiError ? e.message : 'Could not stop the command.');
      }
    } finally {
      setStopping(false);
    }
  };

  const sendToClaude = async () => {
    setSending(true);
    try {
      await onSendToClaude(formatShellMessage(item));
    } finally {
      setSending(false);
    }
  };

  const failed = !item.running && (item.code ?? 1) !== 0;
  const sendLabel = ended ? 'chat ended' : busy ? 'Claude is working' : 'Send to Claude';

  return (
    <div className="overflow-hidden rounded-md border bg-muted/50 text-sm">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={item.command}>
          $ {item.command}
        </code>
        {item.running && (
          <Button variant="outline" size="xs" disabled={stopping} onClick={() => void stop()}>
            <SquareIcon />
            Stop
          </Button>
        )}
      </div>
      <pre
        ref={box}
        className="max-h-64 min-h-8 overflow-auto px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        aria-live="off"
      >
        {plain(item.output) || (item.running ? '' : '(no output)')}
      </pre>
      {item.truncated && (
        <p className="border-t px-3 py-1 text-xs text-muted-foreground">
          output truncated after 1 MB
        </p>
      )}
      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs">
        {item.running ? (
          <span className="flex-1 text-muted-foreground">Running...</span>
        ) : (
          <span className={failed ? 'flex-1 text-destructive' : 'flex-1 text-muted-foreground'}>
            {item.code != null ? `exit ${item.code}` : `stopped (${item.signal ?? 'signal'})`}
            {item.durationMs !== undefined && ` in ${duration(item.durationMs)}`}
          </span>
        )}
        <Button
          variant="outline"
          size="xs"
          disabled={item.running || busy || ended || sending}
          onClick={() => void sendToClaude()}
        >
          <SendIcon />
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}
