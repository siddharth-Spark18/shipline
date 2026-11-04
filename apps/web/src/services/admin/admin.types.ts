import {
  CustomAgentDTO,
  CustomAgentInput,
  GuardrailRule,
  GuardrailRuleInput,
  ImportTemplateResultDTO,
  PluginAgentDTO,
  SaveTemplateRequestDTO,
  TemplateDetailDTO,
  TemplateDraftDTO,
  TemplateExportDTO,
  TemplateSummaryDTO,
  TemplateVersionDTO,
} from '@shipline/shared';

export const adminKeys = {
  templates: () => ['admin', 'templates'] as const,
  template: (id: string) => ['admin', 'templates', id] as const,
  version: (id: string, version: number) => ['admin', 'templates', id, 'versions', version] as const,
  agents: () => ['admin', 'agents'] as const,
  guardrails: () => ['admin', 'guardrails'] as const,
};

export type TemplateSummary = TemplateSummaryDTO;
export type TemplateDetail = TemplateDetailDTO;
export type TemplateVersion = TemplateVersionDTO;
export type TemplateDraft = TemplateDraftDTO;
export type SaveTemplateInput = SaveTemplateRequestDTO;
export type TemplateExport = TemplateExportDTO;
export type ImportTemplateResult = ImportTemplateResultDTO;
export type CustomAgent = CustomAgentDTO;
export type CustomAgentFormInput = CustomAgentInput;
export type PluginAgent = PluginAgentDTO;
export type Rule = GuardrailRule;
export type RuleInput = GuardrailRuleInput;

export interface AgentsResponse {
  custom: CustomAgent[];
  plugin: PluginAgent[];
}

export interface ImportTemplateInput {
  data: unknown;
  createMissingAgents?: boolean;
}
