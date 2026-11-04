import { execFile } from 'child_process';
import { ClaudeHealthDTO, meetsMinVersion, parseVersion } from '@shipline/shared';

/** The user's own installed, unmodified `claude`. Shipline never installs or patches it. */
export const CLAUDE_BIN = process.env.SHIPLINE_CLAUDE_BIN ?? 'claude';

export type ClaudeHealth = ClaudeHealthDTO;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeoutMs = 15_000, bin = CLAUDE_BIN): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const INSTALL_GUIDE =
  'Install Claude Code from https://docs.claude.com/en/docs/claude-code/setup, then run `claude` once and sign in with your own Claude account.';
const LOGIN_GUIDE =
  'Claude Code is not signed in. Run `claude` in a terminal and complete its login. Use your organization account if your team requires it (Shipline never sees your Claude credentials).';

export async function claudeHealth(minVersion: string | null = null): Promise<ClaudeHealth> {
  const v = await run(['--version']);
  if (!v.ok) {
    return {
      installed: false,
      version: null,
      loggedIn: false,
      meetsMinVersion: false,
      minVersion,
      guidance: INSTALL_GUIDE,
    };
  }
  const parsed = parseVersion(v.stdout);
  const version = parsed ? parsed.join('.') : v.stdout.trim();

  const auth = await run(['auth', 'status']);
  let loggedIn = auth.ok;
  try {
    const json = JSON.parse(auth.stdout) as { loggedIn?: boolean };
    if (typeof json.loggedIn === 'boolean') loggedIn = json.loggedIn;
  } catch {
    if (/not (logged|signed) in/i.test(auth.stdout + auth.stderr)) loggedIn = false;
  }

  const meets = meetsMinVersion(version, minVersion);
  const guidance = !loggedIn
    ? LOGIN_GUIDE
    : !meets
      ? `Claude Code ${version} is older than the required ${minVersion}. Update it with \`claude update\`.`
      : null;
  return { installed: true, version, loggedIn, meetsMinVersion: meets, minVersion, guidance };
}

/** The user's own GitHub CLI, used by Claude to raise the PR (Shipline has no GitHub App fallback). */
export async function ghInstalled(): Promise<boolean> {
  return (await run(['--version'], 15_000, 'gh')).ok;
}
