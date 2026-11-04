import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { AskUserQuestionAnswers, AskUserQuestionItem } from '@shipline/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QuestionCardProps {
  questions: AskUserQuestionItem[];
  submitting: boolean;
  onAnswer: (answers: AskUserQuestionAnswers) => void;
  onSkip: () => void;
}

interface Selection {
  labels: string[];
  /** Free-text "Other" answer; replaces the labels when filled in. */
  other: string;
}

const EMPTY: Selection = { labels: [], other: '' };

/**
 * Claude's AskUserQuestion call, laid out like Claude Code's own prompt: one question at a time
 * behind a tab per question header, then a Submit tab that reviews the answers. Single-choice
 * questions advance on click; 1-9 picks an option, ←/→ switch tabs, Enter sends from Submit.
 */
export default function QuestionCard({ questions, submitting, onAnswer, onSkip }: QuestionCardProps) {
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [tab, setTab] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);

  const single = questions.length === 1;
  const submitTab = questions.length; // index of the review tab (multi-question only)
  const onSubmitTab = !single && tab === submitTab;
  const q = onSubmitTab ? null : questions[tab];

  const get = (item: AskUserQuestionItem): Selection => selections[item.question] ?? EMPTY;
  const answerFor = (item: AskUserQuestionItem): string => {
    const s = get(item);
    return s.other.trim() || s.labels.join(', ');
  };
  const complete = questions.every((item) => answerFor(item) !== '');

  const submit = (next = selections) => {
    if (submitting) return;
    onAnswer(
      Object.fromEntries(
        questions.map((item) => {
          const s = next[item.question] ?? EMPTY;
          return [item.question, s.other.trim() || s.labels.join(', ')];
        }),
      ),
    );
  };

  const goTo = (i: number) => setTab(Math.max(0, Math.min(single ? 0 : submitTab, i)));

  const pick = (item: AskUserQuestionItem, label: string) => {
    const current = get(item);
    if (item.multiSelect) {
      const labels = current.labels.includes(label) ? current.labels.filter((l) => l !== label) : [...current.labels, label];
      setSelections((s) => ({ ...s, [item.question]: { labels, other: '' } }));
      return;
    }
    const next = { ...selections, [item.question]: { labels: [label], other: '' } };
    setSelections(next);
    // One single-choice question: the click is the answer, like Claude Code.
    if (single) submit(next);
    else goTo(tab + 1);
  };

  const setOther = (item: AskUserQuestionItem, other: string) =>
    setSelections((s) => ({ ...s, [item.question]: { labels: other.trim() ? [] : get(item).labels, other } }));

  // Keep keyboard focus on the card so the shortcuts work right after it appears / tabs change.
  useEffect(() => {
    if (document.activeElement !== otherInput.current) root.current?.focus({ preventScroll: true });
  }, [tab]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement) {
      if (e.key === 'Enter' && q) {
        e.preventDefault();
        if (single) {
          if (answerFor(q)) submit();
        } else goTo(tab + 1);
      }
      if (e.key === 'Escape') root.current?.focus();
      return;
    }
    if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey && !single)) {
      e.preventDefault();
      goTo(tab + 1);
    } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey && !single)) {
      e.preventDefault();
      goTo(tab - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if ((onSubmitTab || single) && complete) submit();
      else if (q && answerFor(q)) goTo(tab + 1);
    } else if (q && /^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (n <= q.options.length) pick(q, q.options[n - 1].label);
      else if (n === q.options.length + 1) otherInput.current?.focus();
    }
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="mx-4 mb-2 overflow-hidden rounded-lg border bg-card text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {!single && (
        <div className="flex items-center gap-1 overflow-x-auto border-b bg-muted/40 px-2 py-1.5" role="tablist">
          <button
            type="button"
            aria-label="Previous question"
            disabled={tab === 0}
            onClick={() => goTo(tab - 1)}
            className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          {questions.map((item, i) => {
            const answered = answerFor(item) !== '';
            return (
              <button
                key={item.question}
                type="button"
                role="tab"
                aria-selected={tab === i}
                onClick={() => goTo(i)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs whitespace-nowrap',
                  tab === i ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {answered ? <Check className="size-3 text-green-600" /> : <span className="size-1.5 rounded-full bg-muted-foreground/40" />}
                {item.header || `Q${i + 1}`}
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={onSubmitTab}
            onClick={() => goTo(submitTab)}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
              onSubmitTab ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Check className="size-3" /> Submit
          </button>
          <button
            type="button"
            aria-label="Next question"
            disabled={onSubmitTab}
            onClick={() => goTo(tab + 1)}
            className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}

      <div className="space-y-3 p-3">
        {q ? (
          <>
            <p className="leading-snug font-medium">
              {q.question}
              {q.multiSelect && <span className="ml-1.5 text-xs font-normal text-muted-foreground">choose any</span>}
            </p>
            <ol className="space-y-1">
              {q.options.map((o, i) => {
                const s = get(q);
                const checked = !s.other.trim() && s.labels.includes(o.label);
                return (
                  <li key={o.label}>
                    <button
                      type="button"
                      onClick={() => pick(q, o.label)}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent',
                        checked && 'bg-accent ring-1 ring-primary/40',
                      )}
                    >
                      <span className="mt-px w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="font-medium">{o.label}</span>
                        {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
                      </span>
                      {checked && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
                    </button>
                  </li>
                );
              })}
              <li className="flex items-center gap-2.5 px-2.5 py-1">
                <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{q.options.length + 1}.</span>
                <input
                  ref={otherInput}
                  value={get(q).other}
                  onChange={(e) => setOther(q, e.target.value)}
                  placeholder="Type something else…"
                  className="min-w-0 flex-1 border-b border-transparent bg-transparent py-0.5 outline-none placeholder:text-muted-foreground focus:border-border"
                />
              </li>
            </ol>
          </>
        ) : (
          <div className="space-y-1.5">
            <p className="font-medium">Review your answers</p>
            <dl className="space-y-1">
              {questions.map((item, i) => {
                const answer = answerFor(item);
                return (
                  <button
                    key={item.question}
                    type="button"
                    onClick={() => goTo(i)}
                    className="flex w-full gap-2 rounded-md px-2 py-1 text-left hover:bg-accent"
                  >
                    <dt className="w-28 shrink-0 truncate text-xs text-muted-foreground">{item.header || `Q${i + 1}`}</dt>
                    <dd className={cn('min-w-0 flex-1 text-xs', !answer && 'text-muted-foreground italic')}>{answer || 'Not answered'}</dd>
                  </button>
                );
              })}
            </dl>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <span className="text-[11px] text-muted-foreground">
            {single ? '1-9 to pick · Enter to send' : '1-9 to pick · ←/→ to move · Enter on Submit to send'}
          </span>
          <div className="flex gap-1.5">
            <Button size="xs" variant="ghost" disabled={submitting} onClick={onSkip}>
              Skip
            </Button>
            {(onSubmitTab || single) && (
              <Button size="xs" disabled={!complete || submitting} onClick={() => submit()}>
                {submitting && <Loader2 className="animate-spin" />}
                Send answers
              </Button>
            )}
            {!single && !onSubmitTab && (
              <Button size="xs" variant="outline" onClick={() => goTo(tab + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
