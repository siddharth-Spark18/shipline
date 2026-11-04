// The user's own installed `claude`: where it is, whether it is usable, and the one place that owns its
// argv. Node 20+, no dependencies. claudeHealth follows the v1 hub (removed).
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { meetsMinVersion, parseVersion } from './versions.mjs';

// UNVERIFIED (chat test item 19, recorded version): 2.1.317 is the installed version, not yet the version the chat test records.
export const MIN_CLAUDE_VERSION = '2.1.317';

// UNVERIFIED (chat test Q5): whether MCP_TOOL_TIMEOUT in claude's environment raises its limit on a
// long permission-prompt call. null = leave the environment alone; set to '660000' if Q5 says it helps.
export const MCP_TOOL_TIMEOUT_ENV = null;

export const PERMISSION_TOOL = 'mcp__shipline_ui__approve';

// Flags the UI must never pass: the user's committed settings, hooks, agents and MCP servers apply as in
// the terminal.
export const FORBIDDEN_FLAGS = [
  '--bare',
  '--settings',
  '--plugin-dir',
  '--allowedTools',
  '--append-system-prompt',
  '--strict-mcp-config',
];

// SHIPLINE_CLAUDE_BIN (tests only), otherwise the first `claude` on PATH, or null.
export function findClaude() {
  if (process.env.SHIPLINE_CLAUDE_BIN) return process.env.SHIPLINE_CLAUDE_BIN;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, `claude${ext}`);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

const quoteWin = (s) => `"${String(s).replace(/"/g, '""')}"`;

// How to start `bin` with `args`. On Windows a `.cmd`/`.bat` (an npm install of Claude Code, or the test shim)
// can only run through a shell (Node refuses with EINVAL otherwise), so the command and every argument are
// double-quoted by hand (`"` inside is doubled). Anything else is started directly.
export function startSpec(bin, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return {
      command: quoteWin(bin),
      args: args.map(quoteWin),
      options: { shell: true, windowsHide: true },
    };
  }
  return { command: bin, args, options: {} };
}

function run(bin, args, timeoutMs = 15_000) {
  const spec = startSpec(bin, args);
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      { ...spec.options, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const INSTALL_GUIDE =
  'Install Claude Code and sign in, then reload. See https://docs.claude.com/en/docs/claude-code/setup.';
const LOGIN_GUIDE =
  'Claude Code is not signed in. Run `claude` in a terminal and complete its login (Shipline never sees your Claude credentials).';

// { installed, bin, version, loggedIn, meetsMinVersion, minVersion, guidance }
export async function claudeHealth(minVersion = MIN_CLAUDE_VERSION) {
  const bin = findClaude();
  if (!bin) {
    return {
      installed: false,
      bin: null,
      version: null,
      loggedIn: false,
      meetsMinVersion: false,
      minVersion,
      guidance: INSTALL_GUIDE,
    };
  }
  const v = await run(bin, ['--version']);
  if (!v.ok) {
    return {
      installed: false,
      bin,
      version: null,
      loggedIn: false,
      meetsMinVersion: false,
      minVersion,
      guidance: INSTALL_GUIDE,
    };
  }
  const parsed = parseVersion(v.stdout);
  const version = parsed ? parsed.join('.') : v.stdout.trim();

  const auth = await run(bin, ['auth', 'status']);
  let loggedIn = auth.ok;
  try {
    const json = JSON.parse(auth.stdout);
    if (typeof json.loggedIn === 'boolean') loggedIn = json.loggedIn;
  } catch {
    if (/not (logged|signed) in/i.test(auth.stdout + auth.stderr)) loggedIn = false;
  }

  const meets = meetsMinVersion(version, minVersion);
  const guidance = !meets
    ? `Claude Code ${version} is older than the required ${minVersion}. Update it with \`claude update\`.`
    : !loggedIn
      ? LOGIN_GUIDE
      : null;
  return { installed: true, bin, version, loggedIn, meetsMinVersion: meets, minVersion, guidance };
}

// The exact argv from the plan. A new chat passes --session-id, a continued one --resume (never
// --fork-session). Throws if a forbidden flag is ever included.
export function buildArgs({ sessionId, resume = false, mcpConfig }) {
  const argv = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // UNVERIFIED (chat test Q1): the session id stays the same across --session-id and --resume.
    resume ? '--resume' : '--session-id',
    sessionId,
    '--mcp-config',
    mcpConfig,
    // UNVERIFIED (chat test Q3): AskUserQuestion is routed through --permission-prompt-tool under -p.
    '--permission-prompt-tool',
    PERMISSION_TOOL,
  ];
  for (const a of argv) {
    if (FORBIDDEN_FLAGS.includes(a) || a === '--fork-session')
      throw new Error(`Refusing to pass ${a} to claude`);
  }
  return argv;
}
