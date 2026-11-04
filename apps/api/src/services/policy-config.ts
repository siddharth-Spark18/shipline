import { Project, StageDefinition } from '@prisma/client';
import {
  DEFAULT_ROLE_EDIT_POLICIES,
  EDIT_POLICIES,
  EditPolicy,
  Role,
  RoleEditPolicies,
  StageToolPolicy,
} from '@shipline/shared';

export function projectEditPolicies(project: Pick<Project, 'editPolicy'>): RoleEditPolicies {
  const raw = (project.editPolicy ?? {}) as Partial<Record<Role, EditPolicy>>;
  const out = { ...DEFAULT_ROLE_EDIT_POLICIES };
  for (const role of Object.keys(out) as Role[]) {
    const v = raw[role];
    if (v && EDIT_POLICIES.includes(v)) out[role] = v;
  }
  return out;
}

export function stageToolPolicy(def: Pick<StageDefinition, 'toolPolicy'>): StageToolPolicy {
  return def.toolPolicy as unknown as StageToolPolicy;
}
