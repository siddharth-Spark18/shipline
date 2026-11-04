import fs from 'fs';
import path from 'path';
import { git } from './git';

/** "git@github.com:owner/name.git" / "https://github.com/owner/name" -> "owner/name" */
export function normalizeRemote(url: string): string | null {
  const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

export class RepoError extends Error {
  constructor(
    public code: 'NO_WORKING_COPY' | 'NOT_A_REPO' | 'REPO_MISMATCH' | 'WORKTREE_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

/** Only repos registered to the Shipline project may host a session. */
export async function verifyWorkingCopy(repoPath: string | undefined, githubRepo: string): Promise<string> {
  if (!repoPath) {
    throw new RepoError('NO_WORKING_COPY', `Choose a local working copy for ${githubRepo} under Settings > Shipline Local.`);
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new RepoError('NOT_A_REPO', `${repoPath} is not a git working copy.`);
  }
  let remote: string;
  try {
    remote = await git(repoPath, ['remote', 'get-url', 'origin']);
  } catch {
    throw new RepoError('NOT_A_REPO', `${repoPath} has no "origin" remote.`);
  }
  if (normalizeRemote(remote) !== githubRepo.toLowerCase()) {
    throw new RepoError(
      'REPO_MISMATCH',
      `${repoPath} points at ${remote}, not ${githubRepo}. Shipline only starts sessions in the project's registered repo.`,
    );
  }
  return repoPath;
}

/**
 * OPEN-QUESTION #10: how non-dev roles get a working copy and git credentials is undecided (they
 * need a worktree too for Plan/Wireframes). v1 clones over HTTPS using whatever git credentials the user's machine already has; Shipline
 * stores no git credentials.
 */
export async function cloneWorkingCopy(githubRepo: string, targetDir: string): Promise<void> {
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new RepoError('NOT_A_REPO', `${targetDir} already exists and is not empty.`);
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  await git(path.dirname(targetDir), ['clone', `https://github.com/${githubRepo}.git`, targetDir]);
}
