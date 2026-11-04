import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useLocalReady } from '@/services/local/local.hooks';

const LABEL = {
  checking: 'Local: checking',
  unreachable: 'Local: not running',
  'needs-pairing': 'Local: not paired',
  ready: 'Local: connected',
} as const;

/** Header indicator for Shipline Local (the service that runs Claude on this computer). */
export default function LocalStatusBadge() {
  const { state, ready } = useLocalReady();
  const ok = state === 'ready' && ready;
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn('size-2 rounded-full', ok ? 'bg-green-500' : state === 'ready' ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
      {state === 'ready' && !ok ? 'Local: setup needed' : LABEL[state]}
    </Badge>
  );
}
