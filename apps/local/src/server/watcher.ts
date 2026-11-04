import fs from 'fs';
import path from 'path';
import { git } from './git';

const IGNORED = /(^|[\\/])(\.git|node_modules|\.next|dist)([\\/]|$)/;
const DEBOUNCE_MS = 500;

/**
 * Calls `onChange` (debounced) when files in the worktree change or git's HEAD/index move (a
 * commit, checkout or `git add` inside the worktree). Returns a stop function.
 */
export async function watchWorktree(worktree: string, onChange: () => void): Promise<() => void> {
  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };
  const watchers: fs.FSWatcher[] = [];
  const add = (target: string, recursive: boolean, filter: (name: string) => boolean): void => {
    try {
      const w = fs.watch(target, { recursive }, (_event, name) => {
        if (name && filter(String(name))) fire();
      });
      w.on('error', () => undefined);
      watchers.push(w);
    } catch {
      // Recursive watching is unavailable on some platforms; the UI still refreshes after tool results.
    }
  };

  add(worktree, true, (name) => !IGNORED.test(name));
  try {
    const gitDir = path.resolve(worktree, await git(worktree, ['rev-parse', '--git-dir']));
    add(gitDir, false, (name) => name === 'HEAD' || name === 'index');
  } catch {
    // Not fatal: file watching still works.
  }

  return () => {
    if (timer) clearTimeout(timer);
    watchers.forEach((w) => w.close());
  };
}
