import api from '@/lib/api';
import {
  AgentsResponse,
  CustomAgent,
  CustomAgentFormInput,
  ImportTemplateInput,
  ImportTemplateResult,
  Rule,
  RuleInput,
  SaveTemplateInput,
  TemplateDetail,
  TemplateDraft,
  TemplateExport,
  TemplateSummary,
  TemplateVersion,
} from './admin.types';

/** Org admin endpoints: the workflow template library, custom agents and the org guardrail baseline. */
export class AdminService {
  static async getTemplates() {
    const { data } = await api.get<TemplateSummary[]>('/admin/templates');
    return data;
  }

  static async getTemplate(id: string) {
    const { data } = await api.get<TemplateDetail>(`/admin/templates/${id}`);
    return data;
  }

  static async getVersion(id: string, version: number) {
    const { data } = await api.get<TemplateVersion>(`/admin/templates/${id}/versions/${version}`);
    return data;
  }

  static async createTemplate(draft: TemplateDraft) {
    const { data } = await api.post<TemplateDetail>('/admin/templates', draft);
    return data;
  }

  static async saveTemplate(id: string, input: SaveTemplateInput) {
    const { data } = await api.put<TemplateDetail>(`/admin/templates/${id}`, input);
    return data;
  }

  static async archiveTemplate(id: string) {
    await api.post<TemplateSummary>(`/admin/templates/${id}/archive`);
  }

  static async restoreTemplate(id: string) {
    await api.post<TemplateSummary>(`/admin/templates/${id}/restore`);
  }

  static async deleteTemplate(id: string) {
    await api.delete<void>(`/admin/templates/${id}`);
  }

  static async exportTemplate(id: string) {
    const { data } = await api.get<TemplateExport>(`/admin/templates/${id}/export`);
    return data;
  }

  static async importTemplate(input: ImportTemplateInput) {
    const { data } = await api.post<ImportTemplateResult>('/admin/templates/import', input);
    return data;
  }

  static async getAgents() {
    const { data } = await api.get<AgentsResponse>('/admin/agents');
    return data;
  }

  static async createAgent(input: CustomAgentFormInput) {
    const { data } = await api.post<CustomAgent>('/admin/agents', input);
    return data;
  }

  static async updateAgent(id: string, input: Omit<CustomAgentFormInput, 'name'>) {
    const { data } = await api.put<CustomAgent>(`/admin/agents/${id}`, input);
    return data;
  }

  static async deleteAgent(id: string) {
    await api.delete<void>(`/admin/agents/${id}`);
  }

  static async getOrgRules() {
    const { data } = await api.get<Rule[]>('/admin/guardrails');
    return data;
  }

  static async createOrgRule(rule: RuleInput) {
    const { data } = await api.post<Rule>('/admin/guardrails', rule);
    return data;
  }

  static async updateOrgRule(id: string, rule: RuleInput) {
    const { data } = await api.put<Rule>(`/admin/guardrails/${id}`, rule);
    return data;
  }

  static async deleteOrgRule(id: string) {
    await api.delete<void>(`/admin/guardrails/${id}`);
  }
}
