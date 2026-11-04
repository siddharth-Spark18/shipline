import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, Loader2, Send, TerminalSquare } from 'lucide-react';
import {
  ASK_USER_QUESTION_TOOL,
  AssistantEvent,
  ContentBlock,
  PendingToolDecisionDTO,
  ResultEvent,
  SessionMessage,
  UserEvent,
} from '@shipline/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useResolvePrompt } from '@/services/local/local.hooks';
import { StageView, TicketDetail } from '@/services/tickets/tickets.types';
import { SessionStream } from '@/pages/ticket-workspace/hooks/use-session-stream';
import { AssetRef } from '@/pages/ticket-workspace/types';
import AssetChip, { LinkChip } from './asset-chip';
import ChangesSummaryCard from './changes-summary-card';
import QuestionCard from './question-card';
import StageCompletionCard from './stage-completion-card';
import ToolChip, { chipLabel, toolTarget } from './tool-chip';
import TemplateSwitchCard from './template-switch-card';
import TransitionCard from './transition-card';

interface ChatViewProps {
  ticketId: string;
  ticket: TicketDetail;
  stream: SessionStream;
  /** Absolute worktree path, used to show file chips relative to it. */
  worktreePath: string | null;
  localReady: boolean;
  onOpenAsset: (asset: AssetRef) => void;
  /** Opens the right panel on the Changes tab, optionally with one file expanded. */
  onOpenChanges: (focusPath?: string) => void;
  onOpenArtifact: (stage: StageView) => void;
  onSwitchToTerminal: () => void;
}

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const PROPOSE_TOOL = 'propose_stage_transition';
const SWITCH_TOOL = 'propose_template_switch';
const SUBMIT_TOOL = 'submit_artifact';

interface ToolIndex {
  names: Map<string, string>;
  results: Map<string, { text: string; isError: boolean }>;
  /** Tool calls denied by policy (role or stage limits), by tool_use id. */
  denials: Map<string, string>;
}

function toolResultText(block: Extract<ContentBlock, { type: 'tool_result' }>): string {
  if (typeof block.content === 'string') return block.content;
  return block.content.map((c) => c.text ?? '').join('\n');
}

function buildToolIndex(messages: SessionMessage[]): ToolIndex {
  const names = new Map<string, string>();
  const results = new Map<string, { text: string; isError: boolean }>();
  const denials = new Map<string, string>();
  for (const m of messages) {
    if (m.kind === 'tool-denied' && m.toolUseId) denials.set(m.toolUseId, m.reason);
    if (m.kind !== 'event') continue;
    if (m.event.type === 'assistant') {
      for (const b of (m.event as AssistantEvent).message.content) if (b.type === 'tool_use') names.set(b.id, b.name);
    } else if (m.event.type === 'user') {
      const content = (m.event as UserEvent).message.content;
      if (typeof content === 'string') continue;
      for (const b of content) {
        if (b.type === 'tool_result') results.set(b.tool_use_id, { text: toolResultText(b), isError: !!b.is_error });
      }
    }
  }
  return { names, results, denials };
}

const isTool = (name: string, suffix: string): boolean => name === suffix || name.endsWith(`__${suffix}`);

