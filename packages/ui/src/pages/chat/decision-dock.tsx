import { useState } from 'react';
import { ChevronUpIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { PromptEvent } from '@/lib/types';
import {
  Countdown,
  InputPreview,
  PermissionSummary,
  useAnswerPrompt,
} from '@/pages/chat/permission-card';
import { QuestionCard, parseQuestions, type QuestionItem } from '@/pages/chat/question-card';

/** A single-choice question with 2 to 4 options is answered by one tap on its option; anything else opens the sheet. */
const isSimple = (qs: QuestionItem[]) =>
  qs.length === 1 && !qs[0].multiSelect && qs[0].options.length >= 2 && qs[0].options.length <= 4;

const BIG = 'h-auto min-h-14 flex-1 py-2 text-base';

function AllowDeny({
  pending,
  onAllow,
  onDeny,
}: {
  pending: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="outline" size="lg" className={BIG} disabled={pending} onClick={onDeny}>
        Deny
      </Button>
      <Button size="lg" className={BIG} disabled={pending} onClick={onAllow}>
        Allow
      </Button>
    </div>
  );
}

function QuestionDock({
  prompt,
  questions,
  counter,
}: {
  prompt: PromptEvent;
  questions: QuestionItem[];
  counter: string | null;
}) {
  const { answer, pending } = useAnswerPrompt(prompt);
  const [open, setOpen] = useState(false);
  const first = questions[0];
  const simple = isSimple(questions);

  return (
    <>
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestionIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {first.header?.trim() ||
            (questions.length > 1 ? `${questions.length} questions` : 'Claude has a question')}
        </span>
        {counter && <span className="text-xs font-normal text-muted-foreground">{counter}</span>}
        <Countdown expiresAt={prompt.expiresAt} />
      </div>
      <p className="line-clamp-3 text-sm">{first.question}</p>
      {simple ? (
        <>
          <div className={first.options.length === 2 ? 'flex gap-2' : 'flex flex-col gap-2'}>
            {first.options.map((o) => (
              <Button
                key={o.label}
                variant="outline"
                size="lg"
                className={`${BIG} flex-col gap-0.5 whitespace-normal`}
                disabled={pending}
                onClick={() =>
                  void answer({ decision: 'allow', answers: { [first.question]: o.label } })
                }
              >
                <span>{o.label}</span>
                {o.description && (
                  <span className="text-xs font-normal text-muted-foreground">{o.description}</span>
                )}
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            className="h-11 self-center text-xs text-muted-foreground"
            onClick={() => setOpen(true)}
          >
            Details, other answer or skip
            <ChevronUpIcon />
          </Button>
        </>
      ) : (
        <Button size="lg" className="h-14 w-full text-base" onClick={() => setOpen(true)}>
          Answer
        </Button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88svh] gap-0 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="p-0 pb-3 pr-10">
            <SheetTitle>
              {questions.length > 1 ? 'Claude has some questions' : 'Claude has a question'}
            </SheetTitle>
            <SheetDescription className="sr-only">Answer the question for Claude.</SheetDescription>
          </SheetHeader>
          <QuestionCard prompt={prompt} questions={questions} bare />
        </SheetContent>
      </Sheet>
    </>
  );
}

function ApprovalDock({ prompt, counter }: { prompt: PromptEvent; counter: string | null }) {
  const { answer, pending } = useAnswerPrompt(prompt);
  const [open, setOpen] = useState(false);
  const allow = () => void answer({ decision: 'allow' });
  const deny = () => void answer({ decision: 'deny' });

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">Claude wants to use a tool</span>
        {counter && <span>{counter}</span>}
        <Countdown expiresAt={prompt.expiresAt} />
      </div>
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 rounded-md text-left"
        aria-label={`Show the full ${prompt.tool} request`}
        onClick={() => setOpen(true)}
      >
        <PermissionSummary prompt={prompt} />
        <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      <AllowDeny pending={pending} onAllow={allow} onDeny={deny} />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88svh] gap-0 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="p-0 pb-3 pr-10">
            <SheetTitle>
              Claude wants to use <span className="font-mono">{prompt.tool}</span>
            </SheetTitle>
            <SheetDescription className="sr-only">Allow or deny this tool call.</SheetDescription>
          </SheetHeader>
          <div className="mb-4 min-w-0">
            <InputPreview tool={prompt.tool} input={prompt.input} tall />
          </div>
          <AllowDeny pending={pending} onAllow={allow} onDeny={deny} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The phone's place for a chat's waiting prompts: above the composer, so one is never out of sight.
 * Shows the oldest one (the cache keeps arrival order) with "1 of N" when more wait. Keyed by prompt, so the
 * sheet it opened goes away with the prompt (answered elsewhere, timed out) and the next one takes over.
 */
export function DecisionDock({ prompts }: { prompts: PromptEvent[] }) {
  const current = prompts[0];
  if (!current) return null;
  const counter = prompts.length > 1 ? `1 of ${prompts.length}` : null;
  const questions = current.tool === 'AskUserQuestion' ? parseQuestions(current.input) : null;
  return (
    <div
      role="region"
      aria-label="Waiting for your answer"
      className="flex shrink-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm ring-2 ring-primary/40"
    >
      {questions ? (
        <QuestionDock key={current.id} prompt={current} questions={questions} counter={counter} />
      ) : (
        <ApprovalDock key={current.id} prompt={current} counter={counter} />
      )}
    </div>
  );
}
