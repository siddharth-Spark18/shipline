import { StageDraftDTO, StageTemplateDef, StageType, TemplateDraftDTO, defaultStage } from '@shipline/shared';

/** A stage in the editor: the saved fields plus a stable id for React keys and drag and drop. */
export interface EditorStage extends StageDraftDTO {
  uid: string;
}

export interface EditorDraft {
  name: string;
  description: string;
  stages: EditorStage[];
}

let counter = 0;
const nextUid = (): string => `stage-${++counter}`;

export function stagesFromDefs(stages: StageTemplateDef[]): EditorStage[] {
  return stages.map((s) => ({ ...s, rules: s.rules.map((r) => ({ ...r })), uid: nextUid() }));
}

/** A new stage of the given type with that type's defaults; the server gives it its key on save. */
export function newStage(type: StageType): EditorStage {
  const { key: _key, ...rest } = defaultStage(type);
  return { ...rest, uid: nextUid() };
}

/** A new template starts with a Build stage: the smallest useful flow. */
export const blankDraft = (): EditorDraft => ({ name: '', description: '', stages: [newStage('build')] });

export function toTemplateDraft(draft: EditorDraft): TemplateDraftDTO {
  return {
    name: draft.name,
    description: draft.description,
    stages: draft.stages.map(({ uid: _uid, ...stage }) => stage),
  };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