function proposalIdFrom(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const id = (JSON.parse(text) as { proposalId?: unknown }).proposalId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

export default function ChatView({ ticketId, ticket, stream, worktreePath, localReady, onOpenAsset, onOpenChanges, onOpenArtifact, onSwitchToTerminal }: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const resolve = useResolvePrompt();
  const bottom = useRef<HTMLDivElement>(null);
  const index = useMemo(() => buildToolIndex(stream.messages), [stream.messages]);

  const pending = useMemo<PendingToolDecisionDTO[]>(() => {
    const open = new Map<string, PendingToolDecisionDTO>();
    for (const m of stream.messages) {
      if (m.kind === 'tool-prompt') open.set(m.prompt.id, m.prompt);
      if (m.kind === 'tool-prompt-resolved') open.delete(m.id);
    }
    return [...open.values()];
  }, [stream.messages]);

  const streamingText = useMemo(() => {
    let text = '';
    for (const m of stream.messages) {
      if (m.kind !== 'event') continue;
      if (m.event.type === 'stream_event') {
        const delta = (m.event as { event: { delta?: { type: string; text?: string } } }).event.delta;
        if (delta?.type === 'text_delta' && delta.text) text += delta.text;
      } else if (m.event.type === 'assistant' || m.event.type === 'user' || m.event.type === 'result') {
        text = '';
      }
    }
    return text;
  }, [stream.messages]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream.messages.length, streamingText, pending.length]);

  const send = () => {
    if (!draft.trim()) return;
    stream.sendUser(draft);
    setDraft('');
  };

  const relative = (p: string): string => (worktreePath && p.startsWith(`${worktreePath}/`) ? p.slice(worktreePath.length + 1) : p);

  // Only the newest completion card shows the stepper; earlier stage changes stay thin markers.
  const latestCompletion = useMemo(() => {
    for (let i = stream.messages.length - 1; i >= 0; i--) {
      const m = stream.messages[i];
      if (m.kind === 'stage-change' && m.transition) return i;
    }
    return -1;
  }, [stream.messages]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[720px] space-y-3 p-4">
          {stream.messages.map((m, i) => (
            <MessageItem
              key={i}
              message={m}
              index={index}
              ticket={ticket}
              ticketId={ticketId}
              localReady={localReady}
              relative={relative}
              showCompletionCard={i === latestCompletion}
              onOpenAsset={onOpenAsset}
              onOpenArtifact={onOpenArtifact}
              onSwitchToTerminal={onSwitchToTerminal}
            />
          ))}
          {streamingText && <div className="text-sm whitespace-pre-wrap text-foreground/80">{streamingText}</div>}
          {stream.state === 'running' && !streamingText && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Claude is working...
            </p>
          )}
          <ChangesSummaryCard ticketId={ticketId} enabled={localReady} onOpenChanges={onOpenChanges} />
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <div className="mx-auto w-full max-w-[720px] px-4">
        {pending.map((p) =>
          p.tool === ASK_USER_QUESTION_TOOL && p.questions?.length ? (
            <QuestionCard
              key={p.id}
              questions={p.questions}
              submitting={resolve.isPending}
              onAnswer={(answers) => resolve.mutate({ ticketId, id: p.id, allow: true, answers })}
              onSkip={() => resolve.mutate({ ticketId, id: p.id, allow: false })}
            />
          ) : (
            <Card key={p.id} className="mb-2 border-amber-500/40 bg-amber-500/10 py-3">
              <CardContent className="space-y-1 px-4 text-sm">
                <p className="font-medium">Claude wants to use {p.tool}</p>
                <p className="max-h-24 overflow-y-auto font-mono text-xs break-all whitespace-pre-wrap">{p.inputSummary}</p>
                {/* The reason names the rule and its level (for example "Project rule: Force pushes need a second look"). */}
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">{p.reason}</p>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={() => resolve.mutate({ ticketId, id: p.id, allow: true })}>
                    Allow
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => resolve.mutate({ ticketId, id: p.id, allow: false })}>
                    Deny
                  </Button>
                </div>
              </CardContent>
            </Card>
          ),
        )}
      </div>

      <div className="mx-auto w-full max-w-[720px] px-4 pb-4">
        <div className="flex gap-2 rounded-xl border bg-card p-3 shadow-xs">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Reply to Claude... (Enter to send, Shift+Enter for a new line)"
            className="min-h-0 flex-1 resize-none border-0 p-0 shadow-none focus-visible:ring-0"
          />
          <div className="flex flex-col gap-1">
            <Button onClick={send} disabled={!stream.connected || !draft.trim()}>
              <Send /> Send
            </Button>
            <Button variant="ghost" size="xs" onClick={onSwitchToTerminal}>
              <TerminalSquare /> Terminal
            </Button>
          </div>
      </div>
      </div>
    </div>
  );
}

interface MessageItemProps {
  message: SessionMessage;
  index: ToolIndex;
  ticket: TicketDetail;
  ticketId: string;
  localReady: boolean;
  relative: (path: string) => string;
  showCompletionCard: boolean;
  onOpenAsset: (asset: AssetRef) => void;
  onOpenArtifact: (stage: StageView) => void;
  onSwitchToTerminal: () => void;
}

