import type { CustomAgentInput } from './agents';
import type { StageContextDTO } from './dto';
import { parseAgentRef, PLUGIN_AGENTS } from './agents';
import type { GuardrailRuleInput } from './guardrails';
import { validateRuleInput } from './guardrails';
import type { EditPolicy } from './roles';
import type { StageTemplateDef, StageType, TransitionDecision } from './stages';
import { ARTIFACT_TYPES, BUILT_IN_STAGE_TYPES, STAGE_TYPE_LABELS, STAGE_TYPES } from './stages';

// Workflow templates: an org-level library of versioned templates. Saving creates a new immutable
// version; a chat is pinned to the version it started on.

/** What the editor sends to save a template (a new version). `key` is empty for a stage added in the editor. */
export interface StageDraftDTO extends Omit<StageTemplateDef, 'key'> {
  key?: string;
}

export interface TemplateDraftDTO {
  name: string;
  description: string;
  stages: StageDraftDTO[];
}

export interface TemplateSummaryDTO {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  archived: boolean;
  latestVersion: number;
  stageCount: number;
  /** Chats on any version of the template: a template with any can only be archived, not deleted. */
  chatCount: number;
  /** Chats on any version whose work is not finished. */
  activeChatCount: number;
  projectCount: number;
  updatedAt: string;
}

export interface TemplateVersionDTO {
  id: string;
  version: number;
  name: string;
  description: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  stages: StageTemplateDef[];
}

export interface TemplateVersionRowDTO {
  version: number;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  stageCount: number;
}

export interface TemplateDetailDTO extends TemplateSummaryDTO {
  latest: TemplateVersionDTO;
  versions: TemplateVersionRowDTO[];
}

/** One row of a project's template picker: the org's non-archived templates and whether the project uses them. */
export interface ProjectTemplateDTO {
  templateId: string;
  name: string;
  description: string;
  latestVersion: number;
  stages: Array<{ name: string; optional: boolean; type: StageType }>;
  enabled: boolean;
  isDefault: boolean;
}

export interface SaveProjectTemplatesRequestDTO {
  enabledTemplateIds: string[];
  defaultTemplateId: string | null;
}

export interface SaveTemplateRequestDTO {
  /** The version the editor was opened on: the save is rejected when a newer one exists. */
  baseVersion: number;
  draft: TemplateDraftDTO;
}

// --- Export / import ---

export const TEMPLATE_EXPORT_FORMAT = 'shipline.workflow-template';

export interface ExportedStageDTO extends Omit<StageTemplateDef, 'agentRef'> {
  agent: { kind: 'plugin' | 'custom'; name: string } | null;
}

export interface TemplateExportDTO {
  format: typeof TEMPLATE_EXPORT_FORMAT;
  formatVersion: 1;
  name: string;
  description: string;
  stages: ExportedStageDTO[];
  /** Definitions of the custom agents the stages name, so an import can recreate missing ones. */
  customAgents: CustomAgentInput[];
}

export interface ImportTemplateRequestDTO {
  data: unknown;
  /** Create the custom agents the file names (from its bundled definitions) when the org lacks them. */
  createMissingAgents?: boolean;
}

export interface ImportTemplateResultDTO {
  template: TemplateSummaryDTO;
  /** `created`: a new template; `new-version`: a new version of the same-named one. */
  outcome: 'created' | 'new-version';
  createdAgents: string[];
}

// --- Switching a chat's template ---

export interface TemplateSwitchDTO {
  id: string;
  ticketId: string;
  toTemplateId: string;
  toTemplateName: string;
  toVersion: number;
  reason: string;
  decision: TransitionDecision;
  createdAt: string;
  decidedAt: string | null;
}

/** Result of confirming/declining a switch; `claudeMessage` is injected into the chat (with the new stage's instructions). */
export interface TemplateSwitchDecisionResultDTO {
  proposal: TemplateSwitchDTO;
  template: { id: string; name: string; version: number };
  currentStage: StageContextDTO | null;
  claudeMessage: string;
}

// --- Validation ---

export interface TemplateIssue {
  /** The stage the message is about; null for the template as a whole. */
  stageKey: string | null;
  /** The stage's position in the draft (0-based), for drafts whose stages have no key yet. */
  stageIndex: number | null;
  message: string;
}

const NAME_MAX = 80;
const INSTRUCTIONS_MAX = 8000;
const BASH_MODES: Array<'inherit' | EditPolicy> = ['inherit', 'deny', 'ask', 'allow'];

/**
 * Validates a template draft (also used on import and by the server on every save). The editor shows
 * the messages inline and blocks saving while any remain.
 */
