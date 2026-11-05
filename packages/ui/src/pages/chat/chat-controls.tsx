import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ChevronDownIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError, api } from '@/lib/api';
import { subscribeChat } from '@/lib/events';
import type {
  ChatControls as ChatControlsData,
  ContextUsage,
  EffortLevel,
  ModelOption,
  PermissionModeValue,
  PickedControls,
} from '@/lib/types';
import { useChatLive } from '@/pages/chat/chat-store';

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
// bypassPermissions and dontAsk are never offered. `manual` is what Claude Code calls `default`.
const MODES: { value: PermissionModeValue; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
];
// Shown until a chat in this repo has run and Claude has sent its real list.
const FALLBACK_MODELS: ModelOption[] = ['default', 'opus', 'sonnet', 'haiku'].map((value) => ({
  value,
  resolvedModel: null,
  displayName: value,
  description: '',
  supportsEffort: true,
  supportedEffortLevels: [],
  supportsAutoMode: true,
}));

const TRIGGER = 'h-6 gap-1 px-2 text-xs font-normal text-muted-foreground';
const MENU = 'w-auto min-w-48';
const fmt = (n: number) => n.toLocaleString('en-US');

const findModel = (models: ModelOption[], current: string | undefined) =>
  current ? models.find((m) => m.value === current || m.resolvedModel === current) : undefined;

const levelsFor = (model: ModelOption | undefined): EffortLevel[] =>
  model && model.supportedEffortLevels.length > 0 ? model.supportedEffortLevels : EFFORT_LEVELS;

/** The effort to use after a model change: the current one if the new model has it, else `high`, else its highest. */
function effortAfter(
  model: ModelOption,
  current: EffortLevel | undefined,
): EffortLevel | undefined {
  if (!model.supportsEffort) return undefined;
  const levels = levelsFor(model);
  if (current && levels.includes(current)) return current;
  return levels.includes('high') ? 'high' : levels[levels.length - 1];
}

