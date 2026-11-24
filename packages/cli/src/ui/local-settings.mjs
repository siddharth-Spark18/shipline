// The permission rule a card offers to remember, and the one writer of .claude/settings.local.json. The UI only ever
// appends to permissions.allow in the chat's own repo. Node 20+, no dependencies.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.mjs';

// Tools whose first word alone is too broad: the rule keeps the sub-command too (`git status`, `npm run`).
const TWO_WORD_TOOLS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'bunx',
  'docker',
  'kubectl',
  'gh',
  'cargo',
  'go',
  'uv',
  'pip',
  'pip3',
  'poetry',
  'make',
]);
const PYTHONS = new Set(['python', 'python3']);

// Anything that chains, pipes, redirects, backgrounds, substitutes or groups commands (or spans lines), and a
// leading VAR=value assignment. Quotes are not parsed: a command that merely quotes one of these gets the exact-command
// rule, which is the narrow side to err on.
const COMPOUND = /&|\||;|`|\$\(|[<>()\r\n]|^\s*[A-Za-z_][A-Za-z0-9_]*=/;

// Claude Code's rule syntax: `\`, `(` and `)` inside the content are escaped with a backslash.
const escapeContent = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

function bashRule(command) {
  const cmd = command.trim();
  if (!cmd) return null;
  if (COMPOUND.test(cmd)) return `Bash(${escapeContent(cmd)})`;
  const words = cmd.split(/\s+/);
  const first = words[0];
  let prefix = first;
  if (TWO_WORD_TOOLS.has(first) && words[1]) prefix = `${first} ${words[1]}`;
  else if (PYTHONS.has(first) && words[1] === '-m' && words[2]) prefix = `${first} -m ${words[2]}`;
  return `Bash(${prefix}:*)`;
}

// The allow rule for one tool call, or null when the card should not offer to remember it.
//   Bash, one simple command   Bash(<prefix>:*)   (see TWO_WORD_TOOLS; `python -m <mod>`; otherwise the first word)
//   Bash, compound             Bash(<the exact command>)
//   WebFetch                   WebFetch(domain:<host>)
//   AskUserQuestion            null (it is a question, not a permission)
//   anything else              the tool name (Edit, Write, mcp__server__tool, ...)
export function ruleFor(tool, input) {
  if (typeof tool !== 'string' || !tool || tool === 'AskUserQuestion') return null;
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') return typeof i.command === 'string' ? bashRule(i.command) : null;
  if (tool === 'WebFetch') {
    try {
      const u = new URL(String(i.url));
      return u.protocol === 'http:' || u.protocol === 'https:'
        ? `WebFetch(domain:${u.hostname})`
        : null;
    } catch {
      return null;
    }
  }
  return tool;
}

// 'Bash(git status:*)' -> { toolName: 'Bash', ruleContent: 'git status:*' }; 'Edit' -> { toolName: 'Edit' }. This is
// the shape of a rule in an `updatedPermissions` entry.
export function splitRule(rule) {
  const m = /^([^(]+)\(([^]*)\)$/.exec(rule);
  return m ? { toolName: m[1], ruleContent: m[2] } : { toolName: rule };
}

export const localSettingsPath = (root) => path.join(root, '.claude', 'settings.local.json');

// Adds `rule` to permissions.allow (the file and the lists are created when missing, everything else is kept, 2-space
// JSON). Returns { added, file }; added is false when the rule was already there. Throws HttpError 409
// settings-unreadable (invalid JSON, or a shape that is not an object / list) naming the file, and 500 settings-write.
export function appendAllowRule(root, rule) {
  const file = localSettingsPath(root);
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new HttpError(
        409,
        'settings-unreadable',
        `Could not read ${file}: ${e && e.message}. Fix or remove the file, then try again.`,
      );
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new HttpError(409, 'settings-unreadable', `${file} is not a JSON object.`);
  }
  if (settings.permissions === undefined) settings.permissions = {};
  const perms = settings.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms))
    throw new HttpError(409, 'settings-unreadable', `"permissions" in ${file} is not an object.`);
  if (perms.allow === undefined) perms.allow = [];
  if (!Array.isArray(perms.allow))
    throw new HttpError(
      409,
      'settings-unreadable',
      `"permissions.allow" in ${file} is not a list.`,
    );
  if (perms.allow.includes(rule)) return { added: false, file };
  perms.allow.push(rule);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e) {
    throw new HttpError(500, 'settings-write', `Could not write ${file}: ${e && e.message}`);
  }
  return { added: true, file };
}
