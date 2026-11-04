import type { EditPolicy, Role } from './roles';
import { ROLE_LABELS } from './roles';

// Guardrail rules: path, Bash and tool rules at four levels (org, project, role, stage). Every tool
// call is decided against all matching rules, strictest wins (deny > ask > allow). The matcher is
// dependency-free on purpose: the plugin's guard hook runs a bundled build of this file
// (packages/plugin/scripts/vendor/guardrails.mjs). After changing it, run
// `pnpm --filter @shipline/shared build:plugin-matcher`.

export const RULE_LEVELS = ['org', 'project', 'role', 'stage'] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];

export const RULE_LEVEL_LABELS: Record<RuleLevel, string> = {
  org: 'Org',
  project: 'Project',
  role: 'Role',
  stage: 'Stage',
};

export const RULE_KINDS = ['path', 'bash', 'tool'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RULE_KIND_LABELS: Record<RuleKind, string> = { path: 'Path', bash: 'Bash command', tool: 'Tool' };

export const PATH_ACTIONS = ['read', 'edit'] as const;
export type PathAction = (typeof PATH_ACTIONS)[number];

/** The effect of a rule; the same three values as a role's code-edit policy. */
export type RuleEffect = EditPolicy;

/** What an admin enters (org, project and role rules are stored one by one; stage rules inside a template version). */
export interface GuardrailRuleInput {
  kind: RuleKind;
  /** path: a glob. bash: `Bash(prefix:*)` or `Bash(exact command)`. tool: a tool name, or `prefix*`. */
  pattern: string;
  /** Path rules only: which accesses the rule covers. */
  actions: PathAction[];
  effect: RuleEffect;
  /** Short reason shown to the user and to Claude on deny or ask. */
  reason: string;
}

export interface GuardrailRule extends GuardrailRuleInput {
  id: string;
  level: RuleLevel;
  /** Role-level rules only. */
  role?: Role;
}

/** The rules that apply to one chat: org + project + the project's role rules + the current stage's rules. */
export interface EffectiveRules {
  org: GuardrailRule[];
  project: GuardrailRule[];
  roles: Partial<Record<Role, GuardrailRule[]>>;
  stage: GuardrailRule[];
}

export const EMPTY_RULES: EffectiveRules = { org: [], project: [], roles: {}, stage: [] };

/** "Org rule: Never touch env files", "Role rule (Designer): ...". */
export function describeRule(rule: Pick<GuardrailRule, 'level' | 'role' | 'reason'>): string {
  const label = RULE_LEVEL_LABELS[rule.level];
  const who = rule.level === 'role' && rule.role ? ` (${ROLE_LABELS[rule.role]})` : '';
  return `${label} rule${who}: ${rule.reason}`;
}

// --- Globs ---

const regexCache = new Map<string, RegExp>();

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function convertGlob(g: string): string {
  let re = '';
  let i = 0;
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      let j = i;
      while (g[j] === '*') j++;
      if (j - i >= 2) {
        if (g[j] === '/') {
          re += '(?:.*/)?'; // `**/` is zero or more directories
          i = j + 1;
        } else {
          re += '.*';
          i = j;
        }
      } else {
        re += '[^/]*';
        i = j;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < g.length; j++) {
        if (g[j] === '{') depth++;
        else if (g[j] === '}' && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) {
        re += '\\{';
        i++;
      } else {
        const alts: string[] = [];
        let cur = '';
        let d = 0;
        for (const c of g.slice(i + 1, end)) {
          if (c === '{') d++;
          if (c === '}') d--;
          if (c === ',' && d === 0) {
            alts.push(cur);
            cur = '';
          } else cur += c;
        }
        alts.push(cur);
        re += `(?:${alts.map(convertGlob).join('|')})`;
        i = end + 1;
      }
    } else if (ch === '[') {
      const end = g.indexOf(']', i + 2);
      if (end < 0) {
        re += '\\[';
        i++;
      } else {
        let body = g.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end + 1;
      }
    } else {
      re += escapeRegex(ch);
      i++;
    }
  }
  return re;
}

