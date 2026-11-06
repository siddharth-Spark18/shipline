import type { ConfigModel, StageModel } from '@/lib/types';

/**
 * Whether a stage needs the developer's answer to advance. A copy of `needsAnswer` in
 * packages/cli/templates/shipline/bin/lib.mjs (the source of the rule for the hooks and CI); keep them in step.
 * Anything other than `confirmations: light` is standard. Skip, accept and scope questions ask in both modes.
 */
export function needsAnswer(
  stage: StageModel | null | undefined,
  config: ConfigModel | null | undefined,
): boolean {
  if (!stage || stage.confirm_to_advance !== true) return false;
  const light = !!config && config.confirmations === 'light';
  return !light || stage.checkpoint === true;
}
