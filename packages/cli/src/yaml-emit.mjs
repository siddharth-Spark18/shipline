// Writes the YAML subset that the vendored hooks parse (templates/shipline/bin/lib.mjs `parseYaml`).
// Node 18+, no dependencies. The parser is NOT imported: its line rules are copied here so this module
// can scan the text on disk (rawScalars) and keep the quoting a team already uses.
//
// Rules (see the plan's "Saving setup changes"): two-space indent; keys follow the model's order; empty
// maps become null; empty lists are `[]`; unchanged values reuse their raw text from disk; new or changed
// values are quoted only when the parser would read them differently.

// ---------- copied parser pieces (keep in step with lib.mjs) ----------

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') i++;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s\[,:]/.test(line[i - 1]))) {
      q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitInline(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function scalarOf(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s[0] === '"' && s.endsWith('"') && s.length >= 2) return JSON.parse(s);
  if (s[0] === "'" && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '[' && s.endsWith(']')) return splitInline(s.slice(1, -1)).map(scalarOf);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

const KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

// Same line rules as parseYaml, but scalars keep their raw text. Nodes:
//   { t: 'leaf', raw }  { t: 'inline', raw, items: [leaf] }  { t: 'map', entries }  { t: 'list', items }  null
function valueNode(raw) {
  const s = raw.trim();
  if (s[0] === '[' && s.endsWith(']')) {
    return { t: 'inline', raw: s, items: splitInline(s.slice(1, -1)).map((x) => ({ t: 'leaf', raw: x.trim() })) };
  }
  return { t: 'leaf', raw: s };
}

function parseTree(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((l, n) => {
    const body = stripComment(l).replace(/\s+$/, '');
    if (body.trim() === '') return;
    if (/\t/.test(body.match(/^\s*/)[0])) throw new Error(`line ${n + 1}: tabs are not allowed for indentation`);
    lines.push({ indent: body.match(/^ */)[0].length, text: body.trim(), n: n + 1 });
  });
  let i = 0;

  function block(indent) {
    if (i >= lines.length) return null;
    return lines[i].text.startsWith('- ') || lines[i].text === '-' ? list(indent) : map(indent);
  }

  function map(indent) {
    const entries = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const ln = lines[i];
      const m = KEY_RE.exec(ln.text);
      if (!m) throw new Error(`line ${ln.n}: expected "key: value", got "${ln.text}"`);
      i++;
      if (m[2] !== undefined && m[2] !== '') {
        entries[m[1]] = valueNode(m[2]);
      } else if (i < lines.length && lines[i].indent > indent) {
        entries[m[1]] = block(lines[i].indent);
      } else {
        entries[m[1]] = null;
      }
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new Error(`line ${lines[i].n}: unexpected indentation`);
    }
    return { t: 'map', entries };
  }

  function list(indent) {
    const items = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const ln = lines[i];
      const rest = ln.text.slice(1).trimStart();
      if (rest !== '' && KEY_RE.test(rest)) {
        const inner = indent + (ln.text.length - rest.length);
        lines[i] = { indent: inner, text: rest, n: ln.n };
        items.push(map(inner));
      } else {
        i++;
        items.push(rest === '' ? null : valueNode(rest));
      }
    }
    return { t: 'list', items };
  }

  if (lines.length === 0) return { t: 'map', entries: {} };
  const result = block(lines[0].indent);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: unexpected content`);
  return result;
}

// ---------- paths ----------

const joinKey = (path, key) => (path ? `${path}.${key}` : key);

// A list whose items are all maps with a unique scalar `id` is keyed by id (stage lists), others by index.
function listPaths(path, ids) {
  const keyed = ids.every((id) => id !== undefined && id !== null) && new Set(ids).size === ids.length;
  return ids.map((id, i) => (keyed ? `${path}[id=${id}]` : `${path}[${i}]`));
}

function nodeId(item) {
  if (!item || item.t !== 'map') return undefined;
  const id = item.entries.id;
  return id && id.t === 'leaf' ? String(scalarOf(id.raw)) : undefined;
}

// Maps each scalar's path on disk to its raw text. Inline lists are recorded both whole (`path`) and per
// item (`path[i]`); block lists only per item, so the writer can tell which style the file used.
export function rawScalars(text) {
  const out = new Map();
  function walk(node, path) {
    if (!node) return;
    if (node.t === 'leaf') out.set(path, node.raw);
    else if (node.t === 'inline') {
      out.set(path, node.raw);
      node.items.forEach((it, i) => out.set(`${path}[${i}]`, it.raw));
    } else if (node.t === 'map') {
      for (const [k, v] of Object.entries(node.entries)) walk(v, joinKey(path, k));
    } else if (node.t === 'list') {
      const paths = listPaths(path, node.items.map(nodeId));
      node.items.forEach((it, i) => walk(it, paths[i]));
    }
  }
  walk(parseTree(text), '');
  return out;
}

// ---------- values ----------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameScalar = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function single(s) {
  return `'${s.replace(/'/g, "''")}'`;
}
const double = (s) => JSON.stringify(s);

