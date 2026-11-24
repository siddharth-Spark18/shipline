import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ShieldQuestionIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import { LAST_MINUTE_MS } from '@/lib/notifications';
import type { PromptAnswer, PromptEvent } from '@/lib/types';
import { inputSummary, toMs } from '@/pages/chat/timeline';

/** Seconds left until `expiresAt`, ticking once a second. */
function useCountdown(expiresAt: number | string): number | null {
  const end = toMs(expiresAt);
  const left = () => (Number.isNaN(end) ? null : Math.max(0, Math.ceil((end - Date.now()) / 1000)));
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    setSecs(left());
    const t = setInterval(() => setSecs(left()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end]);
  return secs;
}

/** "Denied automatically in 12:34"; in the last minute it turns warning-coloured. */
export function Countdown({ expiresAt }: { expiresAt: number | string }) {
  const secs = useCountdown(expiresAt);
  if (secs === null) return null;
  if (secs === 0) return <span className="text-xs text-muted-foreground">Timing out...</span>;
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        secs * 1000 <= LAST_MINUTE_MS ? 'font-medium text-enf-warn' : 'text-muted-foreground',
      )}
      title="Denied automatically when the time runs out"
    >
      Denied automatically in {m}:{s}
    </span>
  );
}

/** Answers a prompt. The card disappears on success (and on `prompt-resolved` from the server). */
export function useAnswerPrompt(prompt: PromptEvent) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const remove = () =>
    queryClient.setQueryData<PromptEvent[]>(queryKeys.prompts, (old = []) =>
      old.filter((p) => p.id !== prompt.id),
    );

  const answer = async (body: PromptAnswer) => {
    setPending(true);
    try {
      await api.answerPrompt(prompt.id, body);
      if (body.decision === 'allow_repo' && prompt.rule)
        toast.success(`Always allowed in this repo: ${prompt.rule}`);
      remove();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not-found') {
        remove(); // already answered in another tab, or timed out
      } else {
        toast.error(e instanceof Error ? e.message : 'Could not send the answer.');
      }
    } finally {
      setPending(false);
    }
  };
  return { answer, pending };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const maxH = (tall?: boolean) => (tall ? 'max-h-[50svh]' : 'max-h-56');

function DiffPreview({
  oldText,
  newText,
  tall,
}: {
  oldText: string;
  newText: string;
  tall?: boolean;
}) {
  const lines = (t: string) => (t === '' ? [] : t.split('\n'));
  const rows = [
    ...lines(oldText).map((l) => ({ sign: '-', l })),
    ...lines(newText).map((l) => ({ sign: '+', l })),
  ].slice(0, 60);
  return (
    <pre className={cn('overflow-auto rounded bg-muted p-2 font-mono text-xs', maxH(tall))}>
      {rows.map((r, i) => (
        <div key={i} className={r.sign === '-' ? 'text-enf-block' : 'text-stage-done'}>
          {r.sign} {r.l}
        </div>
      ))}
    </pre>
  );
}

/**
 * A readable view of the call: the command for Bash, path and diff for Edit/Write, JSON otherwise.
 * `tall` lets it grow (the phone's detail sheet); the card keeps it short.
 */
export function InputPreview({
  tool,
  input,
  tall,
}: {
  tool: string;
  input: unknown;
  tall?: boolean;
}) {
  const i = rec(input);
  const box = cn(
    'overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap',
    maxH(tall),
  );
  if (tool === 'Bash' && typeof i.command === 'string') {
    return <pre className={box}>$ {i.command}</pre>;
  }
  const path = str(i.file_path) || str(i.notebook_path);
  if (path && tool === 'Edit') {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs">{path}</p>
        <DiffPreview oldText={str(i.old_string)} newText={str(i.new_string)} tall={tall} />
      </div>
    );
  }
  if (path && tool === 'MultiEdit' && Array.isArray(i.edits)) {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs">{path}</p>
        {i.edits.map((e, n) => (
          <DiffPreview
            key={n}
            oldText={str(rec(e).old_string)}
            newText={str(rec(e).new_string)}
            tall={tall}
          />
        ))}
      </div>
    );
  }
  if (path && tool === 'Write') {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs">{path}</p>
        <DiffPreview oldText="" newText={str(i.content)} tall={tall} />
      </div>
    );
  }
  let json: string;
  try {
    json = JSON.stringify(input, null, 2) ?? '';
  } catch {
    json = String(input);
  }
  return <pre className={box}>{json.length > 4000 ? `${json.slice(0, 4000)}\n...` : json}</pre>;
}

