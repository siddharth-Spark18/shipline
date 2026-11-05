// Slash-command discovery for the chat composer: the repo's and the user's custom commands and skills.
// Node 20+, no dependencies.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYaml as vendoredParseYaml } from '../../templates/shipline/bin/lib.mjs';

// Built-in commands verified to work under `claude -p` (2026-11-05, claude 2.1.317).
export const BUILTIN_COMMANDS = [
  { name: 'context', description: 'Show context usage' },
  { name: 'usage', description: 'Show plan usage' },
  { name: 'cost', description: 'Show usage and cost' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'model', description: 'Show or change the model' },
  { name: 'init', description: 'Draft a CLAUDE.md' },
];

// Built-ins that need Claude Code's terminal UI or aren't available in -p; the composer refuses to send them.
export const INTERACTIVE_ONLY = [
  'help',
  'status',
  'login',
  'logout',
  'config',
  'permissions',
  'doctor',
  'terminal-setup',
  'color',
  'focus',
  'reload-plugins',
];

const MAX_DEPTH = 6;
const DESCRIPTION_LIMIT = 200;

// { data, body } for a file with optional `---` frontmatter. A frontmatter that doesn't parse counts as none.
function splitFrontmatter(text, parseYaml) {
  const src = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  let data = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // Not valid in the vendored subset: treat the file as having no frontmatter values.
  }
  return { data, body: src.slice(m[0].length) };
}

function firstLine(body) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.slice(0, DESCRIPTION_LIMIT);
  }
  return '';
}

function describe(data, body) {
  if (typeof data.description === 'string' && data.description.trim())
    return data.description.trim().slice(0, DESCRIPTION_LIMIT);
  return firstLine(body);
}

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFile(dir, e) {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(path.join(dir, e.name)).isFile();
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// A directory, or a symlink to one (shared setups often link skills and command folders in).
function isDir(dir, e) {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(path.join(dir, e.name)).isDirectory();
  } catch {
    return false; // a dangling link
  }
}

function scanCommands(dir, source, parseYaml, out, prefix = [], depth = 0) {
  if (depth > MAX_DEPTH) return;
  for (const e of entries(dir)) {
    if (isDir(dir, e)) {
      scanCommands(path.join(dir, e.name), source, parseYaml, out, [...prefix, e.name], depth + 1);
    } else if (e.name.endsWith('.md') && isFile(dir, e)) {
      const text = readText(path.join(dir, e.name));
      if (text === null) continue;
      const { data, body } = splitFrontmatter(text, parseYaml);
      const name = [...prefix, e.name.slice(0, -3)].join(':');
      out.push({ name, description: describe(data, body), source, kind: 'command' });
    }
  }
}

function scanSkills(dir, source, parseYaml, out) {
  for (const e of entries(dir)) {
    if (!isDir(dir, e)) continue;
    const text = readText(path.join(dir, e.name, 'SKILL.md'));
    if (text === null) continue;
    const { data, body } = splitFrontmatter(text, parseYaml);
    // Claude Code invokes a skill by its folder name (`/plan`), not its frontmatter `name`
    // (seen in system/init slash_commands on 2026-11-04), so the folder name is what gets typed.
    const name = e.name;
    out.push({ name, description: describe(data, body), source, kind: 'skill' });
  }
}

// [{ name, description, source: 'repo'|'user'|'builtin', kind: 'command'|'skill' }], sorted by name. A repo
// entry wins over a user entry of the same name. `opts.initCommands` (a running chat's system/init
// slash_commands) adds names that aren't listed yet, as description-less built-ins; names in
// `opts.terminalCommands`, names containing `:` (plugin or MCP commands) and INTERACTIVE_ONLY names are left out.
// `opts.parseYaml` and `opts.home` exist for tests.
export function listCommands(root, opts = {}) {
  const parseYaml = opts.parseYaml || vendoredParseYaml;
  const home = opts.home || os.homedir();
  const found = [];
  const places = [
    [path.join(root, '.claude'), 'repo'],
    [path.join(home, '.claude'), 'user'],
  ];
  for (const [base, source] of places) {
    scanCommands(path.join(base, 'commands'), source, parseYaml, found);
    scanSkills(path.join(base, 'skills'), source, parseYaml, found);
  }
  for (const b of BUILTIN_COMMANDS)
    found.push({ name: b.name, description: b.description, source: 'builtin', kind: 'command' });
  const terminal = new Set(opts.terminalCommands || []);
  const listed = new Set(found.map((c) => c.name));
  for (const raw of opts.initCommands || []) {
    const name = typeof raw === 'string' ? raw.replace(/^\//, '') : '';
    if (!name || name.includes(':') || terminal.has(name) || INTERACTIVE_ONLY.includes(name))
      continue;
    if (listed.has(name)) continue;
    listed.add(name);
    found.push({ name, description: '', source: 'builtin', kind: 'command' });
  }
  const seen = new Set();
  const out = [];
  for (const c of found) {
    if (seen.has(c.name)) continue; // repo entries come first, so they win
    seen.add(c.name);
    out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
