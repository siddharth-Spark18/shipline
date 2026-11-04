import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TicketsService } from './tickets.service';
import { DecideTemplateSwitchInput, DecideTransitionInput, OverrideInput, ticketKeys } from './tickets.types';

/** The user's chats (the chat list / switcher). */
export function useChats() {
  return useQuery({ queryKey: ticketKeys.chats(), queryFn: TicketsService.getChats, refetchInterval: 15_000 });
}

export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: TicketsService.createChat,
    onSuccess: () => qc.invalidateQueries({ queryKey: ticketKeys.chats() }),
  });
}

export function useRenameChat(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => TicketsService.rename(id, title),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }), qc.invalidateQueries({ queryKey: ticketKeys.chats() })]),
  });
}

/** The workspace refreshes the ticket often: stages, PR state and comment counts change under it. */
export function useTicket(id: string, live = false) {
  return useQuery({
    queryKey: ticketKeys.detail(id),
    queryFn: () => TicketsService.getById(id),
    refetchInterval: live ? 8_000 : false,
  });
}

export function useTicketAudit(id: string) {
  return useQuery({ queryKey: ticketKeys.audit(id), queryFn: () => TicketsService.getAudit(id) });
}

export function useTicketToolDecisions(id: string) {
  return useQuery({ queryKey: ticketKeys.toolDecisions(id), queryFn: () => TicketsService.getToolDecisions(id) });
}

export function useOverrideTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OverrideInput) => TicketsService.override(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
  });
}

export function useTransitions(id: string, poll: boolean) {
  return useQuery({
    queryKey: ticketKeys.transitions(id),
    queryFn: () => TicketsService.getTransitions(id),
    refetchInterval: poll ? 2_000 : false,
  });
}

/** Confirm / "Not yet" on a proposal. The caller then tells Claude (via the local service). */
export function useDecideTransition(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideTransitionInput) =>
      TicketsService.decideTransition(ticketId, input.transitionId, input.confirm),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.transitions(ticketId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.chats() }),
        qc.invalidateQueries({ queryKey: ticketKeys.audit(ticketId) }),
      ]),
  });
}

export function useTemplateSwitches(id: string, poll: boolean) {
  return useQuery({
    queryKey: ticketKeys.templateSwitches(id),
    queryFn: () => TicketsService.getTemplateSwitches(id),
    refetchInterval: poll ? 2_000 : false,
  });
}

/** Confirm / "Not yet" on a template switch proposal. The caller then tells Claude (via the local service). */
export function useDecideTemplateSwitch(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideTemplateSwitchInput) => TicketsService.decideTemplateSwitch(ticketId, input.switchId, input.confirm),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.templateSwitches(ticketId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.chats() }),
        qc.invalidateQueries({ queryKey: ticketKeys.audit(ticketId) }),
      ]),
  });
}

export function usePrComments(id: string) {
  return useQuery({
    queryKey: ticketKeys.prComments(id),
    queryFn: () => TicketsService.getPrComments(id),
    refetchInterval: 15_000,
  });
}

export function useMarkPrCommentsSent(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => TicketsService.markPrCommentsSent(ticketId, ids),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.prComments(ticketId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) }),
        qc.invalidateQueries({ queryKey: ticketKeys.chats() }),
      ]),
  });
}