/**
 * Glob to regex (picomatch-style): `*` and `?` stay inside one path segment, `**` crosses segments
 * (`**` + `/` matches zero or more directories), `{a,b}` alternatives and `[abc]` classes. A pattern
 * without a slash matches at any depth (`.env*` matches `apps/api/.env.local`, like a gitignore).
 * Dotfiles are matched like any other file. Throws when the glob is not valid.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  let g = glob.trim().replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  const re = new RegExp(`^${convertGlob(g)}$`);
  regexCache.set(glob, re);
  return re;
}

/** Lexically resolves `.` and `..` so `src/../.env` cannot dodge a rule. */
function resolveSegments(path: string): string {
  const abs = path.startsWith('/');
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  return `${abs ? '/' : ''}${out.join('/')}`;
}

export interface NormalizedPath {
  /** Relative to the worktree root when inside it, otherwise the absolute path. */
  rel: string;
  /** Absolute path when known (the worktree root is known, or the path was absolute). */
  abs: string | null;
}

/** Paths are matched relative to the worktree root; a path outside it counts as outside (absolute). */
export function normalizePath(filePath: string, root?: string | null): NormalizedPath {
  const p = filePath.replace(/\\/g, '/');
  const r = root ? resolveSegments(root.replace(/\\/g, '/')) : null;
  if (p.startsWith('/')) {
    const abs = resolveSegments(p);
    if (r && abs === r) return { rel: '.', abs };
    if (r && abs.startsWith(`${r}/`)) return { rel: abs.slice(r.length + 1), abs };
    return { rel: abs, abs };
  }
  const rel = resolveSegments(p) || '.';
  return { rel, abs: r ? resolveSegments(`${r}/${rel}`) : null };
}

// --- Bash ---

const BASH_WRAPPER = /^Bash\(([\s\S]*)\)$/;

export interface ParsedBashPattern {
  prefix: string;
  /** `prefix:*`: the prefix, then anything. Otherwise the command must equal `prefix`. */
  anything: boolean;
}

/** Accepts `Bash(git push:*)`, `Bash(git status)`; null when the text is not in that shape. */
export function parseBashPattern(pattern: string): ParsedBashPattern | null {
  const m = BASH_WRAPPER.exec(pattern.trim());
  if (!m) return null;
  let inner = m[1].trim();
  if (!inner) return null;
  let anything = false;
  if (inner.endsWith(':*')) {
    anything = true;
    inner = inner.slice(0, -2).trim();
    if (!inner) return null;
  }
  if (inner.includes('*')) return null;
  return { prefix: inner.replace(/\s+/g, ' '), anything };
}

/** Wraps bare input (`git push:*`) as `Bash(git push:*)`. */
export function normalizeBashPattern(pattern: string): string {
  const t = pattern.trim();
  return BASH_WRAPPER.test(t) ? t : `Bash(${t})`;
}

/**
 * Splits a shell command into the commands that run: on `&&`, `||`, `;`, `|`, `&` and newlines
 * (outside quotes), plus the contents of `$(...)` and backticks. Each part has its leading
 * `VAR=value` assignments removed and whitespace collapsed. A rule is matched per sub-command and
 * the strictest result wins.
 */
export function splitBashCommands(command: string): string[] {
  const parts: string[] = [];
  const nested: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (cur.trim()) parts.push(cur);
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[++i];
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      // `2>&1` and `&>` are redirections, not command separators.
      if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
        cur += ch;
        continue;
      }
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  for (const part of parts) {
    for (const m of part.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push(m[1] ?? m[2] ?? '');
  }
  const all = [...parts, ...nested.flatMap((n) => splitBashCommands(n))];
  return all
    .map((p) =>
      p
        .trim()
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
        .replace(/\s+/g, ' '),
    )
    .filter(Boolean);
}

/** `Bash(prefix:*)` word-boundary prefix match, or an exact match, against one sub-command. */
export function bashPatternMatches(pattern: string, subCommand: string): boolean {
  const parsed = parseBashPattern(pattern);
  if (!parsed) return false;
  if (!parsed.anything) return subCommand === parsed.prefix;
  return subCommand === parsed.prefix || subCommand.startsWith(`${parsed.prefix} `);
}

