import type {
  Block,
  ConfigModel,
  SaveEntry,
  SetupData,
  SetupFile,
  StageModel,
  WorkflowModel,
} from '@/lib/types';

/** A workflow being edited. `keys[i]` is a stable client key for `model.stages[i]` (for drag-and-drop). */
export interface WorkflowDraft {
  model: WorkflowModel;
  keys: string[];
  /** Client keys of stages added in this session and not saved yet; only these may change their id. */
  fresh: string[];
}

export interface Drafts {
  config: ConfigModel | null;
  workflows: Record<string, WorkflowDraft>;
  /** Rules text by stage id. */
  rules: Record<string, string>;
}

let counter = 0;
export const newKey = () => `k${++counter}`;

export const clone = <T>(v: T): T => structuredClone(v);

export const ID_RE = /^[A-Za-z0-9_-]+$/;

export function initDrafts(data: SetupData): Drafts {
  const workflows: Record<string, WorkflowDraft> = {};
  for (const wf of data.workflows) {
    if (wf.model && wf.id) {
      const model = clone(wf.model);
      workflows[wf.id] = { model, keys: (model.stages ?? []).map(newKey), fresh: [] };
    }
  }
  const rules: Record<string, string> = {};
  for (const r of data.rules) {
    if (r.id && r.parseError === undefined) rules[r.id] = r.raw;
  }
  return { config: data.config.model ? clone(data.config.model) : null, workflows, rules };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function findWorkflow(data: SetupData, id: string): SetupFile<WorkflowModel> | undefined {
  return data.workflows.find((w) => w.id === id);
}

export function findRules(data: SetupData, id: string) {
  return data.rules.find((r) => r.id === id);
}

export function isConfigDirty(data: SetupData, drafts: Drafts): boolean {
  return drafts.config !== null && !same(drafts.config, data.config.model);
}

export function isWorkflowDirty(data: SetupData, drafts: Drafts, id: string): boolean {
  const draft = drafts.workflows[id];
  const disk = findWorkflow(data, id);
  return !!draft && !!disk?.model && !same(draft.model, disk.model);
}

export function isRulesDirty(data: SetupData, drafts: Drafts, id: string): boolean {
  const text = drafts.rules[id];
  if (text === undefined) return false;
  const disk = findRules(data, id);
  return disk ? text !== disk.raw : text !== '';
}

/** Ids of stages in the drafted workflows. */
function draftedStageIds(drafts: Drafts): Set<string> {
  const ids = new Set<string>();
  for (const d of Object.values(drafts.workflows)) {
    for (const s of d.model.stages ?? []) ids.add(s.id);
  }
  return ids;
}

/** Everything that differs from disk, as the `files` of a preview or save request. */
export function buildEntries(data: SetupData, drafts: Drafts): SaveEntry[] {
  const entries: SaveEntry[] = [];
  if (drafts.config && data.config.hash && isConfigDirty(data, drafts)) {
    entries.push({ kind: 'config', model: drafts.config, baseHash: data.config.hash });
  }
  for (const wf of data.workflows) {
    if (wf.id && wf.hash && isWorkflowDirty(data, drafts, wf.id)) {
      entries.push({
        kind: 'workflow',
        id: wf.id,
        model: drafts.workflows[wf.id].model,
        baseHash: wf.hash,
      });
    }
  }
  const stageIds = draftedStageIds(drafts);
  for (const id of Object.keys(drafts.rules)) {
    if (!isRulesDirty(data, drafts, id)) continue;
    const disk = findRules(data, id);
    // A rules file is created only for a stage that exists in a workflow being edited.
    if (!disk && !stageIds.has(id)) continue;
    entries.push({ kind: 'rules', id, text: drafts.rules[id], baseHash: disk?.hash ?? null });
  }
  return entries;
}

/** Stage ids present on disk but removed in the draft. Their rules files stay in place. */
export function removedStageIds(
  data: SetupData,
  drafts: Drafts,
): { workflow: string; stage: string }[] {
  const out: { workflow: string; stage: string }[] = [];
  for (const wf of data.workflows) {
    if (!wf.id || !wf.model) continue;
    const draft = drafts.workflows[wf.id];
    if (!draft) continue;
    const now = new Set((draft.model.stages ?? []).map((s) => s.id));
    for (const s of wf.model.stages ?? []) {
      if (!now.has(s.id)) out.push({ workflow: wf.id, stage: s.id });
    }
  }
  return out;
}

/** Sets or clears an optional text field: an empty string removes the key. */
export function setOptional<T extends Record<string, unknown>>(
  obj: T,
  key: string,
  value: string,
): void {
  if (value === '') delete obj[key];
  else (obj as Record<string, unknown>)[key] = value;
}

export function newStage(id: string): StageModel {
  return { id, enforcement: 'guide', confirm_to_advance: false };
}

export function isBashBlock(b: Block): b is Extract<Block, { bash: string }> {
  return 'bash' in b;
}

/** The named actions a stage block can hold back. */
export const BLOCK_ACTIONS = ['commit', 'push', 'pr', 'merge', 'release', 'deploy', 'migrate'];

export function isActionsBlock(b: Block): b is Extract<Block, { actions: string[] }> {
  return 'actions' in b;
}

/** Returns an error text when the pattern does not compile as a RegExp. */
export function regexError(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid regular expression';
  }
}
