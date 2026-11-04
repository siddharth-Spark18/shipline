import api from '@/lib/api';
import {
  BoardChat,
  CreateProjectInput,
  CreateProjectRuleInput,
  GithubWarningsResponse,
  Project,
  ProjectDetail,
  ProjectGuardrails,
  ProjectTemplate,
  SaveProjectTemplatesInput,
  UpdateProjectInput,
  UpsertMemberInput,
} from './projects.types';
import { Rule, RuleInput } from '../admin/admin.types';

export class ProjectsService {
  static async getAll() {
    const { data } = await api.get<Project[]>('/projects');
    return data;
  }

  static async getById(id: string) {
    const { data } = await api.get<ProjectDetail>(`/projects/${id}`);
    return data;
  }

  static async create(input: CreateProjectInput) {
    const { data } = await api.post<Project>('/projects', input);
    return data;
  }

  static async update(id: string, input: UpdateProjectInput) {
    const { data } = await api.patch<Project>(`/projects/${id}`, input);
    return data;
  }

  static async upsertMember(id: string, input: UpsertMemberInput) {
    await api.put<void>(`/projects/${id}/members`, input);
  }

  static async removeMember(id: string, userId: string) {
    await api.delete<void>(`/projects/${id}/members/${userId}`);
  }

  static async getGithubWarnings(id: string) {
    const { data } = await api.get<GithubWarningsResponse>(`/projects/${id}/github-warnings`);
    return data;
  }

  static async getBoard(id: string) {
    const { data } = await api.get<BoardChat[]>(`/projects/${id}/chats`);
    return data;
  }

  static async getTemplates(id: string) {
    const { data } = await api.get<ProjectTemplate[]>(`/projects/${id}/templates`);
    return data;
  }

  static async saveTemplates(id: string, input: SaveProjectTemplatesInput) {
    await api.put<void>(`/projects/${id}/templates`, input);
  }

  static async getGuardrails(id: string) {
    const { data } = await api.get<ProjectGuardrails>(`/projects/${id}/guardrails`);
    return data;
  }

  static async createRule(id: string, input: CreateProjectRuleInput) {
    const { data } = await api.post<Rule>(`/projects/${id}/guardrails`, input);
    return data;
  }

  static async updateRule(id: string, ruleId: string, rule: RuleInput) {
    const { data } = await api.put<Rule>(`/projects/${id}/guardrails/${ruleId}`, rule);
    return data;
  }

  static async deleteRule(id: string, ruleId: string) {
    await api.delete<void>(`/projects/${id}/guardrails/${ruleId}`);
  }
}
