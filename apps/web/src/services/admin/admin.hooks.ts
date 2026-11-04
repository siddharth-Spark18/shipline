import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminService } from './admin.service';
import { CustomAgentFormInput, ImportTemplateInput, RuleInput, SaveTemplateInput, TemplateDraft, adminKeys } from './admin.types';

export function useTemplateList() {
  return useQuery({ queryKey: adminKeys.templates(), queryFn: AdminService.getTemplates });
}

export function useTemplateDetail(id: string, enabled = true) {
  return useQuery({ queryKey: adminKeys.template(id), queryFn: () => AdminService.getTemplate(id), enabled });
}

export function useTemplateVersion(id: string, version: number | null) {
  return useQuery({
    queryKey: adminKeys.version(id, version ?? 0),
    queryFn: () => AdminService.getVersion(id, version ?? 0),
    enabled: version !== null,
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: TemplateDraft) => AdminService.createTemplate(draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.templates() }),
  });
}

export function useSaveTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveTemplateInput) => AdminService.saveTemplate(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.templates() }),
  });
}

export function useArchiveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archive }: { id: string; archive: boolean }) => (archive ? AdminService.archiveTemplate(id) : AdminService.restoreTemplate(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.templates() }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => AdminService.deleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.templates() }),
  });
}

export function useImportTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportTemplateInput) => AdminService.importTemplate(input),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: adminKeys.templates() }), qc.invalidateQueries({ queryKey: adminKeys.agents() })]),
  });
}

export function useAgents() {
  return useQuery({ queryKey: adminKeys.agents(), queryFn: AdminService.getAgents });
}

export function useSaveAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: CustomAgentFormInput }) =>
      id ? AdminService.updateAgent(id, input) : AdminService.createAgent(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.agents() }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => AdminService.deleteAgent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.agents() }),
  });
}

export function useOrgRules() {
  return useQuery({ queryKey: adminKeys.guardrails(), queryFn: AdminService.getOrgRules });
}

export function useSaveOrgRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rule }: { id: string | null; rule: RuleInput }) => (id ? AdminService.updateOrgRule(id, rule) : AdminService.createOrgRule(rule)),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.guardrails() }),
  });
}

export function useDeleteOrgRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => AdminService.deleteOrgRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.guardrails() }),
  });
}
