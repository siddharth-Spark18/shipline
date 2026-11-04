import { useEffect, useState } from 'react';
import { Check, CircleSlash, Loader2, Undo2, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { StageTransitionDTO } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { errorMessage } from '@/lib/api';
import { useSendMessage } from '@/services/local/local.hooks';
import { useDecideTransition, useTransitions } from '@/services/tickets/tickets.hooks';

function describe(t: StageTransitionDTO): { title: string; Icon: typeof Check } {
  if (t.kind === 'complete') return { title: `Complete ${t.fromStageName} and move on`, Icon: ArrowRight };
  if (t.kind === 'skip') return { title: `Skip ${t.fromStageName}`, Icon: CircleSlash };
  return { title: `Go back to ${t.targetStageName ?? 'an earlier stage'}`, Icon: Undo2 };
}

interface TransitionCardProps {
  ticketId: string;
  proposalId: string;
}

/**
 * Inline chat card for a stage-transition proposal Claude made through `propose_stage_transition`.
 * Confirm makes the server advance the stage; either answer is then posted into the conversation so
 * Claude learns the outcome (and the new stage's rules) in the same chat.
 */
export default function TransitionCard({ ticketId, proposalId }: TransitionCardProps) {
  const [poll, setPoll] = useState(true);
  const transitions = useTransitions(ticketId, poll);
  const decide = useDecideTransition(ticketId);
  const send = useSendMessage();
  const proposal = transitions.data?.find((t) => t.id === proposalId);

  useEffect(() => {
    if (proposal && proposal.decision !== 'PENDING') setPoll(false);
  }, [proposal]);

  if (!proposal) return null;
  const { title, Icon } = describe(proposal);
  const pending = proposal.decision === 'PENDING';

  const answer = async (confirm: boolean) => {
    try {
      const result = await decide.mutateAsync({ transitionId: proposal.id, confirm });
      toast.success(confirm ? (result.currentStage ? `Moved to ${result.currentStage.name}` : 'All stages finished') : 'Staying in this stage');
      try {
        await send.mutateAsync({
          ticketId,
          text: result.claudeMessage,
          marker: {
            stageKey: result.currentStage?.key ?? null,
            stageName: result.currentStage?.name ?? null,
            // Only a confirmed change shows the inline completion card.
            transition: confirm ? { kind: result.transition.kind, fromStageName: result.transition.fromStageName } : undefined,
          },
        });
      } catch {
        // The stage already advanced on the server; Claude is told when the session is back.
        toast.warning('Claude is not running; it will be told about the new stage when the session resumes.');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card className="border-primary/30 bg-primary/5 py-3">
      <CardContent className="space-y-2 px-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <Icon className="size-4 text-primary" />
          <span>Claude proposes: {title}</span>
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
            {proposal.decision === 'CONFIRMED' ? 'Confirmed' : proposal.decision === 'DECLINED' ? 'Not yet' : 'Replaced by a newer proposal'}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
