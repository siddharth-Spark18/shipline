import { ChevronRightIcon, WrenchIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useIsMobile } from '@/hooks/use-mobile';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { parseQuestions } from '@/pages/chat/question-card';
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
const clip = (s: string) =>
  s.length > MAX ? `${s.slice(0, MAX)}\n... (${s.length - MAX} more characters)` : s;

/** The second line of a phone row: the call's own description (Bash has one), else the first line of its result. */
function detailOf(item: ToolItem): string {
  const input = item.input;
  if (typeof input === 'object' && input !== null) {
    const d = (input as Record<string, unknown>).description;
    if (typeof d === 'string' && d.trim()) return d.trim();
  }
  const first = item.result?.text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.trim();
}

const ANSWER_PAIR = /"([^"]*)"\s*=\s*"([^"]*)"/g;

/**
 * An answered AskUserQuestion as one line. The result text comes from Claude Code and is not documented; it has
 * looked like `User has answered your questions: "<question>"="<answer>". ...`. When no pair is found the result
 * text itself is shown, cut to fit.
 */
function QuestionRecord({ item }: { item: ToolItem }) {
  const qs = parseQuestions(item.input);
  const question = qs ? qs[0].header?.trim() || qs[0].question : 'Question';
  const text = item.result?.text.trim() ?? '';
  const skipped = item.outcome === 'denied' || (item.result?.isError ?? false);
  const answers = [...text.matchAll(ANSWER_PAIR)].map((m) => m[2]).filter(Boolean);
  let mark = '✓';
  let tail: string;
  if (!item.result) {
    mark = '?';
    tail = 'Waiting for your answer';
  } else if (skipped) {
    mark = '✕';
    tail = 'Skipped';
  } else if (answers.length > 0) tail = `You chose: ${answers.join(', ')}`;
  else tail = text.split('\n')[0] || 'Answered';
  return (
    <p className="flex min-w-0 gap-1.5 px-1 text-sm text-muted-foreground">
      <span aria-hidden>{mark}</span>
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{question}</span> — {tail}
      </span>
    </p>
  );
}

/** A collapsible tool call: name and one-line summary, then the input and the result. */
export function ToolCall({ item }: { item: ToolItem }) {
  if (item.name === 'AskUserQuestion') return <QuestionRecord item={item} />;
  return <PlainToolCall item={item} />;
}

function PlainToolCall({ item }: { item: ToolItem }) {
  const mobile = useIsMobile();
  const summary = inputSummary(item.name, item.input);
  const badges = (
    <>
      {item.outcome === 'blocked' && (
        <Badge variant="outline" className={TONE.blocked}>
          Blocked
        </Badge>
      )}
      {item.outcome === 'denied' && (
        <Badge variant="outline" className={TONE.denied}>
          Denied
        </Badge>
      )}
      {!item.outcome && item.result?.isError && (
        <Badge variant="outline" className={TONE.blocked}>
          Error
        </Badge>
      )}
      {!item.result && <Badge variant="outline">Running</Badge>}
    </>
  );
  const detail = mobile ? detailOf(item) : '';
  return (
    <Collapsible className="group rounded-lg border bg-card">
      <CollapsibleTrigger
        className={
          mobile
            ? 'flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-sm'
            : 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm'
        }
      >
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {mobile ? (
          <>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium">{item.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {summary}
                </span>
              </span>
              {detail && (
                <span className="truncate pl-5 text-xs text-muted-foreground">{detail}</span>
              )}
            </span>
            {badges}
          </>
        ) : (
          <>
            <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium">{item.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {summary}
            </span>
            {badges}
          </>
        )}
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
