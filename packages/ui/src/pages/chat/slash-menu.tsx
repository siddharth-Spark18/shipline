import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import type { ChatCommand } from '@/lib/types';

const SOURCE_LABEL: Record<ChatCommand['source'], string> = {
  repo: 'repo',
  user: 'user',
  builtin: 'built-in',
};

/** The command list, fetched each time the menu opens so new files show up. */
export function useSlashCommands(
  open: boolean,
  chatId?: string | null,
): {
  commands: ChatCommand[];
  loading: boolean;
  error: boolean;
} {
  const [state, setState] = useState<{ commands: ChatCommand[]; loading: boolean; error: boolean }>(
    { commands: [], loading: false, error: false },
  );
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    api
      .listCommands(chatId)
      .then((r) => {
        if (!cancelled) setState({ commands: r.commands, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ commands: [], loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [open, chatId]);
  return state;
}

/** Prefix matches first, then substring matches; each group keeps the server's order. */
export function filterCommands(commands: ChatCommand[], query: string): ChatCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const prefix: ChatCommand[] = [];
  const inside: ChatCommand[] = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(c);
    else if (n.includes(q)) inside.push(c);
  }
  return [...prefix, ...inside];
}

/**
 * The list above the composer. Keyboard handling lives in the composer (focus stays in the box);
 * this only draws the entries and handles clicks.
 */
export function SlashMenu({
  items,
  index,
  loading,
  error,
  onPick,
  onHover,
}: {
  items: ChatCommand[];
  index: number;
  loading: boolean;
  error: boolean;
  onPick: (c: ChatCommand) => void;
  onHover: (i: number) => void;
}) {
  const active = useRef<HTMLLIElement>(null);
  useEffect(() => {
    active.current?.scrollIntoView({ block: 'nearest' });
  }, [index, items]);

  const empty = items.length === 0;
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
      {empty ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          {loading
            ? 'Loading commands...'
            : error
              ? 'Could not load commands. You can still send it as typed.'
              : 'No matching commands. It will be sent as typed.'}
        </p>
      ) : (
        <ul role="listbox" aria-label="Commands" className="py-1">
          {items.map((c, i) => (
            <li
              key={`${c.source}:${c.name}`}
              ref={i === index ? active : undefined}
              role="option"
              aria-selected={i === index}
              // mousedown, not click: the box must keep focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c);
              }}
              onMouseMove={() => i !== index && onHover(i)}
              className={cn(
                'flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm',
                i === index && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="shrink-0 font-mono">/{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {c.description}
              </span>
              <Badge variant="outline" className="shrink-0">
                {c.kind === 'skill' ? `skill, ${SOURCE_LABEL[c.source]}` : SOURCE_LABEL[c.source]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