function needsQuote(s, inList) {
  return (
    s === '' ||
    s === 'true' ||
    s === 'false' ||
    s === 'null' ||
    s === '~' ||
    /^-?\d+(\.\d+)?$/.test(s) ||
    /^["'\[\-#]/.test(s) ||
    s.includes(': ') ||
    s.includes(' #') ||
    s !== s.trim() ||
    (inList && s.endsWith(':')) // "- key:" would be read as a map entry
  );
}

// A string that can't be written inside an inline list `[a, b]` and must use a block list instead.
const needsBlockList = (s) => (s.includes('"') && s.includes(',')) || (s.includes("'") && s.includes(' #'));

function formatString(s, { inList = false, inline = false } = {}) {
  if (CONTROL_RE.test(s)) throw new Error('line breaks are not allowed here');
  const hasQuote = s.includes("'");
  const hasHash = s.includes(' #');
  if (inline) {
    if (s.includes('"')) return single(s); // splitInline doesn't honour \"
    if (/[,\[\]']/.test(s)) return double(s);
  }
  const regexy = /[\\|]/.test(s);
  if (!needsQuote(s, inList) && !regexy) return s;
  if (hasQuote && hasHash) return double(s); // stripComment misreads ' #' after a doubled ''
  if (regexy) return single(s); // the setup skill's "single quotes around regexes"
  return double(s);
}

function formatScalar(v, opts) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(String(v))) throw new Error(`number ${v} can't be written in this YAML subset`);
    return String(v);
  }
  if (typeof v === 'string') return formatString(v, opts);
  throw new Error(`can't write a ${typeof v} value`);
}

// Raw text from disk when this path's value is unchanged, else null.
function reuse(ctx, path, value) {
  if (!ctx.raw.has(path)) return null;
  const raw = ctx.raw.get(path);
  try {
    return sameScalar(scalarOf(raw), value) ? raw : null;
  } catch {
    return null;
  }
}

const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// ---------- entries ----------

function emitEntries(obj, indent, path, ctx) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) lines.push(...emitEntry(k, v, indent, joinKey(path, k), ctx));
  return lines;
}

function emitEntry(key, v, indent, path, ctx) {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`key "${key}" can't be written in this YAML subset`);
  const pad = ' '.repeat(indent);
  if (v === undefined || v === null) return [`${pad}${key}:`];
  if (isPlainObject(v)) {
    if (Object.keys(v).length === 0) return [`${pad}${key}:`]; // empty map -> null
    return [`${pad}${key}:`, ...emitEntries(v, indent + 2, path, ctx)];
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${pad}${key}: []`];
    if (v.every(isScalar)) return emitScalarList(key, v, indent, path, ctx);
    return [`${pad}${key}:`, ...emitBlockList(v, indent + 2, path, ctx)];
  }
  const raw = reuse(ctx, path, v);
  return [`${pad}${key}: ${raw !== null ? raw : formatScalar(v)}`];
}

function emitScalarList(key, arr, indent, path, ctx) {
  const pad = ' '.repeat(indent);
  const inlineOnDisk = ctx.raw.has(path);
  const blockOnDisk = !inlineOnDisk && ctx.raw.has(`${path}[0]`);
  const whole = reuse(ctx, path, arr);
  if (whole !== null) return [`${pad}${key}: ${whole}`];
  const inlineOk = !arr.some((x) => typeof x === 'string' && needsBlockList(x));
  if (inlineOk && !blockOnDisk) {
    const items = arr.map((x, i) => {
      const raw = inlineOnDisk ? reuse(ctx, `${path}[${i}]`, x) : null;
      return raw !== null ? raw : formatScalar(x, { inline: true });
    });
    return [`${pad}${key}: [${items.join(', ')}]`];
  }
  return [`${pad}${key}:`, ...emitBlockList(arr, indent + 2, path, ctx, !blockOnDisk)];
}

// skipRaw: the list was inline on disk (or new), so its items' raw text isn't reused in block form.
function emitBlockList(arr, indent, path, ctx, skipRaw = false) {
  const pad = ' '.repeat(indent);
  const lines = [];
  const paths = listPaths(path, arr.map((it) => (isPlainObject(it) && isScalar(it.id) ? String(it.id) : undefined)));
  arr.forEach((item, i) => {
    const p = paths[i];
    if (item === null || item === undefined) lines.push(`${pad}-`);
    else if (Array.isArray(item)) throw new Error('nested lists can\'t be written in this YAML subset');
    else if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}-`);
        return;
      }
      const inner = emitEntries(item, indent + 2, p, ctx);
      inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
      lines.push(...inner);
    } else {
      const raw = skipRaw ? null : reuse(ctx, p, item);
      lines.push(`${pad}- ${raw !== null ? raw : formatScalar(item, { inList: true })}`);
    }
  });
  return lines;
}

