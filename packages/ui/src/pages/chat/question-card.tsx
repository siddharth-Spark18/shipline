import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PromptEvent } from '@/lib/types';
import { Countdown, useAnswerPrompt } from '@/pages/chat/permission-card';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** The AskUserQuestion input's questions, or null when the input is not in the expected shape. */
export function parseQuestions(input: unknown): QuestionItem[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: QuestionItem[] = [];
  for (const q of qs) {
    if (typeof q !== 'object' || q === null) return null;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string') return null;
    const options = Array.isArray(r.options)
      ? r.options
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .filter((o) => typeof o.label === 'string')
          .map((o) => ({
            label: o.label as string,
            description: typeof o.description === 'string' ? o.description : undefined,
          }))
      : [];
    out.push({
      question: r.question,
      header: typeof r.header === 'string' ? r.header : undefined,
      options,
      multiSelect: r.multiSelect === true,
    });
  }
  return out;
}

interface Selection {
  labels: string[];
  other: string;
}

const tabLabel = (q: QuestionItem, i: number) => q.header?.trim() || `Q${i + 1}`;

/**
 * AskUserQuestion as tabs: one per question (labelled by its header, or Q1, Q2...) and, with more
 * than one question, a final Submit tab that lists the answers and has the Send button. A single
 * question has no tab bar. Keys: left/right switch tabs, 1-9 pick an option, Enter goes to the
 * next tab or submits. A filled-in "Other" replaces the chosen labels. The answer is
 * `{ [question text]: label }`, multi-select labels joined by ", ".
 *
 * `bare` drops the card shell (frame, title, countdown) so the phone's bottom sheet can hold the same
 * question body and buttons; on a phone the options and buttons get larger touch targets.
 */
