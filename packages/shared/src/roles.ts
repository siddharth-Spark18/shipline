export const ROLES = ['DEVELOPER', 'DESIGNER', 'PM', 'QA'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  DEVELOPER: 'Developer',
  DESIGNER: 'Designer',
  PM: 'PM',
  QA: 'QA',
};

/** Plural form used in denial reasons, e.g. "Designers can't edit code". */
export const ROLE_PLURAL_LABELS: Record<Role, string> = {
  DEVELOPER: 'Developers',
  DESIGNER: 'Designers',
  PM: 'PMs',
  QA: 'QA',
};

/** What a role may do with code-editing tools when it owns a stage. */
export const EDIT_POLICIES = ['deny', 'ask', 'allow'] as const;
export type EditPolicy = (typeof EDIT_POLICIES)[number];

export type RoleEditPolicies = Record<Role, EditPolicy>;

export const DEFAULT_ROLE_EDIT_POLICIES: RoleEditPolicies = {
  DEVELOPER: 'allow',
  DESIGNER: 'deny',
  PM: 'deny',
  QA: 'deny',
};

export const SESSION_MODES = ['chat', 'terminal'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
