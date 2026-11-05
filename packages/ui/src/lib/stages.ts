/** True when two stage ids name the same stage: equal, or `jira` (before 0.10.0) and `ticket`. */
export function sameStage(a: string, b: string): boolean {
  return a === b || (a === 'jira' && b === 'ticket') || (a === 'ticket' && b === 'jira');
}

/** The entry for stage `id`: an exact match first, then the jira/ticket alias. */
export function findStage<T extends { id: string }>(
  stages: readonly T[] | null | undefined,
  id: string,
): T | undefined {
  return stages?.find((s) => s.id === id) ?? stages?.find((s) => sameStage(s.id, id));
}
