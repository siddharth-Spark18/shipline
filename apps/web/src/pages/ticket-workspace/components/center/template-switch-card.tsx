import { useEffect, useState } from 'react';
import { Check, Loader2, Shuffle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { errorMessage } from '@/lib/api';
import { useSendMessage } from '@/services/local/local.hooks';
import { useDecideTemplateSwitch, useTemplateSwitches } from '@/services/tickets/tickets.hooks';

interface TemplateSwitchCardProps {
  ticketId: string;
  proposalId: string;
}

/**
 * Inline chat card for a template-switch proposal Claude made through `propose_template_switch`
 * (only possible before the branch exists). Confirm re-pins the chat to the other template; stages
 * already done carry over by type. Either answer is then posted into the conversation.
 */
export default function TemplateSwitchCard({ ticketId, proposalId }: TemplateSwitchCardProps) {
  const [poll, setPoll] = useState(true);
  const switches = useTemplateSwitches(ticketId, poll);
  const decide = useDecideTemplateSwitch(ticketId);
  const send = useSendMessage();
  const proposal = switches.data?.find((s) => s.id === proposalId);

  useEffect(() => {
    if (proposal && proposal.decision !== 'PENDING') setPoll(false);
  }, [proposal]);

  if (!proposal) return null;
  const pending = proposal.decision === 'PENDING';

  const answer = async (confirm: boolean) => {
    try {
      const result = await decide.mutateAsync({ switchId: proposal.id, confirm });
      toast.success(confirm ? `Switched to ${result.template.name}` : 'Staying on this template');
      try {
        await send.mutateAsync({
          ticketId,
          text: result.claudeMessage,
          marker: { stageKey: result.currentStage?.key ?? null, stageName: result.currentStage?.name ?? null },
        });
      } catch {
        // The chat is already on the new template; Claude is told when the session is back.
        toast.warning('Claude is not running; it will be told about the new template when the session resumes.');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card className="border-primary/30 bg-primary/5 py-3">
      <CardContent className="space-y-2 px-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <Shuffle className="size-4 text-primary" />
          <span>
            Claude proposes: switch to the {proposal.toTemplateName} template (v{proposal.toVersion})
          </span>
        </div>
        {proposal.reason && <p className="text-muted-foreground">{proposal.reason}</p>}
        {pending ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => void answer(true)}>
              {decide.isPending ? <Loader2 className="animate-spin" /> : <Check />}
              Confirm
            </Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => void answer(false)}>
              Not yet
            </Button>
          </div>
        ) : (
          <Badge variant={proposal.decision === 'CONFIRMED' ? 'default' : 'secondary'}>
            {proposal.decision === 'CONFIRMED' ? 'Confirmed' : proposal.decision === 'DECLINED' ? 'Not yet' : 'No longer possible'}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
