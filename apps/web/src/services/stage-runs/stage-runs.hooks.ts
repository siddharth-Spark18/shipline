import { useQuery } from '@tanstack/react-query';
import { StageRunsService } from './stage-runs.service';
import { stageRunKeys } from './stage-runs.types';

export function useArtifact(stageRunId: string, version: number) {
  return useQuery({
    queryKey: stageRunKeys.artifact(stageRunId, version),
    queryFn: () => StageRunsService.getArtifact(stageRunId, version),
  });
}
