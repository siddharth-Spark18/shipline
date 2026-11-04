import { ProjectMember, Role, User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/http-error';

export interface ProjectAccess {
  user: User;
  member: ProjectMember | null;
  /** Global admin (ADMIN_EMAILS) or project admin. */
  isAdmin: boolean;
  roles: Role[];
}

export async function getProjectAccess(userId: string, projectId: string): Promise<ProjectAccess> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new HttpError(401, 'User not found');
  const member = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId, projectId } },
  });
  return {
    user,
    member,
    isAdmin: user.isAdmin || !!member?.isAdmin,
    roles: member?.roles ?? [],
  };
}

/** Any project member, or a global admin. */
export async function requireProjectAccess(userId: string, projectId: string): Promise<ProjectAccess> {
  const access = await getProjectAccess(userId, projectId);
  if (!access.member && !access.user.isAdmin) {
    throw new HttpError(403, 'You are not a member of this project');
  }
  return access;
}

export async function requireProjectAdmin(userId: string, projectId: string): Promise<ProjectAccess> {
  const access = await getProjectAccess(userId, projectId);
  if (!access.isAdmin) throw new HttpError(403, 'Project admin access required');
  return access;
}

export async function requireGlobalAdmin(userId: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isAdmin) throw new HttpError(403, 'Admin access required');
  return user;
}