/** The one-line summary of a permission prompt: the tool and its command or file path (the phone's dock row). */
export function PermissionSummary({ prompt }: { prompt: PromptEvent }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col text-left">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldQuestionIcon className="size-4 shrink-0" aria-hidden />
        <span className="font-mono">{prompt.tool}</span>
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {inputSummary(prompt.tool, prompt.input)}
      </span>
    </span>
  );
}

const OPTION = 'h-auto min-h-8 w-full justify-start gap-2 py-1.5 text-left';
const OPTION_BIG = 'h-auto min-h-12 w-full justify-start gap-2 py-2 text-left text-base';

/**
 * The answers to one permission prompt, in the same order on the card and in the dock: Allow once (1), Allow for this
 * chat (2), Always allow in this repo (3), Deny (4, with an optional message for Claude). Options 2 and 3 show the exact
 * rule they would remember, and are left out when there is none (or, for 2, when this Claude Code cannot do it).
 * Keys, while this block has focus: 1-4, Enter = allow once, Esc = the deny message field; in the field Enter denies
 * and Esc goes back.
 */
export function PermissionActions({
  prompt,
  pending,
  answer,
}: {
  prompt: PromptEvent;
  pending: boolean;
  answer: (body: PromptAnswer) => Promise<void>;
}) {
  const mobile = useIsMobile();
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const rule = prompt.rule ?? null;
  const chatOk = prompt.allowForChat === true && rule !== null;
  const repoOk = rule !== null;
  const className = mobile ? OPTION_BIG : OPTION;
  const size = mobile ? 'lg' : 'default';

  useEffect(() => {
    if (denying) field.current?.focus();
  }, [denying]);

  const allowOnce = () => void answer({ decision: 'allow' });
  const allowChat = () => void answer({ decision: 'allow_chat' });
  const allowRepo = () => void answer({ decision: 'allow_repo' });
  const deny = () =>
    void answer({ decision: 'deny', ...(reason.trim() ? { message: reason } : {}) });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!pending) deny();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDenying(false);
        box.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (pending) return;
    if (e.key === '1') allowOnce();
    else if (e.key === '2' && chatOk) allowChat();
    else if (e.key === '3' && repoOk) allowRepo();
    else if (e.key === '4' || e.key === 'Escape') setDenying(true);
    // Enter on a focused button presses that button; on the block itself it is the first option.
    else if (e.key === 'Enter' && e.target === box.current) allowOnce();
    else return;
    e.preventDefault();
  };

  const number = (n: number) => (
    <span className="font-mono text-xs text-muted-foreground" aria-hidden>
      {n}
    </span>
  );
  const ruleText = (r: string) => (
    <code className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground" title={r}>
      {r}
    </code>
  );

  return (
    <div
      ref={box}
      tabIndex={-1}
      data-permission-actions=""
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Button size={size} className={className} disabled={pending} onClick={allowOnce}>
        {number(1)}
        Allow once
      </Button>
      {chatOk && rule && (
        <Button
          size={size}
          variant="outline"
          className={className}
          disabled={pending}
          onClick={allowChat}
        >
          {number(2)}
          Allow for this chat
          {ruleText(rule)}
        </Button>
      )}
      {repoOk && rule && (
        <Button
          size={size}
          variant="outline"
          className={className}
          disabled={pending}
          onClick={allowRepo}
        >
          {number(3)}
          Always allow in this repo
          {ruleText(rule)}
        </Button>
      )}
      {denying ? (
        <div className="flex items-center gap-2">
          <Input
            ref={field}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Tell Claude why, or what to do instead (optional)"
            aria-label="Message for Claude"
            className={mobile ? 'h-12' : undefined}
            disabled={pending}
          />
          <Button
            size={size}
            variant="outline"
            className={mobile ? 'h-12 shrink-0' : 'shrink-0'}
            disabled={pending}
            onClick={deny}
          >
            Deny
          </Button>
        </div>
      ) : (
        <Button
          size={size}
          variant="outline"
          className={className}
          disabled={pending}
          onClick={() => setDenying(true)}
        >
          {number(4)}
          Deny
        </Button>
      )}
    </div>
  );
}

/** A card for one permission prompt: the call, then the four answers. */
export function PermissionCard({ prompt }: { prompt: PromptEvent }) {
  const { answer, pending } = useAnswerPrompt(prompt);
  return (
    <Card className="ring-2 ring-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldQuestionIcon className="size-4" />
          Claude wants to use <span className="font-mono">{prompt.tool}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <InputPreview tool={prompt.tool} input={prompt.input} />
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">
        <PermissionActions prompt={prompt} pending={pending} answer={answer} />
        <span className="self-end">
          <Countdown expiresAt={prompt.expiresAt} />
        </span>
      </CardFooter>
    </Card>
  );
}
