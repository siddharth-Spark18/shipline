import fs from 'fs';
import path from 'path';
import { slugify } from '@shipline/shared';
import { git, gitOk } from './git';
import { RepoError } from './repo';

export { slugify };

export interface Workspace {
  worktreePath: string;
  /** Null while the worktree is detached: the named branch is created at the chat's first edit. */
  branch: string | null;
}

/** `<working-copy>.shipline/<KEY>`: a sibling of the working copy, one folder per chat. */
export function worktreeDir(repoPath: string, ticketKey: string): string {
  return path.join(`${repoPath.replace(/[\\/]+$/, '')}.shipline`, ticketKey);
}

async function commonDir(cwd: string): Promise<string> {
  return fs.realpathSync(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])));
}

/** The checked-out branch of a worktree, or null when HEAD is detached. */
export async function currentBranch(worktree: string): Promise<string | null> {
  const name = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return name === 'HEAD' ? null : name;
}

/**
 * Creates (or reuses) the chat's git worktree. A new worktree is DETACHED at the project's base
 * branch (a snapshot, no branch yet) so Claude can start in it from the first message: Claude Code
 * ties a conversation to the folder it started in, and `--resume` must keep working. The named
 * branch is created later by `ensureBranch`.
 *
 * An existing folder is reused only when it belongs to this chat: a worktree of this repo that is
 * detached or on the chat's branch (the known branch, or one named after the chat key / Jira key).
 * Otherwise this throws naming the path.
 */
export async function ensureWorktree(args: {
  repoPath: string;
  ticketKey: string;
  jiraKey: string | null;
  baseBranch: string;
  /** Branch the hub already knows for this chat, if any (resume after the folder was removed). */
  knownBranch: string | null;
}): Promise<Workspace> {
  const { repoPath, ticketKey, baseBranch, knownBranch } = args;
  const dir = worktreeDir(repoPath, ticketKey);
  const ownBranch = (name: string): boolean =>
    name === knownBranch ||
    name.startsWith(`${ticketKey}-`) ||
    (!!args.jiraKey && name.startsWith(`${args.jiraKey}-`));

  if (fs.existsSync(dir)) {
    let sameRepo = false;
    let branch: string | null = null;
    try {
      sameRepo = (await commonDir(dir)) === (await commonDir(repoPath));
      branch = await currentBranch(dir);
    } catch {
      sameRepo = false;
    }
    if (!sameRepo || (branch !== null && !ownBranch(branch))) {
      throw new RepoError(
        'WORKTREE_CONFLICT',
        `${dir} already exists but is not the worktree for ${ticketKey} (expected a worktree of ${repoPath}, detached or on a ${ticketKey}-* branch). Move or remove it, then start again.`,
      );
    }
    return { worktreePath: dir, branch };
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });

  if (knownBranch && (await gitOk(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${knownBranch}`]))) {
    try {
      await git(repoPath, ['worktree', 'add', dir, knownBranch]);
    } catch (err) {
      throw new RepoError('WORKTREE_CONFLICT', `Branch ${knownBranch} exists but could not be checked out at ${dir}: ${(err as Error).message}`);
    }
    return { worktreePath: dir, branch: knownBranch };
  }

  await gitOk(repoPath, ['fetch', 'origin', baseBranch]); // best effort: offline still works from the local base
  const baseRef = (await gitOk(repoPath, ['rev-parse', '--verify', `origin/${baseBranch}`])) ? `origin/${baseBranch}` : baseBranch;
  try {
    await git(repoPath, ['worktree', 'add', '--detach', dir, baseRef]);
  } catch (err) {
    throw new RepoError('WORKTREE_CONFLICT', `Could not create the worktree at ${dir} from ${baseRef}: ${(err as Error).message}`);
  }
  return { worktreePath: dir, branch: null };
}

// One branch creation at a time per worktree: parallel tool calls can each ask for it.
const inFlight = new Map<string, Promise<string>>();

/**
 * Creates the chat's named branch in its worktree (`git switch -c`), just before the first edit is
 * allowed to run. Idempotent: if the worktree is already on a branch, that branch is returned. If
 * the wanted name is taken by another branch, a numeric suffix is added. Uncommitted work (there is
 * none yet at the first edit) would carry over, as `switch -c` keeps the working tree.
 */
export function ensureBranch(worktree: string, wanted: string): Promise<string> {
  const running = inFlight.get(worktree);
  if (running) return running;
  const task = (async () => {
    const existing = await currentBranch(worktree);
    if (existing) return existing;
    let name = wanted;
    for (let n = 2; await gitOk(worktree, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]); n++) {
      name = `${wanted}-${n}`;
    }
    await git(worktree, ['switch', '-c', name]);
    return name;
  })().finally(() => inFlight.delete(worktree));
  inFlight.set(worktree, task);
  return task;
}
