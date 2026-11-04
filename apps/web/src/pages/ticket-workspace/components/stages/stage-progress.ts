import { StageStatus } from '@shipline/shared';

export interface StageProgress {
  /** Name of the current stage, or "Done". */
  name: string;
  /** 1-based position of the current stage (equals `total` once everything is finished). */
  n: number;
  total: number;
  done: boolean;
}

/** "Build · 4/8": where the chat is among its stages (a Hotfix has fewer). */
export function stageProgress(stages: Array<{ name: string; status: StageStatus }>): StageProgress {
  const total = stages.length;
  const index = stages.findIndex((s) => s.status !== 'DONE' && s.status !== 'SKIPPED');
  if (index === -1) return { name: 'Done', n: total, total, done: true };
  return { name: stages[index].name, n: index + 1, total, done: false };
}

export const progressLabel = (p: StageProgress): string => `${p.name} · ${p.n}/${p.total}`;
