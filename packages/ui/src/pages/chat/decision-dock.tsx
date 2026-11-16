import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  PermissionSummary,
  useAnswerPrompt,
} from '@/pages/chat/permission-card';
import { QuestionCard, parseQuestions, type QuestionItem } from '@/pages/chat/question-card';

// The phone's big touch targets; the desktop dock uses normal buttons.
const BIG = 'h-auto min-h-14 flex-1 py-2 text-base';
const NORMAL = 'h-auto min-h-8 flex-1 py-1.5';

function AllowDeny({
  pending,
  mobile,
  onAllow,
  onDeny,
}: {
  pending: boolean;
  mobile: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const className = mobile ? BIG : NORMAL;
  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        size={mobile ? 'lg' : 'default'}
        className={className}
        disabled={pending}
        onClick={onDeny}
      >
        Deny
      </Button>
      <Button
        size={mobile ? 'lg' : 'default'}
        className={className}
        disabled={pending}
        onClick={onAllow}
      >
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
      <AllowDeny pending={pending} mobile={mobile} onAllow={allow} onDeny={deny} />
      <Sheet open={mobile && open} onOpenChange={setOpen}>
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
          <AllowDeny pending={pending} mobile onAllow={allow} onDeny={deny} />
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
  const current = prompts[0];
  if (!current) return null;
  const counter = prompts.length > 1 ? `1 of ${prompts.length}` : null;
  const questions = current.tool === 'AskUserQuestion' ? parseQuestions(current.input) : null;
  return (
    <div
      role="region"
      aria-label="Waiting for your answer"
      className="flex max-h-[60svh] shrink-0 flex-col gap-2 overflow-y-auto rounded-xl border bg-card p-3 shadow-sm ring-2 ring-primary/40"
    >
      {questions ? (
        <QuestionDock key={current.id} prompt={current} questions={questions} counter={counter} />
      ) : (
        <ApprovalDock key={current.id} prompt={current} counter={counter} />
      )}
    </div>
  );
}
