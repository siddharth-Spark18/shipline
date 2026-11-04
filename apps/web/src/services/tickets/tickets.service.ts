import api from '@/lib/api';
import {
  AuditEventRow,
  ChatRow,
  CreateChatInput,
  CreateChatResult,
  OverrideInput,
  StageTransition,
  TemplateSwitch,
  TemplateSwitchDecisionResult,
  TicketDetail,
  TicketPrComments,
  ToolDecisionRow,
  TransitionDecisionResult,
} from './tickets.types';

export class TicketsService {
  static async getChats() {
    const { data } = await api.get<ChatRow[]>('/chats');
    return data;
  }

  static async createChat(input: CreateChatInput) {
    const { data } = await api.post<CreateChatResult>('/chats', input);
    return data;
  }

  static async rename(id: string, title: string) {
    await api.patch<void>(`/tickets/${id}`, { title });
  }

  static async getById(id: string) {
    const { data } = await api.get<TicketDetail>(`/tickets/${id}`);
    return data;
  }

  static async getAudit(id: string) {
    const { data } = await api.get<AuditEventRow[]>(`/tickets/${id}/audit`);
    return data;
  }

  static async getToolDecisions(id: string) {
    const { data } = await api.get<ToolDecisionRow[]>(`/tickets/${id}/tool-decisions`);
    return data;
  }

  static async override(id: string, input: OverrideInput) {
    await api.post<{ id: string }>(`/tickets/${id}/override`, input);
  }

  static async getTransitions(id: string) {
    const { data } = await api.get<StageTransition[]>(`/tickets/${id}/transitions`);
    return data;
  }

  static async decideTransition(id: string, transitionId: string, confirm: boolean) {
    const { data } = await api.post<TransitionDecisionResult>(
      `/tickets/${id}/transitions/${transitionId}/${confirm ? 'confirm' : 'decline'}`,
    );
    return data;
  }

  static async getTemplateSwitches(id: string) {
    const { data } = await api.get<TemplateSwitch[]>(`/tickets/${id}/template-switches`);
    return data;
  }

  static async decideTemplateSwitch(id: string, switchId: string, confirm: boolean) {
    const { data } = await api.post<TemplateSwitchDecisionResult>(
      `/tickets/${id}/template-switches/${switchId}/${confirm ? 'confirm' : 'decline'}`,
    );
    return data;
  }

  static async getPrComments(id: string) {
    const { data } = await api.get<TicketPrComments>(`/tickets/${id}/pr-comments`);
    return data;
  }

  static async markPrCommentsSent(id: string, ids: string[]) {
    await api.post<void>(`/tickets/${id}/pr-comments/mark-sent`, { ids });
  }
}
