import { GitPullRequest } from 'lucide-react';
import { toast } from 'sonner';
import { PrCommentDTO } from '@shipline/shared';
import { errorMessage } from '@/lib/api';
import { useSendMessage } from '@/services/local/local.hooks';
import { useMarkPrCommentsSent, usePrComments } from '@/services/tickets/tickets.hooks';
import { TicketDetail } from '@/services/tickets/tickets.types';

function formatComments(prNumber: number, comments: PrCommentDTO[]): string {
  const lines = comments.map((c, i) => {
    const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : '';
    const tags = [c.reviewState && c.reviewState !== 'COMMENTED' ? c.reviewState.toLowerCase().replace('_', ' ') : null, c.outdated ? 'outdated' : null]
      .filter(Boolean)
      .join(', ');
    return `${i + 1}. @${c.author}${where}${tags ? ` (${tags})` : ''}:\n${c.body || '(no text)'}`;
  });
  return `New review comments on PR #${prNumber}. Fix them, commit and push, then summarize what changed per comment.\n\n${lines.join('\n\n')}`;
}

interface PrStatusItemProps {
  ticket: TicketDetail;
  /** The local service has a running session for this chat (needed to post into the chat). */
  sessionRunning: boolean;
}

/**
 * Status bar item: PR number and state, plus "N new comments -> Send to Claude" which posts the
 * unsent review comments into the chat.
 */
export default function PrStatusItem({ ticket, sessionRunning }: PrStatusItemProps) {
  const comments = usePrComments(ticket.id);
  const send = useSendMessage();
  const markSent = useMarkPrCommentsSent(ticket.id);
  const pr = ticket.pr;

  if (!pr) return <span className="opacity-80">No PR yet</span>;

  const unsent = comments.data?.comments.filter((c) => !c.sentToClaudeAt) ?? [];

  const sendToClaude = async () => {
    try {
      await send.mutateAsync({ ticketId: ticket.id, text: formatComments(pr.number, unsent) });
      await markSent.mutateAsync(unsent.map((c) => c.id));
      toast.success(`Sent ${unsent.length} comment${unsent.length === 1 ? '' : 's'} to Claude`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-1" title={pr.title}>
        <GitPullRequest className="size-3" />
        {pr.url ? (
          <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
            PR #{pr.number}
          </a>
        ) : (
          <span>PR #{pr.number}</span>
        )}
        <span className="opacity-80">{pr.state.toLowerCase()}</span>
      </span>
      {unsent.length > 0 && (
        <button
          type="button"
          disabled={!sessionRunning || send.isPending || markSent.isPending}
          onClick={() => void sendToClaude()}
          title={sessionRunning ? 'Post these review comments into the chat' : 'Start the session to send them'}
          className="cursor-pointer rounded bg-primary-foreground px-1.5 py-px font-medium text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {unsent.length} new comment{unsent.length === 1 ? '' : 's'} &rarr; Send to Claude
        </button>
      )}
    </span>
  );
}
