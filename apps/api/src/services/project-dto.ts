import { Project, Role } from '@prisma/client';
import { LocalProjectDTO } from '@shipline/shared';
import { projectEditPolicies } from './policy-config';

export function toLocalProject(project: Project, roles: Role[], isAdmin: boolean): LocalProjectDTO {
  return {
    id: project.id,
    name: project.name,
    githubRepo: project.githubRepo,
    keyPrefix: project.keyPrefix,
    baseBranch: project.baseBranch,
    sessionMode: project.sessionMode === 'CHAT' ? 'chat' : 'terminal',
    roles,
    isAdmin,
    minPluginVersion: project.minPluginVersion,
    minClaudeCliVersion: project.minClaudeCliVersion,
    qaTarget: project.qaTarget,
    editPolicy: projectEditPolicies(project),
  };
}
