export interface ArtifactContent {
  version: number;
  type: string;
  content: string;
  createdAt: string;
}

export const stageRunKeys = {
  artifact: (stageRunId: string, version: number) => ['stage-runs', stageRunId, 'artifact', version] as const,
};
