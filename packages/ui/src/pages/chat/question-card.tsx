import { useState } from 'react';
import { MessageCircleQuestionIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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

/**
 * AskUserQuestion as choices, one block per question. A filled-in "Other" replaces the chosen
 * labels. The answer is `{ [question text]: label }`, multi-select labels joined by ", ".
 */
export function QuestionCard({ prompt, questions }: { prompt: PromptEvent; questions: QuestionItem[] }) {
  const { answer, pending } = useAnswerPrompt(prompt);
  const [sel, setSel] = useState<Record<string, Selection>>({});

  const get = (q: QuestionItem): Selection => sel[q.question] ?? { labels: [], other: '' };
  const valueOf = (q: QuestionItem) => get(q).other.trim() || get(q).labels.join(', ');
  const complete = questions.every((q) => valueOf(q) !== '');
  const set = (q: QuestionItem, next: Selection) => setSel((s) => ({ ...s, [q.question]: next }));

  const submit = () =>
    void answer({
      decision: 'allow',
      answers: Object.fromEntries(questions.map((q) => [q.question, valueOf(q)])),
    });

  return (
    <Card className="ring-2 ring-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageCircleQuestionIcon className="size-4" />
          Claude has {questions.length === 1 ? 'a question' : 'some questions'}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {questions.map((q, qi) => {
          const s = get(q);
          const name = `q${qi}-${prompt.id}`;
          return (
            <fieldset key={q.question} className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">
                {q.header && <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">{q.header}</span>}
                {q.question}
              </legend>
              {q.multiSelect ? (
                q.options.map((o, oi) => (
                  <div key={o.label} className="flex items-start gap-2">
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
                    <Label htmlFor={`${name}-${oi}`} className="flex flex-col items-start gap-0">
                      {o.label}
                      {o.description && (
                        <span className="text-xs font-normal text-muted-foreground">{o.description}</span>
                      )}
                    </Label>
                  </div>
                ))
              ) : (
                <RadioGroup
                  value={s.other.trim() ? '' : (s.labels[0] ?? '')}
                  onValueChange={(v) => set(q, { labels: [v], other: '' })}
                >
                  {q.options.map((o, oi) => (
                    <div key={o.label} className="flex items-start gap-2">
                      <RadioGroupItem value={o.label} id={`${name}-${oi}`} />
                      <Label htmlFor={`${name}-${oi}`} className="flex flex-col items-start gap-0">
                        {o.label}
                        {o.description && (
                          <span className="text-xs font-normal text-muted-foreground">{o.description}</span>
                        )}
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
                aria-label={`Other answer for: ${q.question}`}
              />
            </fieldset>
          );
        })}
      </CardContent>
      <CardFooter className="flex items-center gap-2">
        <Button size="sm" disabled={pending || !complete} onClick={submit}>
          Send answer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void answer({ decision: 'deny' })}
        >
          Skip
        </Button>
        <span className="ml-auto">
          <Countdown expiresAt={prompt.expiresAt} />
        </span>
      </CardFooter>
    </Card>
  );
}
