import { Role } from '@shipline/shared';

export const authKeys = {
  me: () => ['auth', 'me'] as const,
};

export interface Membership {
  projectId: string;
  roles: Role[];
  isAdmin: boolean;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  githubLogin: string | null;
  memberships: Membership[];
}
