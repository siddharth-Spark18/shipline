import api from '@/lib/api';
import { ArtifactContent } from './stage-runs.types';

// Stage runs are status rows now; the only thing read per stage run is its stored artifacts.
export class StageRunsService {
  static async getArtifact(stageRunId: string, version: number) {
    const { data } = await api.get<ArtifactContent>(`/stage-runs/${stageRunId}/artifacts/${version}`);
    return data;
  }
}