function makeCtx(raw) {
  return { raw: raw ? rawScalars(raw) : new Map() };
}

// ---------- public writers ----------

// header: text kept at the top (comment lines plus the blank line after them). raw: the file's current text.
export function emitWorkflow(model, { header = '', raw = '' } = {}) {
  if (!isPlainObject(model)) throw new Error('a workflow must be a map');
  const ctx = makeCtx(raw);
  const body = emitEntries(model, 0, '', ctx);
  return header + (body.length ? body.join('\n') + '\n' : '');
}

// Parses the shipped layout into top-level items, each with the comment/blank lines directly above it.
function parseLayout(layout) {
  const items = [];
  let lead = [];
  let cur = null;
  const lines = layout.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const line of lines) {
    const top = /^([A-Za-z0-9_.-]+):/.exec(line);
    const child = /^ +([A-Za-z0-9_.-]+):/.exec(line);
    if (top) {
      cur = { key: top[1], lead, children: [] };
      items.push(cur);
      lead = [];
    } else if (child && cur) {
      cur.children.push({ key: child[1], lead });
      lead = [];
    } else lead.push(line);
  }
  return { items, trailing: lead };
}

// A missing key drops its line, the comment block directly above it, and one blank line above that.
function surviving(lead) {
  const keep = lead.slice();
  while (keep.length && keep[keep.length - 1].trimStart().startsWith('#')) keep.pop();
  if (keep.length && keep[keep.length - 1].trim() === '') keep.pop();
  return keep;
}

// layout: text of templates/shipline/config.yml. raw: the file's current text.
export function emitConfig(model, { layout, raw = '' } = {}) {
  if (!isPlainObject(model)) throw new Error('config must be a map');
  if (typeof layout !== 'string') throw new Error('emitConfig needs the config layout');
  const ctx = makeCtx(raw);
  const { items, trailing } = parseLayout(layout);
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined;
  const out = [];

  for (const it of items) {
    if (!has(model, it.key)) {
      out.push(...surviving(it.lead));
      continue;
    }
    out.push(...it.lead);
    const v = model[it.key];
    if (it.children.length && isPlainObject(v) && Object.keys(v).length) {
      out.push(`${it.key}:`);
      for (const c of it.children) {
        if (has(v, c.key)) out.push(...c.lead, ...emitEntry(c.key, v[c.key], 2, joinKey(it.key, c.key), ctx));
        else out.push(...surviving(c.lead));
      }
      const known = new Set(it.children.map((c) => c.key));
      for (const [k, cv] of Object.entries(v)) {
        if (!known.has(k)) out.push(...emitEntry(k, cv, 2, joinKey(it.key, k), ctx));
      }
    } else {
      out.push(...emitEntry(it.key, v, 0, it.key, ctx));
    }
  }
  out.push(...trailing);

  const knownTop = new Set(items.map((it) => it.key));
  const unknown = Object.keys(model).filter((k) => !knownTop.has(k) && model[k] !== undefined);
  if (unknown.length) {
    out.push('');
    for (const k of unknown) out.push(...emitEntry(k, model[k], 0, k, ctx));
  }
  return out.join('\n') + '\n';
}