// --- Tools ---

/** `WebFetch`, `mcp__github__create_issue`, or a wildcard `mcp__github__*`. */
export function toolPatternMatches(pattern: string, tool: string): boolean {
  const p = pattern.trim();
  if (p.endsWith('*')) return tool.startsWith(p.slice(0, -1));
  return tool === p;
}

// --- Validation ---

export const RULE_REASON_MAX = 200;
export const RULE_PATTERN_MAX = 300;

/** An error message for a rule that cannot be saved, or null when it is valid. */
export function validateRuleInput(rule: GuardrailRuleInput): string | null {
  if (!RULE_KINDS.includes(rule.kind)) return 'Unknown rule kind.';
  if (!(['allow', 'ask', 'deny'] as const).includes(rule.effect)) return 'The effect must be allow, ask or deny.';
  const pattern = rule.pattern?.trim() ?? '';
  if (!pattern) return 'A pattern is required.';
  if (pattern.length > RULE_PATTERN_MAX) return `The pattern is longer than ${RULE_PATTERN_MAX} characters.`;
  if (!rule.reason?.trim()) return 'A reason is required: it is shown to the user and to Claude.';
  if (rule.reason.length > RULE_REASON_MAX) return `The reason is longer than ${RULE_REASON_MAX} characters.`;
  if (rule.kind === 'path') {
    if (rule.actions.length === 0 || rule.actions.some((a) => !PATH_ACTIONS.includes(a))) return 'Pick read, edit or both.';
    try {
      globToRegExp(pattern);
    } catch {
      return 'The path pattern is not a valid glob.';
    }
  } else if (rule.kind === 'bash') {
    if (!parseBashPattern(normalizeBashPattern(pattern))) {
      return 'Use Bash(prefix:*) for "this prefix, then anything" or Bash(command) for an exact command. A * is only allowed in the :* suffix.';
    }
  } else if (/[()\s]/.test(pattern)) {
    return 'A tool pattern is a tool name such as WebFetch, or a wildcard such as mcp__github__*.';
  }
  return null;
}

/** Trims and normalizes an input the way it is stored. */
export function normalizeRuleInput(rule: GuardrailRuleInput): GuardrailRuleInput {
  const pattern = rule.kind === 'bash' ? normalizeBashPattern(rule.pattern) : rule.pattern.trim();
  return {
    kind: rule.kind,
    pattern,
    actions: rule.kind === 'path' ? PATH_ACTIONS.filter((a) => rule.actions.includes(a)) : [],
    effect: rule.effect,
    reason: rule.reason.trim(),
  };
}

// --- Evaluation ---

export interface RuleSubject {
  tool: string;
  input: Record<string, unknown>;
  /** The chat's worktree root: paths inside it are matched relative to it. */
  root?: string | null;
}

