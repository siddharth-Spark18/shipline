import type { ReactNode } from 'react';
import {
  BanIcon,
  BellIcon,
  CopyIcon,
  GaugeIcon,
  HandIcon,
  InfoIcon,
  OctagonAlertIcon,
  PlugZapIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { TicketStatus } from '@/lib/types';
import type { FatalInfo } from '@/pages/chat/chat-store';
import type { ChatResult, NoticeLevel } from '@/pages/chat/timeline';

// Each level with a tone gets a coloured left edge and title (--notice-* tokens).
const NOTICE: Record<NoticeLevel, { title: string; icon: typeof InfoIcon; tone?: string }> = {
  blocked: {
    title: 'Shipline blocked',
    icon: ShieldAlertIcon,
    tone: 'border-l-4 border-l-notice-blocked text-notice-blocked',
  },
  reminder: {
    title: 'Shipline reminder',
    icon: BellIcon,
    tone: 'border-l-4 border-l-notice-reminder text-notice-reminder',
  },
  notice: { title: 'Shipline notice', icon: InfoIcon },
  denied: {
    title: 'You denied',
    icon: HandIcon,
    tone: 'border-l-4 border-l-notice-denied text-notice-denied',
  },
  'usage-limit': {
    title: 'Usage limit',
    icon: GaugeIcon,
    tone: 'border-l-4 border-l-notice-blocked text-notice-blocked',
  },
  info: { title: 'Claude', icon: InfoIcon },
};

/** One notice in the timeline. For "Shipline reminder:" text the prefix is dropped (the title says it). */
export function NoticeItem({ level, text }: { level: NoticeLevel; text: string }) {
  const n = NOTICE[level];
  const Icon = n.icon;
  const body = level === 'reminder' ? text.replace(/^Shipline reminder:\s*/, '') : text;
  return (
    <Alert className={cn('py-2', n.tone)}>
      <Icon />
      <AlertTitle>{n.title}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words">{body}</AlertDescription>
    </Alert>
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Could not copy. Select the text and copy it by hand.');
  }
}

/** `claude --resume <id>` with a copy button. */
export function ResumeCommand({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2">
      <code
        className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs"
        title={command}
      >
        {command}
      </code>
      <Button variant="outline" size="xs" onClick={() => void copyText(command)}>
        <CopyIcon />
        Copy
      </Button>
    </div>
  );
}

const FATAL_TEXT: Record<NonNullable<FatalInfo['reason']>, string> = {
  parse: 'Claude printed a line the UI could not read, so the chat was stopped.',
  exit: 'Claude exited unexpectedly.',
  'resume-failed': 'Claude could not resume this chat.',
};

/** The chat broke: show why and the command to continue in a terminal in the same checkout. */
export function FatalNotice({
  chatId,
  fatal,
  onNewChat,
}: {
  chatId: string;
  fatal: FatalInfo;
  onNewChat: () => void;
}) {
  const command = fatal.resumeCommand ?? `claude --resume ${chatId}`;
  return (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>Chat stopped</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          {FATAL_TEXT[fatal.reason ?? 'exit']}
          {fatal.code != null && ` Exit code ${fatal.code}.`}
        </p>
        {fatal.stderrTail && (
          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground">
            {fatal.stderrTail}
          </pre>
        )}
        {fatal.reason === 'resume-failed' ? (
          <div>
            <Button size="sm" onClick={onNewChat}>
              Start a new chat
            </Button>
          </div>
        ) : (
          <>
            <p>Continue in a terminal in this checkout; the hooks find the same state file.</p>
            <ResumeCommand command={command} />
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** After Stop: something Claude started is still running. The developer decides whether to kill it. */
export function OrphansNotice({ onKill, killing }: { onKill: () => void; killing: boolean }) {
  return (
    <Alert className="border-l-4 border-l-notice-reminder">
      <OctagonAlertIcon />
      <AlertTitle>Still running</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>Processes started in this chat are still running.</p>
        <div>
          <Button size="sm" variant="outline" disabled={killing} onClick={onKill}>
            {killing ? 'Killing...' : 'Kill them'}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Shown instead of the composer when `claude` is missing or unusable (412). */
export function ClaudeMissingNotice({ code, message }: { code: string; message: string }) {
  return (
    <Alert variant="destructive">
      <BanIcon />
      <AlertTitle>
        {code === 'claude-missing' ? 'Claude Code not found' : 'Claude Code problem'}
      </AlertTitle>
      <AlertDescription>
        {code === 'claude-missing'
          ? 'Install Claude Code and sign in, then reload.'
          : `${message} Fix it, then reload.`}
      </AlertDescription>
    </Alert>
  );
}

/** Another Shipline UI holds the chat lock. There is no take-over. */
export function LockHeldNotice({ heldBy, message }: { heldBy: unknown; message: string }) {
  let port: string | null = null;
  if (typeof heldBy === 'number' || typeof heldBy === 'string') port = String(heldBy);
  else if (heldBy && typeof heldBy === 'object' && 'port' in heldBy)
    port = String((heldBy as { port: unknown }).port);
  return (
    <Alert variant="destructive">
      <BanIcon />
      <AlertTitle>Chat is locked</AlertTitle>
      <AlertDescription>
        {port ? `A chat is active in another Shipline UI on port ${port}; stop it there.` : message}
      </AlertDescription>
    </Alert>
  );
}

/** The cost and usage line under the chat, from the latest `result` event. */
export function ResultLine({ result }: { result: ChatResult }) {
  const parts: string[] = [];
  if (result.costUsd !== undefined) parts.push(`$${result.costUsd.toFixed(4)}`);
  if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
    parts.push(`${result.inputTokens ?? 0} in / ${result.outputTokens ?? 0} out tokens`);
  }
  if (result.durationMs !== undefined) parts.push(`${(result.durationMs / 1000).toFixed(1)} s`);
  if (result.turns !== undefined) parts.push(`${result.turns} turns`);
  if (parts.length === 0) return null;
  return <p className="text-xs text-muted-foreground">Last turn: {parts.join(' · ')}</p>;
}

const JIRA_TEXT: Record<Exclude<TicketStatus['status'], 'connected'>, ReactNode> = {
  missing:
    "Jira isn't connected. Add the Atlassian connector in claude.ai → Settings → Connectors. Claude will skip the ticket stage for now.",
  'needs-auth': (
    <>
      Jira needs authenticating. Run <code className="font-mono">claude</code> in a terminal, then{' '}
      <code className="font-mono">/mcp</code> → claude.ai Atlassian → Authenticate. Claude will skip
      the ticket stage for now.
    </>
  ),
  failed: (
    <>
      The Jira connector failed to start. Check <code className="font-mono">/mcp</code> in a
      terminal <code className="font-mono">claude</code>. Claude will skip the ticket stage for now.
    </>
  ),
};

const GITHUB_TEXT: Record<Exclude<TicketStatus['status'], 'connected'>, ReactNode> = {
  missing: (
    <>
      GitHub CLI not found. Install <code className="font-mono">gh</code> (cli.github.com). Claude
      will skip the ticket stage for now.
    </>
  ),
  'needs-auth': (
    <>
      GitHub CLI isn&apos;t signed in. Run <code className="font-mono">gh auth login</code> in a
      terminal. Claude will skip the ticket stage for now.
    </>
  ),
  failed: "Couldn't check the GitHub CLI. Claude will skip the ticket stage for now.",
};

/** The task is at the ticket stage but the repo's tracker (Jira connector or GitHub CLI) can't be used. */
export function TicketNotice({
  tracker,
  status,
}: {
  tracker: TicketStatus['tracker'];
  status: Exclude<TicketStatus['status'], 'connected'>;
}) {
  return (
    <Alert className="border-l-4 border-l-notice-reminder">
      <PlugZapIcon />
      <AlertTitle>{tracker === 'github' ? 'GitHub Issues' : 'Jira'}</AlertTitle>
      <AlertDescription>
        {tracker === 'github' ? GITHUB_TEXT[status] : JIRA_TEXT[status]}
      </AlertDescription>
    </Alert>
  );
}