export function QuestionCard({
  prompt,
  questions,
  bare = false,
}: {
  prompt: PromptEvent;
  questions: QuestionItem[];
  bare?: boolean;
}) {
  const { answer, pending } = useAnswerPrompt(prompt);
  const mobile = useIsMobile();
  const btn = mobile ? 'h-11 px-4 text-sm' : '';
  const [sel, setSel] = useState<Record<string, Selection>>({});
  const n = questions.length;
  const multi = n > 1;
  /** 0..n-1 are the questions; n is the Submit tab (only when there is more than one question). */
  const [tab, setTab] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const get = (q: QuestionItem): Selection => sel[q.question] ?? { labels: [], other: '' };
  const valueOf = (q: QuestionItem) => get(q).other.trim() || get(q).labels.join(', ');
  const complete = questions.every((q) => valueOf(q) !== '');
  const set = (q: QuestionItem, next: Selection) => setSel((s) => ({ ...s, [q.question]: next }));
  const onSubmitTab = multi && tab === n;

  const goto = (t: number) => setTab(Math.max(0, Math.min(multi ? n : 0, t)));
  const next = () => goto(tab + 1);

  const submit = () =>
    void answer({
      decision: 'allow',
      answers: Object.fromEntries(questions.map((q) => [q.question, valueOf(q)])),
    });

  // Keys go to the card, so it takes focus when it appears (unless the user is typing elsewhere).
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    box.current?.focus({ preventScroll: true });
  }, []);
  // Switching tabs can unmount the focused option; keep the keys working.
  useEffect(() => {
    const el = document.activeElement;
    if (!el || el === document.body) box.current?.focus({ preventScroll: true });
  }, [tab]);

  const pick = (q: QuestionItem, label: string) => {
    const s = get(q);
    if (q.multiSelect) {
      set(q, {
        other: '',
        labels: s.labels.includes(label)
          ? s.labels.filter((l) => l !== label)
          : [...s.labels, label],
      });
    } else {
      set(q, { labels: [label], other: '' });
      if (multi) next();
    }
  };

  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target as HTMLElement;
    if (!multi || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    // Handled here, before Radix moves a radio or a tab on its own.
    e.preventDefault();
    e.stopPropagation();
    goto(tab + (e.key === 'ArrowRight' ? 1 : -1));
    box.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const role = t.getAttribute('role');
    if (/^[1-9]$/.test(e.key) && !typing) {
      const q = questions[tab];
      const o = q?.options[Number(e.key) - 1];
      if (q && o) {
        e.preventDefault();
        pick(q, o.label);
      }
      return;
    }
    if (e.key === 'Enter') {
      // A focused button (Skip, Send, Next) does its own thing on Enter.
      if (
        t instanceof HTMLButtonElement &&
        role !== 'radio' &&
        role !== 'tab' &&
        role !== 'checkbox'
      )
        return;
      if (pending) return;
      e.preventDefault();
      if (!multi || onSubmitTab) {
        if (complete) submit();
      } else if (valueOf(questions[tab]) !== '') next();
    }
  };

  const questionBody = (q: QuestionItem, qi: number) => {
    const s = get(q);
    const name = `q${qi}-${prompt.id}`;
    const optionLabel = (o: (typeof q.options)[number], oi: number) => (
      <>
        <span>
          {oi < 9 && (
            <span className="mr-1.5 font-mono text-xs text-muted-foreground">{oi + 1}</span>
          )}
          {o.label}
        </span>
        {o.description && (
          <span className="text-xs font-normal text-muted-foreground">{o.description}</span>
        )}
      </>
    );
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{q.question}</legend>
        {q.multiSelect ? (
          q.options.map((o, oi) => (
            <div
              key={o.label}
              className={cn('flex items-start gap-2', mobile && 'min-h-11 items-center')}
            >
              <Checkbox
                id={`${name}-${oi}`}
                checked={s.labels.includes(o.label)}
                onCheckedChange={(on) =>
                  set(q, {
                    other: '',
                    labels: on ? [...s.labels, o.label] : s.labels.filter((l) => l !== o.label),
                  })
                }
              />
              <Label
                htmlFor={`${name}-${oi}`}
                className={cn('flex flex-col items-start gap-0', mobile && 'flex-1 py-2')}
              >
                {optionLabel(o, oi)}
              </Label>
            </div>
          ))
        ) : (
          <RadioGroup
            value={s.other.trim() ? '' : (s.labels[0] ?? '')}
            onValueChange={(v) => set(q, { labels: [v], other: '' })}
          >
            {q.options.map((o, oi) => (
              <div
                key={o.label}
                className={cn('flex items-start gap-2', mobile && 'min-h-11 items-center')}
              >
                {/* Moving on happens on click, not on selection, so arrow keys inside the group don't skip ahead. */}
                <RadioGroupItem
                  value={o.label}
                  id={`${name}-${oi}`}
                  onClick={() => multi && next()}
                />
                <Label
                  htmlFor={`${name}-${oi}`}
                  className={cn('flex flex-col items-start gap-0', mobile && 'flex-1 py-2')}
                >
                  {optionLabel(o, oi)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
        <Input
          value={s.other}
          onChange={(e) =>
            set(q, { other: e.target.value, labels: e.target.value.trim() ? [] : s.labels })
          }
          placeholder="Other (type your own answer)"
          className={cn(mobile && 'h-11')}
          aria-label={`Other answer for: ${q.question}`}
        />
        {multi && q.multiSelect && (
          <div>
            <Button size="sm" variant="outline" className={btn} onClick={next}>
              Next
            </Button>
          </div>
        )}
      </fieldset>
    );
  };

  const sendButton = (
    <Button size="sm" className={btn} disabled={pending || !complete} onClick={submit}>
      Send answer
    </Button>
  );

  const body = multi ? (
    <Tabs value={String(tab)} onValueChange={(v) => goto(Number(v))}>
      <TabsList variant="line" className="h-auto w-full flex-wrap justify-start border-b">
        {questions.map((q, i) => {
          const done = valueOf(q) !== '';
          return (
            <TabsTrigger
              key={i}
              value={String(i)}
              className={cn('flex-none px-3', mobile && 'min-h-11')}
            >
              {done ? (
                <CheckIcon className="text-stage-done" aria-hidden />
              ) : (
                <span className="size-1.5 rounded-full bg-enf-warn" aria-hidden />
              )}
              {tabLabel(q, i)}
              <span className="sr-only">{done ? ' (answered)' : ' (not answered)'}</span>
            </TabsTrigger>
          );
        })}
        <TabsTrigger value={String(n)} className={cn('flex-none px-3', mobile && 'min-h-11')}>
          Submit
        </TabsTrigger>
      </TabsList>
      {questions.map((q, i) => (
        <TabsContent key={i} value={String(i)} className="pt-2">
          {questionBody(q, i)}
        </TabsContent>
      ))}
      <TabsContent value={String(n)} className="pt-2">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Review your answers</p>
          <dl className="flex flex-col gap-2 text-sm">
            {questions.map((q, i) => {
              const v = valueOf(q);
              return (
                <div key={i} className="flex flex-col">
                  <dt className="text-xs text-muted-foreground">
                    {tabLabel(q, i)}: {q.question}
                  </dt>
                  <dd>
                    <button
                      type="button"
                      className={cn(
                        'text-left underline-offset-2 hover:underline',
                        mobile && 'min-h-11',
                        v === '' && 'text-enf-warn',
                      )}
                      onClick={() => goto(i)}
                    >
                      {v === '' ? 'Not answered' : v}
                    </button>
                  </dd>
                </div>
              );
            })}
          </dl>
          {!complete && (
            <p className="text-xs text-muted-foreground">Answer every question before sending.</p>
          )}
        </div>
      </TabsContent>
    </Tabs>
  ) : (
    questionBody(questions[0], 0)
  );

  const buttons = (
    <>
      {(!multi || onSubmitTab) && sendButton}
      <Button
        size="sm"
        variant="outline"
        className={btn}
        disabled={pending}
        onClick={() => void answer({ decision: 'deny' })}
      >
        Skip
      </Button>
    </>
  );

  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {bare ? (
        <div className="flex flex-col gap-4">
          {body}
          <div className="flex items-center gap-2">
            {buttons}
            <span className="ml-auto">
              <Countdown expiresAt={prompt.expiresAt} />
            </span>
          </div>
        </div>
      ) : (
        <Card className="ring-2 ring-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageCircleQuestionIcon className="size-4" />
              Claude has {multi ? 'some questions' : 'a question'}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">{body}</CardContent>
          <CardFooter className="flex items-center gap-2">
            {buttons}
            <span className="ml-auto">
              <Countdown expiresAt={prompt.expiresAt} />
            </span>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