export interface RuleMatch {
  rule: GuardrailRule;
  effect: RuleEffect;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The files a tool call reads or edits: Read, Grep and Glob (path argument) read; the edit tools edit. */
export function pathAccesses(tool: string, input: Record<string, unknown>): Array<{ action: PathAction; path: string }> {
  const field = (action: PathAction, key: string): Array<{ action: PathAction; path: string }> => {
    const path = str(input[key]);
    return path ? [{ action, path }] : [];
  };
  switch (tool) {
    case 'Read':
      return field('read', 'file_path');
    case 'NotebookRead':
      return field('read', 'notebook_path');
    case 'Grep':
    case 'Glob':
      return field('read', 'path');
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return field('edit', 'file_path');
    case 'NotebookEdit':
      return field('edit', 'notebook_path');
    default:
      return [];
  }
}

/** One unit a rule is matched against: a file access, a Bash sub-command or the tool itself. */
type Probe = { type: 'path'; action: PathAction; path: NormalizedPath } | { type: 'bash'; command: string } | { type: 'tool' };

function probesFor(subject: RuleSubject): Probe[] {
  const probes: Probe[] = [{ type: 'tool' }];
  for (const a of pathAccesses(subject.tool, subject.input)) {
    probes.push({ type: 'path', action: a.action, path: normalizePath(a.path, subject.root) });
  }
  if (subject.tool === 'Bash') {
    const command = str(subject.input.command) ?? '';
    for (const c of splitBashCommands(command)) probes.push({ type: 'bash', command: c });
  }
  return probes;
}

function ruleMatchesProbe(rule: GuardrailRule, probe: Probe, tool: string): boolean {
  if (rule.kind === 'tool') return probe.type === 'tool' && toolPatternMatches(rule.pattern, tool);
  if (rule.kind === 'bash') return probe.type === 'bash' && bashPatternMatches(rule.pattern, probe.command);
  if (probe.type !== 'path' || !rule.actions.includes(probe.action)) return false;
  let re: RegExp;
  try {
    re = globToRegExp(rule.pattern);
  } catch {
    return false;
  }
  const target = rule.pattern.trim().startsWith('/') ? probe.path.abs : probe.path.rel;
  return target !== null && re.test(target);
}

const EFFECT_RANK: Record<RuleEffect, number> = { deny: 0, ask: 1, allow: 2 };
const LEVEL_RANK: Record<RuleLevel, number> = { org: 0, project: 1, role: 2, stage: 3 };

/** deny > ask > allow; among equals the broader level wins (org before project before role before stage). */
export function strictestMatch(matches: RuleMatch[]): RuleMatch | null {
  let best: RuleMatch | null = null;
  for (const m of matches) {
    if (
      !best ||
      EFFECT_RANK[m.effect] < EFFECT_RANK[best.effect] ||
      (m.effect === best.effect && LEVEL_RANK[m.rule.level] < LEVEL_RANK[best.rule.level])
    ) {
      best = m;
    }
  }
  return best;
}

function matchesOf(rules: GuardrailRule[], probes: Probe[], tool: string): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const rule of rules) {
    if (probes.some((p) => ruleMatchesProbe(rule, p, tool))) out.push({ rule, effect: rule.effect });
  }
  return out;
}

/**
 * The verdict of all rules for one tool call, or null when no rule matches.
 * - Org, project and stage rules: every match counts; strictest wins.
 * - Role rules: per role of the actor the strictest match; a person with several roles gets the most
 *   permissive role (a role with no matching rule is the most permissive of all).
 * - Bash: each sub-command is matched on its own and the strictest result wins. An `allow` only
 *   holds when every sub-command has an allow match.
 */
export function evaluateRules(rules: EffectiveRules, subject: RuleSubject, actorRoles: readonly Role[]): RuleMatch | null {
  const probes = probesFor(subject);
  const bashProbes = probes.filter((p) => p.type === 'bash');
  const nonBash = probes.filter((p) => p.type !== 'bash');

  // Probe groups: the non-Bash probes together, and each Bash sub-command separately.
  const groups: Probe[][] = [nonBash, ...bashProbes.map((p) => [p])];
  const verdicts: Array<RuleMatch | null> = groups.map((group) => {
    const direct = matchesOf([...rules.org, ...rules.project, ...rules.stage], group, subject.tool);
    let roleVerdict: RuleMatch | null = null;
    if (actorRoles.length > 0) {
      const perRole: Array<RuleMatch | null> = actorRoles.map((role) =>
        strictestMatch(matchesOf(rules.roles[role] ?? [], group, subject.tool)),
      );
      if (perRole.every((m) => m !== null)) {
        // Most permissive role wins.
        roleVerdict = (perRole as RuleMatch[]).reduce((a, b) => (EFFECT_RANK[b.effect] > EFFECT_RANK[a.effect] ? b : a));
      }
    }
    return strictestMatch(roleVerdict ? [...direct, roleVerdict] : direct);
  });

  const found = verdicts.filter((v): v is RuleMatch => v !== null);
  const strict = strictestMatch(found);
  if (!strict) return null;
  if (strict.effect !== 'allow') return strict;
  // An allow holds for a Bash call only when the tool itself is allowed or every sub-command is covered.
  if (verdicts[0] === null && verdicts.slice(1).some((v) => v === null)) return null;
  return strict;
}