function MessageItem({ message, index, ticket, ticketId, localReady, relative, showCompletionCard, onOpenAsset, onOpenArtifact, onSwitchToTerminal }: MessageItemProps) {
  if (message.kind === 'user-message') {
    return <div className="ml-auto max-w-[80%] rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">{message.text}</div>;
  }
  if (message.kind === 'stage-change' && message.transition && showCompletionCard) {
    return (
      <StageCompletionCard
        ticket={ticket}
        transition={message.transition}
        toStageName={message.stageName}
        onOpenArtifact={onOpenArtifact}
      />
    );
  }
  if (message.kind === 'tool-denied') {
    // Calls whose tool_use block is in the chat show the denial on that chip; this is the fallback.
    if (message.toolUseId && index.names.has(message.toolUseId)) return null;
    return <ToolChip label={message.tool.replace(/^mcp__shipline__/, 'shipline:')} denied={message.reason} />;
  }
  if (message.kind === 'branch') {
    return <p className="text-center text-xs text-muted-foreground">Branch created: <code>{message.branch}</code></p>;
  }
  if (message.kind === 'stage-change') {
    const first = message.text.split('\n')[0].replace(/^\[Shipline\]\s*/, '');
    return (
      <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        <span className="max-w-[80%] text-center">{first}</span>
        <Separator className="flex-1" />
      </div>
    );
  }
  if (message.kind === 'usage-limit') {
    return (
      <Alert>
        <AlertDescription>
          Claude usage limit reached: {message.message} Nothing is lost; the conversation resumes when your limit resets.
        </AlertDescription>
      </Alert>
    );
  }
  if (message.kind === 'fatal') {
    return (
      <Alert variant="destructive">
        <AlertDescription className="space-y-2">
          <p>{message.fatal.message}</p>
          {message.fatal.suggestTerminal && (
            <Button size="sm" variant="outline" onClick={onSwitchToTerminal}>
              Continue in terminal mode
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (message.kind === 'exit') return <p className="text-center text-xs text-muted-foreground">Session ended.</p>;
  if (message.kind !== 'event') return null;

  const event = message.event;
  if (event.type === 'assistant') {
    return (
      <div className="space-y-2">
        {(event as AssistantEvent).message.content.map((block, i) => (
          <Block
            key={i}
            block={block}
            index={index}
            ticketId={ticketId}
            localReady={localReady}
            relative={relative}
            onOpenAsset={onOpenAsset}
          />
        ))}
      </div>
    );
  }
  if (event.type === 'user') {
    const content = (event as UserEvent).message.content;
    if (typeof content === 'string') return null;
    return (
      <div className="space-y-1">
        {content
          .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
          .filter((b) => !index.denials.has(b.tool_use_id)) // a denied chip already says why
          .filter((b) => {
            // The transition and switch cards and file chips already show these calls; keep errors visible.
            const name = index.names.get(b.tool_use_id) ?? '';
            return b.is_error || !(isTool(name, PROPOSE_TOOL) || isTool(name, SWITCH_TOOL) || isTool(name, SUBMIT_TOOL));
          })
          .map((b, i) => {
            const text = toolResultText(b);
            const lines = text ? text.split('\n').length : 0;
            return (
              <Collapsible key={i} className="group ml-4 text-xs">
                <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
                  <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                  {b.is_error ? <Badge variant="destructive">denied or failed</Badge> : `Output · ${lines} line${lines === 1 ? '' : 's'}`}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre
                    className={cn(
                      'mt-1 max-h-72 overflow-auto rounded px-3 py-2 font-mono break-words whitespace-pre-wrap',
                      b.is_error ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {text}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
      </div>
    );
  }
  if (event.type === 'result') {
    const r = event as ResultEvent;
    return r.is_error ? <p className="text-xs text-destructive">Turn ended with an error: {r.result}</p> : null;
  }
  return null;
}

interface BlockProps {
  block: ContentBlock;
  index: ToolIndex;
  ticketId: string;
  localReady: boolean;
  relative: (path: string) => string;
  onOpenAsset: (asset: AssetRef) => void;
}

function Block({ block, index, ticketId, localReady, relative, onOpenAsset }: BlockProps) {
  if (block.type === 'text') {
    return (
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
      </div>
    );
  }
  if (block.type !== 'tool_use') return null;

  if (block.name === ASK_USER_QUESTION_TOOL) {
    return <p className="text-xs text-muted-foreground italic">Claude asked you a question.</p>;
  }
  if (isTool(block.name, PROPOSE_TOOL)) {
    const proposalId = proposalIdFrom(index.results.get(block.id)?.text);
    return proposalId ? <TransitionCard ticketId={ticketId} proposalId={proposalId} /> : null;
  }
  if (isTool(block.name, SWITCH_TOOL)) {
    const proposalId = proposalIdFrom(index.results.get(block.id)?.text);
    return proposalId ? <TemplateSwitchCard ticketId={ticketId} proposalId={proposalId} /> : null;
  }
  if (isTool(block.name, SUBMIT_TOOL)) {
    const type = String(block.input.type ?? '');
    const content = String(block.input.content ?? '');
    if (type === 'FIGMA_LINK' || type === 'PR_LINK') {
      return <LinkChip url={content.trim()} label={type === 'PR_LINK' ? 'Pull request' : 'Figma'} />;
    }
    const name = type === 'HTML' ? 'wireframe.html' : type === 'QA_REPORT' ? 'qa-report.md' : 'artifact.md';
    return (
      <AssetChip
        ticketId={ticketId}
        localReady={localReady}
        onOpen={onOpenAsset}
        asset={{ source: 'inline', name, type: type === 'HTML' ? 'HTML' : type === 'QA_REPORT' ? 'QA_REPORT' : 'MARKDOWN', content }}
      />
    );
  }
  if (WRITE_TOOLS.includes(block.name) && !index.denials.has(block.id)) {
    const file = String(block.input.file_path ?? block.input.notebook_path ?? '');
    if (file) {
      const rel = relative(file);
      return (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{block.name}</p>
          <AssetChip
            ticketId={ticketId}
            localReady={localReady}
            onOpen={onOpenAsset}
            asset={{ source: 'worktree', path: file, name: rel.split('/').pop() ?? rel }}
          />
        </div>
      );
    }
  }
  return <ToolChip label={chipLabel(block.name, block.input)} title={toolTarget(block.input) ?? block.name} denied={index.denials.get(block.id)} />;
}
