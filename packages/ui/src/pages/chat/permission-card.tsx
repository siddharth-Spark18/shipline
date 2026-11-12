import { useEffect, useState } from 'react';
import { ShieldQuestionIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { queryKeys } from '@/lib/events';
import type { PromptAnswer, PromptEvent } from '@/lib/types';
import { chatStore } from '@/pages/chat/chat-store';
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

export function Countdown({ expiresAt }: { expiresAt: number | string }) {
  const secs = useCountdown(expiresAt);
  if (secs === null) return null;
  if (secs === 0) return <span className="text-xs text-muted-foreground">Timing out...</span>;
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  return (
    <span
      className="text-xs text-muted-foreground tabular-nums"
      title="Denied automatically when the time runs out"
    >
      Denied in {m}:{s}
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
      if (body.decision === 'deny') chatStore.recordDenied(prompt.chatId, prompt.tool);
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

/** An Allow/Deny card for one permission prompt. */
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
      <CardFooter className="flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => void answer({ decision: 'allow' })}>
          Allow
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void answer({ decision: 'deny' })}
        >
          Deny
        </Button>
        <span className="ml-auto">
          <Countdown expiresAt={prompt.expiresAt} />
        </span>
      </CardFooter>
    </Card>
  );
}
