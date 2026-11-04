// What `init` and `upgrade` share: the template inventory, content hashes, and the parts of the shared
// files (CLAUDE.md, .claude/settings.json) that Shipline owns. Node 18+, no dependencies.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(TEMPLATES, '..', 'package.json'), 'utf8')).version;
export const START = '<!-- shipline:start -->';
export const END = '<!-- shipline:end -->';
export const HOOK_MARK = '.shipline/bin/';
export const VERSION_FILE = '.shipline/bin/VERSION';
export const CLAUDE_MD_KEY = 'CLAUDE.md#shipline';
export const SETTINGS_KEY = '.claude/settings.json#shipline';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// templates/shipline/** -> .shipline/**, templates/claude/** -> .claude/**. [{ from, to }]
export function templateFiles() {
  const files = [];
  for (const [src, dest] of [['shipline', '.shipline'], ['claude', '.claude']]) {
    for (const rel of walk(path.join(TEMPLATES, src))) {
      files.push({ from: path.join(TEMPLATES, src, rel), to: `${dest}/${rel}` });
    }
  }
  return files;
}

// Team-owned files that are installed but never tracked or replaced: config.yml, workflows/*.yml, rules/*.md.
export const isTeamOwned = (to) => /^\.shipline\/(config\.yml|workflows\/|rules\/)/.test(to);

// The Shipline-owned template files (everything `files` in VERSION covers).
export const ownedTemplateFiles = () => templateFiles().filter((f) => !isTeamOwned(f.to));

export const templateSettings = () => JSON.parse(readFileSync(path.join(TEMPLATES, 'settings-hooks.json'), 'utf8'));
export const claudeMdSection = () => readFileSync(path.join(TEMPLATES, 'claude-md-section.md'), 'utf8').trimEnd() + '\n';

export const shiplineAllowRules = () => templateSettings().permissions.allow;

export const isShiplineHookEntry = (entry) => JSON.stringify(entry).includes(HOOK_MARK);

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return v;
}

// Shipline's hook entries plus its allow rules, as sorted JSON. Everything else in settings is ignored.
export function canonicalSettingsPart(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const hooks = {};
  const hs = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  for (const event of Object.keys(hs).sort()) {
    if (!Array.isArray(hs[event])) continue;
    const mine = hs[event].filter(isShiplineHookEntry);
    if (mine.length) hooks[event] = mine;
  }
  const rules = new Set(shiplineAllowRules());
  const allow = s.permissions && Array.isArray(s.permissions.allow) ? s.permissions.allow.filter((r) => rules.has(r)) : [];
  return JSON.stringify(canonical({ hooks, allow: [...new Set(allow)].sort() }));
}

// The text between the Shipline markers (trimmed), or null when there is no block.
export function claudeMdBlock(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf(START);
  const b = text.indexOf(END, a + START.length);
  if (a < 0 || b < 0) return null;
  return text.slice(a + START.length, b).trim();
}

// { <repo-relative path>: sha256 } of what a fresh install of this package would write for the owned files
// and the two virtual entries.
export function templateHashes() {
  const out = {};
  for (const f of ownedTemplateFiles()) out[f.to] = sha256(readFileSync(f.from));
  out[CLAUDE_MD_KEY] = sha256(claudeMdBlock(claudeMdSection()));
  out[SETTINGS_KEY] = sha256(canonicalSettingsPart(templateSettings()));
  return out;
}