function ContextRing({
  context,
  canCompact,
  onCompact,
}: {
  context: ContextUsage;
  canCompact: boolean;
  onCompact?: () => void;
}) {
  const auto = context.isAutoCompactEnabled && context.autoCompactThreshold > 0;
  const raw = auto
    ? (context.totalTokens / context.autoCompactThreshold) * 100
    : context.maxTokens > 0
      ? (context.totalTokens / context.maxTokens) * 100
      : 0;
  const pct = Math.round(raw);
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.min(100, Math.max(0, raw)) / 100) * circumference;
  const tip = auto ? `${pct}% of the way to auto-compact` : 'auto-compact off';
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className={cn(TRIGGER, 'ml-auto tabular-nums')}
              aria-label={`Context: ${tip}`}
            >
              <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden>
                <circle
                  cx="9"
                  cy="9"
                  r={r}
                  fill="none"
                  strokeWidth="2.5"
                  className="stroke-muted"
                />
                <circle
                  cx="9"
                  cy="9"
                  r={r}
                  fill="none"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${filled} ${circumference}`}
                  className={pct >= 90 ? 'stroke-destructive' : 'stroke-foreground'}
                />
              </svg>
              {pct}%
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className={MENU}>
        <DropdownMenuLabel>Context</DropdownMenuLabel>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 px-2 pb-1 text-xs">
          <dt className="text-muted-foreground">Used</dt>
          <dd className="text-right tabular-nums">{fmt(context.totalTokens)} tokens</dd>
          <dt className="text-muted-foreground">Auto-compact at</dt>
          <dd className="text-right tabular-nums">
            {context.isAutoCompactEnabled ? `${fmt(context.autoCompactThreshold)} tokens` : 'off'}
          </dd>
          <dt className="text-muted-foreground">Window</dt>
          <dd className="text-right tabular-nums">{fmt(context.maxTokens)} tokens</dd>
        </dl>
        {context.categories.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Largest</DropdownMenuLabel>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 px-2 pb-1 text-xs">
              {context.categories.map((c) => (
                <div key={c.name} className="contents">
                  <dt className="truncate text-muted-foreground">{c.name}</dt>
                  <dd className="text-right tabular-nums">{fmt(c.tokens)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canCompact || !onCompact} onSelect={() => onCompact?.()}>
          Compact now
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The composer footer: model, effort and mode pickers, and the context ring. `chatId` is null on the
 * new-chat screen, where picks are the defaults for the next chat. `ended` chats keep the pick for when
 * they continue. A pick during a turn is sent by the server after that turn's reply.
 */
export function ChatControls({
  chatId,
  ended = false,
  busy = false,
  disabled = false,
  onCompact,
}: {
  chatId: string | null;
  ended?: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** Sends `/compact` as a normal message. Left out where there is no composer. */
  onCompact?: () => void;
}) {
  const queryClient = useQueryClient();
  const live = useChatLive(chatId);
  const key = useMemo(() => ['chat-controls', chatId ?? 'repo', ended] as const, [chatId, ended]);
  const { data } = useQuery<ChatControlsData>({
    queryKey: key,
    queryFn: () => api.getControls(chatId),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  // Picks made here that the server has not confirmed with a `controls` event yet.
  const [optimistic, setOptimistic] = useState<PickedControls>({});
  const [touched, setTouched] = useState(false);

  // The server's own readings win from the moment they arrive.
  useEffect(() => setOptimistic({}), [live.controls, live.pending]);

  // A change the running Claude refused comes back as a `controls` event with an error.
  useEffect(
    () =>
      subscribeChat((e) => {
        if (e.kind === 'controls' && e.error && e.chatId === chatId) toast.error(e.error);
      }),
    [chatId],
  );

  const models =
    live.models && live.models.length > 0
      ? live.models
      : data && data.models.length > 0
        ? data.models
        : FALLBACK_MODELS;
  const base: PickedControls = {
    model: data?.model,
    effort: data?.effort,
    permissionMode: data?.permissionMode,
  };
  const running = Boolean(chatId) && !ended;
  const pending: PickedControls | null = running
    ? live.pending !== undefined
      ? live.pending
      : (data?.pending ?? null)
    : null;
  const current: PickedControls = {
    ...base,
    ...(running ? live.controls : undefined),
    ...pending,
    ...optimistic,
  };
  const context = (running ? live.context : undefined) ?? (running ? data?.context : null) ?? null;

  const model = findModel(models, current.model);
  const effortLevels = levelsFor(model);
  const showEffort = model?.supportsEffort !== false;
  const modes = MODES.filter((m) => m.value !== 'auto' || !model || model.supportsAutoMode);

  const pick = async (patch: PickedControls) => {
    setTouched(true);
    setOptimistic((o) => ({ ...o, ...patch }));
    try {
      const r = await api.setControls({ ...(chatId ? { chat: chatId } : {}), ...patch });
      queryClient.setQueryData<ChatControlsData>(key, (old) =>
        old ? { ...old, ...r.controls } : old,
      );
      // A running chat answers with a `controls` event, which clears the optimistic values.
    } catch (e) {
      setOptimistic({});
      toast.error(e instanceof ApiError ? e.message : "Couldn't change the setting");
    }
  };

  const pickModel = (value: string) => {
    const next = findModel(models, value);
    const patch: PickedControls = { model: value };
    if (next) {
      const effort = effortAfter(next, current.effort);
      if (effort && effort !== current.effort) patch.effort = effort;
    }
    void pick(patch);
  };

  const hasPending = Boolean(pending && Object.keys(pending).length > 0);
  const hint = hasPending
    ? 'Applies after this reply'
    : touched && ended
      ? 'Applies when this chat continues'
      : touched && !chatId
        ? 'Applies when the chat starts'
        : null;
  const modeLabel = (v: string | undefined) =>
    v ? (MODES.find((m) => m.value === v)?.label ?? v) : 'Mode';

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="chat-controls">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className={TRIGGER} disabled={disabled}>
            {model?.displayName ?? current.model ?? 'Model'}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={MENU}>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={model?.value ?? current.model ?? ''}
            onValueChange={pickModel}
          >
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.value} value={m.value}>
                <span className="flex flex-col">
                  <span>{m.displayName}</span>
                  {m.description && (
                    <span className="max-w-72 text-xs text-muted-foreground">{m.description}</span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {showEffort && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" className={TRIGGER} disabled={disabled}>
              Effort{current.effort ? `: ${current.effort}` : ''}
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className={MENU}>
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={current.effort ?? ''}
              onValueChange={(v) => void pick({ effort: v as EffortLevel })}
            >
              {effortLevels.map((l) => (
                <DropdownMenuRadioItem key={l} value={l}>
                  {l}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className={TRIGGER} disabled={disabled}>
            {modeLabel(current.permissionMode)}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={MENU}>
          <DropdownMenuLabel>Permission mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current.permissionMode ?? ''}
            onValueChange={(v) => void pick({ permissionMode: v as PermissionModeValue })}
          >
            {modes.map((m) => (
              <DropdownMenuRadioItem key={m.value} value={m.value}>
                {m.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {hint && <span className="px-1 text-xs text-muted-foreground">{hint}</span>}

      {context && (
        <ContextRing
          context={context}
          canCompact={running && !busy && !disabled}
          onCompact={onCompact}
        />
      )}
    </div>
  );
}
