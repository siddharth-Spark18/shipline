import { execFile } from 'child_process';

export interface GitResult {
  stdout: string;
  code: number;
}

/**
 * Runs the user's own `git`. Resolves with the exit code instead of rejecting for codes listed in
 * `okCodes` (e.g. `git diff --no-index` exits 1 when files differ).
 */
export function gitRun(cwd: string, args: string[], okCodes: number[] = [0]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout), code: 0 });
      const code = typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1;
      if (okCodes.includes(code)) return resolve({ stdout: String(stdout), code });
      reject(new Error(String(stderr).trim() || err.message));
    });
  });
}

/** stdout of a git command, trimmed. */
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRun(cwd, args)).stdout.trim();
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await gitRun(cwd, args);
    return true;
  } catch {
    return false;
  }
}
