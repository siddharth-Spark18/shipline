import { ChevronRightIcon, WrenchIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { inputSummary, type Item } from '@/pages/chat/timeline';

type ToolItem = Extract<Item, { kind: 'tool' }>;

const TONE = {
  blocked: 'border-notice-blocked/40 bg-notice-blocked/10 text-notice-blocked',
  denied: 'border-notice-denied/40 bg-notice-denied/10 text-notice-denied',
};

function pretty(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
}

const MAX = 4000;
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n... (${s.length - MAX} more characters)` : s);

/** A collapsible tool call: name and one-line summary, then the input and the result. */
export function ToolCall({ item }: { item: ToolItem }) {
  const summary = inputSummary(item.name, item.input);
  return (
    <Collapsible className="group rounded-lg border bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summary}</span>
        {item.outcome === 'blocked' && <Badge variant="outline" className={TONE.blocked}>Blocked</Badge>}
        {item.outcome === 'denied' && <Badge variant="outline" className={TONE.denied}>Denied</Badge>}
        {!item.outcome && item.result?.isError && <Badge variant="outline" className={TONE.blocked}>Error</Badge>}
        {!item.result && <Badge variant="outline">Running</Badge>}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t px-3 py-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Input</p>
          <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {clip(pretty(item.input))}
          </pre>
        </div>
        {item.result && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Result</p>
            <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {clip(item.result.text) || '(empty)'}
            </pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
