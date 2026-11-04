import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { StageRunsService } from '@/services/stage-runs/stage-runs.service';
import { StageView } from '@/services/tickets/tickets.types';
import { AssetRef } from '../types';

const EXT: Record<string, string> = { HTML: 'html', MARKDOWN: 'md', QA_REPORT: 'md' };

/**
 * Opens a stage's latest artifact (the deliverable chip, the stage popover) in the right panel.
 * Link artifacts (Figma, PR) open in a new tab instead.
 */
export function useArtifactOpener(onOpenAsset: (asset: AssetRef) => void) {
  return async (stage: StageView): Promise<void> => {
    const meta = stage.artifacts[stage.artifacts.length - 1];
    if (!meta) return;
    try {
      const artifact = await StageRunsService.getArtifact(stage.id, meta.version);
      if (artifact.type === 'FIGMA_LINK' || artifact.type === 'PR_LINK') {
        window.open(artifact.content.trim(), '_blank', 'noreferrer');
        return;
      }
      onOpenAsset({
        source: 'inline',
        name: `${stage.key}-v${artifact.version}.${EXT[artifact.type] ?? 'md'}`,
        type: artifact.type === 'HTML' ? 'HTML' : artifact.type === 'QA_REPORT' ? 'QA_REPORT' : 'MARKDOWN',
        content: artifact.content,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
}
