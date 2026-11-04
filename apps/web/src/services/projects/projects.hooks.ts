import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProjectsService } from './projects.service';
import {
  CreateProjectInput,
  CreateProjectRuleInput,
  SaveProjectTemplatesInput,
  UpdateProjectInput,
  UpsertMemberInput,
  projectKeys,
} from './projects.types';
import { RuleInput } from '../admin/admin.types';

export function useProjects() {
  return useQuery({ queryKey: projectKeys.all(), queryFn: ProjectsService.getAll });
}

export function useProject(id: string) {
  return useQuery({ queryKey: projectKeys.detail(id), queryFn: () => ProjectsService.getById(id) });
}

export function useBoard(id: string) {
  return useQuery({ queryKey: projectKeys.board(id), queryFn: () => ProjectsService.getBoard(id) });
}

/** The org's templates with whether this project offers them (and its default): the new-chat picker and the settings card. */
export function useProjectTemplates(id: string) {
  return useQuery({ queryKey: projectKeys.templates(id), queryFn: () => ProjectsService.getTemplates(id), enabled: !!id });
}

export function useSaveProjectTemplates(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveProjectTemplatesInput) => ProjectsService.saveTemplates(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.templates(id) }),
  });
}

export function useProjectGuardrails(id: string) {
  return useQuery({ queryKey: projectKeys.guardrails(id), queryFn: () => ProjectsService.getGuardrails(id) });
}

export function useCreateProjectRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectRuleInput) => ProjectsService.createRule(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.guardrails(id) }),
  });
}

export function useUpdateProjectRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, rule }: { ruleId: string; rule: RuleInput }) => ProjectsService.updateRule(id, ruleId, rule),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.guardrails(id) }),
  });
}

export function useDeleteProjectRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) => ProjectsService.deleteRule(id, ruleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.guardrails(id) }),
  });
}

export function useGithubWarnings(id: string) {
  return useQuery({
    queryKey: projectKeys.githubWarnings(id),
    queryFn: () => ProjectsService.getGithubWarnings(id),
    retry: false,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => ProjectsService.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all() }),
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) => ProjectsService.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.detail(id) }),
  });
}

export function useUpsertMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertMemberInput) => ProjectsService.upsertMember(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.detail(id) }),
  });
}

export function useRemoveMember(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => ProjectsService.removeMember(id, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.detail(id) }),
  });
}
