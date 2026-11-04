// Chat-first work items: per-project keys (`LL-12`), titles taken from the first message, and the
// named branch created at the chat's first edit. Shared so the hub and Shipline Local agree.

/** Prefix an admin sets per project: 2-10 uppercase letters/digits, starting with a letter. */
export const KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export const normalizeKeyPrefix = (value: string): string => value.trim().toUpperCase();

export const formatTicketKey = (prefix: string, counter: number): string => `${prefix}-${counter}`;

const TITLE_MAX = 80;

/** A chat's title is the first line of its first message, trimmed to a readable length. */
export function titleFromMessage(message: string): string {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return 'New chat';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'work';
}

/**
 * `<JIRA-KEY>-<slug>` when a Jira ticket is linked, otherwise `<KEY>-<slug>`. Once the branch exists
 * it keeps its name even if a Jira ticket is linked later (the Jira key then goes into the PR title).
 */
export function branchNameFor(args: { key: string; jiraKey: string | null; title: string }): string {
  return `${args.jiraKey ?? args.key}-${slugify(args.title)}`;
}

/** Keys that identify a chat in a branch name or PR title: its own key and the linked Jira key. */
const KEY_IN_TEXT = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export function extractKeys(...texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(KEY_IN_TEXT)) if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}
