import { StageContextDTO } from '@shipline/shared';
import { Badge } from '@/components/ui/badge';

/** What the server will allow in the current stage (it reads this stage at every tool request). */
export default function PolicySummary({ stage }: { stage: StageContextDTO | null }) {
  if (!stage) return <p className="text-xs text-muted-foreground">All stages are finished.</p>;
  const p = stage.toolPolicy;
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap gap-1">
        <Badge variant={p.allowCodeEdit ? 'secondary' : 'outline'}>{p.allowCodeEdit ? 'Code edits allowed' : 'No code edits'}</Badge>
        <Badge variant="outline">
          Shell: {p.bash === 'inherit' ? 'per your role' : p.bash === 'deny' ? 'read-only commands' : p.bash === 'ask' ? 'asks first' : 'allowed'}
        </Badge>
      </div>
      <p className="text-muted-foreground">Artifact: {stage.artifactTypes.join(' or ')}</p>
    </div>
  );
}