export function validateTemplate(draft: TemplateDraftDTO, opts: { knownCustomAgentIds?: ReadonlySet<string> } = {}): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (index: number | null, message: string) =>
    issues.push({ stageKey: index === null ? null : (draft.stages[index]?.key ?? null), stageIndex: index, message });

  if (!draft.name.trim()) add(null, 'The template needs a name.');
  else if (draft.name.trim().length > NAME_MAX) add(null, `The name is longer than ${NAME_MAX} characters.`);
  if (draft.stages.length === 0) {
    add(null, 'A template needs at least one stage.');
    return issues;
  }

  const seenNames = new Map<string, number>();
  const typeIndex = new Map<StageType, number>();
  const keys = new Set<string>();
  draft.stages.forEach((s, i) => {
    const label = s.name.trim() || `Stage ${i + 1}`;
    if (!s.name.trim()) add(i, `Stage ${i + 1} needs a name.`);
    else if (s.name.trim().length > NAME_MAX) add(i, `${label}: the name is longer than ${NAME_MAX} characters.`);
    const lower = s.name.trim().toLowerCase();
    if (lower && seenNames.has(lower)) add(i, `${label}: another stage has the same name.`);
    seenNames.set(lower, i);

    if (s.key) {
      if (keys.has(s.key)) add(i, `${label}: duplicate stage key "${s.key}".`);
      keys.add(s.key);
    }

    if (!STAGE_TYPES.includes(s.type)) {
      add(i, `${label}: unknown stage type "${s.type}".`);
      return;
    }
    if (BUILT_IN_STAGE_TYPES.includes(s.type)) {
      if (typeIndex.has(s.type)) add(i, `${label}: a template can have only one ${STAGE_TYPE_LABELS[s.type]} stage.`);
      else typeIndex.set(s.type, i);
    }

    if (s.artifactTypes.length === 0) add(i, `${label}: pick at least one artifact type.`);
    if (s.artifactTypes.some((a) => !ARTIFACT_TYPES.includes(a))) add(i, `${label}: unknown artifact type.`);
    if (s.type === 'custom' && !s.instructions.trim()) add(i, `${label}: a custom stage needs instructions (what Claude should do).`);
    if (s.instructions.length > INSTRUCTIONS_MAX) add(i, `${label}: the instructions are longer than ${INSTRUCTIONS_MAX} characters.`);
    if (!BASH_MODES.includes(s.toolPolicy.bash)) add(i, `${label}: unknown shell mode.`);

    if (s.agentRef) {
      const ref = parseAgentRef(s.agentRef);
      if (!ref) add(i, `${label}: the agent reference is not valid.`);
      else if (ref.kind === 'plugin' && !PLUGIN_AGENTS.some((a) => a.name === ref.name)) add(i, `${label}: unknown plugin agent "${ref.name}".`);
      else if (ref.kind === 'custom' && opts.knownCustomAgentIds && !opts.knownCustomAgentIds.has(ref.id)) add(i, `${label}: the custom agent no longer exists.`);
    }

    s.rules.forEach((rule: GuardrailRuleInput, r) => {
      const problem = validateRuleInput(rule);
      if (problem) add(i, `${label}, rule ${r + 1}: ${problem}`);
    });
  });

  const at = (type: StageType) => typeIndex.get(type);
  const name = (type: StageType) => STAGE_TYPE_LABELS[type];
  const build = at('build');
  const raise = at('raise_pr');
  const resolve = at('resolve_comments');

  for (const after of ['self_review', 'qa'] as const) {
    const idx = at(after);
    if (build !== undefined && idx !== undefined && idx < build) add(idx, `${name(after)} must come after Build.`);
    if (raise !== undefined && idx !== undefined && idx > raise) add(idx, `${name(after)} must come before Raise PR.`);
  }
  if (raise !== undefined && build === undefined) add(raise, 'Raise PR requires a Build stage.');
  if (build !== undefined && raise !== undefined && raise < build) add(raise, 'Raise PR must come after Build.');
  if (resolve !== undefined) {
    if (raise === undefined) add(resolve, 'Resolve PR comments requires a Raise PR stage.');
    else if (resolve !== raise + 1) add(resolve, 'Resolve PR comments must come immediately after Raise PR.');
  }
  if (raise !== undefined) {
    draft.stages.forEach((s, i) => {
      if (i > raise && s.requiredForGate) add(i, `${s.name.trim() || `Stage ${i + 1}`}: a stage required for shipline/gates must come before Raise PR.`);
    });
  }
  return issues;
}

/** The key a stage gets in a saved version: built-in types use the type, custom ones a unique slug of the name. */
export function stageKeyFor(stage: Pick<StageDraftDTO, 'key' | 'type' | 'name'>, taken: ReadonlySet<string>): string {
  if (stage.key && !taken.has(stage.key)) return stage.key;
  if (stage.type !== 'custom' && !taken.has(stage.type)) return stage.type;
  const slug =
    stage.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'stage';
  const prefix = stage.type;
  let key = `${prefix}_${slug}`;
  for (let n = 2; taken.has(key); n++) key = `${prefix}_${slug}_${n}`;
  return key;
}
