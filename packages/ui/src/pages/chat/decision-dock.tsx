import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, MessageCircleQuestionIcon } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PromptEvent } from '@/lib/types';
import {
  Countdown,
  InputPreview,
  PermissionActions,
  PermissionSummary,
  useAnswerPrompt,
} from '@/pages/chat/permission-card';
import { QuestionCard, parseQuestions, type QuestionItem } from '@/pages/chat/question-card';
import { inputSummary } from '@/pages/chat/timeline';

function QuestionDock({
  prompt,
  questions,
  counter,
}: {
  prompt: PromptEvent;
  questions: QuestionItem[];
  counter: string | null;
}) {
  const first = questions[0];

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
      <QuestionCard prompt={prompt} questions={questions} bare />
    </>
  );
}

function ApprovalDock({ prompt, counter }: { prompt: PromptEvent; counter: string | null }) {
  const { answer, pending } = useAnswerPrompt(prompt);
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);

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
        aria-expanded={mobile ? undefined : open}
        onClick={() => setOpen(!open || mobile)}
      >
        <PermissionSummary prompt={prompt} />
        {!mobile && open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
      {!mobile && open && (
        <div className="min-w-0">
          <InputPreview tool={prompt.tool} input={prompt.input} tall />
        </div>
      )}
      <PermissionActions prompt={prompt} pending={pending} answer={answer} />
      <Sheet open={mobile && open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88svh] gap-0 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="p-0 pb-3 pr-10">
            <SheetTitle>
              Claude wants to use <span className="font-mono">{prompt.tool}</span>
            </SheetTitle>
            <SheetDescription className="sr-only">
              Allow this tool call once, for this chat or always in this repo, or deny it.
            </SheetDescription>
          </SheetHeader>
          <div className="mb-4 min-w-0">
            <InputPreview tool={prompt.tool} input={prompt.input} tall />
          </div>
          <PermissionActions prompt={prompt} pending={pending} answer={answer} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The place for a chat's waiting prompts, on desktop and phone: above the composer, so one is never out of sight.
 * Shows the oldest one (the cache keeps arrival order) with "1 of N" when more wait. Keyed by prompt, so the
 * sheet it opened (phone) goes away with the prompt (answered elsewhere, timed out) and the next one takes over.
 */
export function DecisionDock({ prompts }: { prompts: PromptEvent[] }) {
  const dock = useRef<HTMLDivElement>(null);
  const current = prompts[0];
  const currentId = current?.id;
  // A new prompt takes focus when it was in the composer or nowhere (so 1-4 / Enter / Esc work at once); anywhere
  // else (another field, a button) it is only announced.
  useEffect(() => {
    if (!currentId) return;
    const el = document.activeElement;
    if (el && el !== document.body && !el.closest('[data-composer]')) return;
    dock.current
      ?.querySelector<HTMLElement>('[data-permission-actions], [data-question-card]')
      ?.focus({ preventScroll: true });
  }, [currentId]);
  if (!current) return null;
  const counter = prompts.length > 1 ? `1 of ${prompts.length}` : null;
  const questions = current.tool === 'AskUserQuestion' ? parseQuestions(current.input) : null;
  return (
    <div
      ref={dock}
      role="region"
      aria-label="Waiting for your answer"
      className="flex max-h-[60svh] shrink-0 flex-col gap-2 overflow-y-auto rounded-xl border bg-card p-3 shadow-sm ring-2 ring-primary/40"
    >
      <div key={`alert-${current.id}`} role="alert" className="sr-only">
        {questions
          ? `Claude has a question: ${questions[0].header?.trim() || questions[0].question}`
          : `Claude wants to use ${current.tool}: ${inputSummary(current.tool, current.input)}`}
      </div>
      {questions ? (
        <QuestionDock key={current.id} prompt={current} questions={questions} counter={counter} />
      ) : (
        <ApprovalDock key={current.id} prompt={current} counter={counter} />
      )}
    </div>
  );
}
