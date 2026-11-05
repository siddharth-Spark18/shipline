// The setup screen's API: read, preview and save config.yml, workflows/<id>.yml and rules/<id>.md.
// Node 20+, no dependencies. Parsing always uses the repo's own vendored parser (repo.lib.parseYaml).
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { emitConfig, emitWorkflow } from '../yaml-emit.mjs';
import {
  CI_MISSING_BLOCK,
  DEFAULT_CI,
  configLayout,
  headerFor,
  validateConfig,
  validateWorkflow,
} from '../setup-schema.mjs';
import { planWorkflowAdd, shippedAgents, shippedWorkflows } from '../install.mjs';
import { detectUi } from '../detect-ui.mjs';
import { CI_WORKFLOW, CI_WORKFLOW_TEMPLATE, TEMPLATES, VERSION_FILE } from '../hashes.mjs';
import { detectEol, toEol } from '../store.mjs';
import { HttpError } from './http.mjs';
import { textDiff } from './git.mjs';
import { log } from './log.mjs';
import { readOpenTasks } from './tasks.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/;
const KINDS = ['config', 'workflow', 'rules'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// ---------- paths ----------

// The only paths the server ever writes. A client-supplied path is never used.
export function targetPath(root, kind, id) {
  const base = path.join(root, '.shipline');
  if (kind === 'config') return path.join(base, 'config.yml');
  if ((kind === 'workflow' || kind === 'rules') && typeof id === 'string' && ID_RE.test(id)) {
    return kind === 'workflow'
      ? path.join(base, 'workflows', `${id}.yml`)
      : path.join(base, 'rules', `${id}.md`);
  }
  throw new HttpError(
    400,
    'bad-target',
    `Not a writable target: ${kind}${id !== undefined ? ` ${JSON.stringify(id)}` : ''}`,
  );
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function listIds(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext) && ID_RE.test(f.slice(0, -ext.length)))
      .map((f) => f.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

function listAgents(root) {
  return listIds(path.join(root, '.claude', 'agents'), '.md');
}

// The repo's own skills: folders in .claude/skills, without Shipline's own shipline-* ones.
function listSkills(root) {
  try {
    return readdirSync(path.join(root, '.claude', 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID_RE.test(e.name) && !e.name.startsWith('shipline-'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------- parsing ----------

// Returns { model } or { error }.
function parseModel(app, text) {
  try {
    const model = app.repo.lib.parseYaml(text);
    if (!isObj(model)) return { error: 'must be a map of keys' };
    return { model };
  } catch (e) {
    return { error: e.message };
  }
}

function loadFile(app, kind, id) {
  const raw = readText(targetPath(app.repo.root, kind, id));
  const base = id === undefined ? { kind } : { kind, id };
  if (raw === null) return { ...base, raw: null, parseError: 'file not found' };
  if (kind === 'rules') return { ...base, raw, hash: sha256(raw) };
  const parsed = parseModel(app, raw);
  if (parsed.error !== undefined) return { ...base, raw, parseError: parsed.error };
  return { ...base, model: parsed.model, raw, hash: sha256(raw) };
}

// ---------- model helpers ----------

// Empty maps become null before emitting: the parser reads `key:` with nothing nested as null.
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return null;
    const out = {};
    for (const k of keys) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

// The path of the first difference, or null when equal.
function firstDiff(a, b, p = '') {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return p || '(root)';
    if (a.length !== b.length) return p || '(root)';
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return p || '(root)';
    for (const k of Object.keys(a)) {
      const here = p ? `${p}.${k}` : k;
      if (!(k in b)) return here;
      const d = firstDiff(a[k], b[k], here);
      if (d !== null) return d;
    }
    for (const k of Object.keys(b)) if (!(k in a)) return p ? `${p}.${k}` : k;
    return null;
  }
  return a === b ? null : p || '(root)';
}

// Comment text (from `#` to the end of the line) of every line, using the parser's quote rules.
function commentsOf(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"') i++;
      } else if ((c === '"' || c === "'") && (i === 0 || /[\s\[,:]/.test(line[i - 1]))) {
        q = c;
      } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        out.push(line.slice(i).trim());
        break;
      }
    }
  }
  return out;
}

// Comments on disk that the new text no longer has (a moved comment doesn't count).
function removedComments(oldText, newText) {
  const kept = new Map();
  for (const c of commentsOf(newText)) kept.set(c, (kept.get(c) || 0) + 1);
  const removed = [];
  for (const c of commentsOf(oldText)) {
    const n = kept.get(c) || 0;
    if (n > 0) kept.set(c, n - 1);
    else removed.push(c);
  }
  return removed;
}

function stageIds(model) {
  return model && Array.isArray(model.stages) ? model.stages.filter(isObj).map((s) => s.id) : [];
}

// ---------- the save pipeline ----------

function badRequest(message) {
  return new HttpError(400, 'bad-request', message);
}

// Validates one { kind, id?, model?, text?, baseHash } entry and builds its new text. Never writes.
// override: { raw, existingStageIds } for a copy, whose source text supplies the quoting to keep.
function prepare(app, entry, override = {}) {
  if (!isObj(entry) || !KINDS.includes(entry.kind))
    throw new HttpError(400, 'bad-target', 'Unknown file kind');
  const { root } = app.repo;
  const file = targetPath(root, entry.kind, entry.id);
  if (entry.baseHash !== null && typeof entry.baseHash !== 'string')
    throw badRequest('baseHash must be a string or null');
  const current = readText(file);
  const out = {
    kind: entry.kind,
    file,
    current,
    baseHash: entry.baseHash,
    errors: [],
    warnings: [],
    notes: [],
    roundTrip: null,
  };
  if (entry.kind !== 'config') out.id = entry.id;

  if (entry.kind === 'rules') {
    if (typeof entry.text !== 'string') throw badRequest('rules entries need "text"');
    // The browser sends \n; an existing file keeps its own line ending, a new one gets \n.
    out.text = toEol(entry.text, current !== null ? detectEol(current) : '\n');
    out.removedComments = [];
    return out;
  }

  if (!isObj(entry.model)) {
    out.errors.push({ path: '', message: 'a model is required' });
    out.text = current ?? '';
    out.removedComments = [];
    return out;
  }
  const model = normalize(entry.model) ?? {};
  const disk = current !== null ? parseModel(app, current) : { model: null };
  const existingStageIds = override.existingStageIds ?? stageIds(disk.model);

  const issues =
    entry.kind === 'config'
      ? validateConfig(model, { skills: listSkills(root) })
      : validateWorkflow(model, { id: entry.id, agents: listAgents(root), existingStageIds });
  out.errors = issues.filter((i) => i.severity !== 'warning');
  if (disk.error !== undefined)
    out.errors.push({
      path: '',
      message: `the file on disk does not parse (${disk.error}); fix it by hand first`,
    });
  out.warnings = issues.filter((i) => i.severity === 'warning');

  let text = current ?? '';
  if (out.errors.length === 0) {
    const raw = override.raw ?? current ?? '';
    try {
      text =
        entry.kind === 'config'
          ? emitConfig(model, { layout: configLayout(), raw })
          : emitWorkflow(model, { header: headerFor(entry.id), raw });
      const parsed = parseModel(app, text);
      if (parsed.error !== undefined) {
        out.roundTrip = { path: '', message: `the written file would not parse: ${parsed.error}` };
      } else {
        const d = firstDiff(model, normalize(parsed.model) ?? {});
        if (d !== null)
          out.roundTrip = { path: d, message: `"${d}" would not read back the same after writing` };
      }
    } catch (e) {
      out.roundTrip = { path: '', message: e.message };
    }
  }
  out.text = text;
  out.removedComments = removedComments(current ?? '', text);

  if (entry.kind === 'workflow') {
    const oldIds = stageIds(disk.model);
    const newIds = stageIds(model);
    out.stageChange = oldIds.length > 0 && oldIds.join('\0') !== newIds.join('\0');
    out.newIds = newIds;
    for (const id of oldIds) {
      if (
        !newIds.includes(id) &&
        typeof id === 'string' &&
        existsSync(path.join(root, '.shipline', 'rules', `${id}.md`))
      ) {
        out.notes.push(
          `Stage "${id}" is removed; its rules file .shipline/rules/${id}.md stays in place.`,
        );
      }
    }
  }
  return out;
}

function openTasksOf(app) {
  const { cfg } = app.repo.getConfig();
  return cfg ? readOpenTasks(app.repo.root, cfg, app.repo.needsUpgrade) : [];
}

// Open tasks whose manifest keeps a stage list different from the new one.
function impactFor(app, workflowId, newIds) {
  const impact = [];
  for (const t of openTasksOf(app)) {
    if (t.workflow !== workflowId) continue;
    const old = t.manifest.stages.map((s) => s.id);
    const added = newIds.filter((id) => !old.includes(id));
    const removed = old.filter((id) => !newIds.includes(id));
    const common = old.filter((id) => newIds.includes(id));
    const reordered = common.join('\0') !== newIds.filter((id) => old.includes(id)).join('\0');
    if (added.length || removed.length || reordered) {
      impact.push({
        task: t.dir,
        title: t.manifest.task.title ?? t.slug,
        added,
        removed,
        reordered,
      });
    }
  }
  return impact;
}

function entriesOf(body) {
  if (!isObj(body) || !Array.isArray(body.files) || body.files.length === 0)
    throw badRequest('Expected { files: [...] }');
  return body.files;
}

function tagged(p, e) {
  return { kind: p.kind, ...(p.id !== undefined ? { id: p.id } : {}), ...e };
}

async function preview(app, body) {
  const files = [];
  const impact = [];
  const seen = new Set();
  const prepared = entriesOf(body).map((e) => prepare(app, e));
  for (const p of prepared) {
    if (seen.has(p.file)) throw badRequest('The same file appears twice');
    seen.add(p.file);
    const errors = [...p.errors];
    if (p.roundTrip) errors.push(p.roundTrip);
    const out = {
      kind: p.kind,
      ...(p.id !== undefined ? { id: p.id } : {}),
      text: p.text,
      diff: await textDiff(app.repo.root, p.current ?? '', p.text),
      removedComments: p.removedComments,
      errors,
    };
    if (p.warnings.length) out.warnings = p.warnings;
    if (p.notes.length) out.notes = p.notes;
    files.push(out);
    if (p.kind === 'workflow' && p.stageChange && p.errors.length === 0)
      impact.push(...impactFor(app, p.id, p.newIds).map((i) => ({ workflow: p.id, ...i })));
  }
  return { files, impact };
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function writeNew(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, text, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') throw new HttpError(409, 'exists', 'File already exists');
    throw e;
  }
}

// Validates, checks every hash, then writes. Nothing is written unless every entry passes.
function commit(app, prepared) {
  const seen = new Set();
  for (const p of prepared) {
    if (seen.has(p.file)) throw badRequest('The same file appears twice');
    seen.add(p.file);
  }
  const bad = prepared.flatMap((p) => p.errors.map((e) => tagged(p, e)));
  if (bad.length) throw new HttpError(400, 'invalid', 'The files have errors', bad);
  const rt = prepared.find((p) => p.roundTrip);
  if (rt)
    throw new HttpError(400, 'round-trip', `${rt.roundTrip.message}`, tagged(rt, rt.roundTrip));

  // Step 4: every hash, before the first write.
  for (const p of prepared) {
    if (p.baseHash === null) {
      if (p.current !== null)
        throw new HttpError(409, 'exists', 'A file you are creating already exists', tagged(p, {}));
    } else if (p.current === null || sha256(p.current) !== p.baseHash) {
      throw new HttpError(
        409,
        'changed',
        'A file changed on disk since it was loaded',
        tagged(p, {}),
      );
    }
  }

  const written = [];
  let configSaved = false;
  for (const p of prepared) {
    if (p.current !== null && p.text === p.current) continue; // nothing to write
    const hash = sha256(p.text);
    if (p.current === null) writeNew(p.file, p.text);
    else writeAtomic(p.file, p.text);
    log('save', {
      kind: p.kind,
      ...(p.id !== undefined ? { id: p.id } : {}),
      file: path.relative(app.repo.root, p.file),
      hashBefore: p.current === null ? null : sha256(p.current),
      hashAfter: hash,
    });
    written.push(tagged(p, { hash }));
    if (p.kind === 'config') configSaved = true;
  }
  if (configSaved) app.repo.reloadConfig();
  return { written };
}

async function save(app, body) {
  app.repo.requireWritable();
  return commit(
    app,
    entriesOf(body).map((e) => prepare(app, e)),
  );
}

async function workflows(app, body) {
  app.repo.requireWritable();
  const { root } = app.repo;
  if (!isObj(body)) throw badRequest('Expected { action, ... }');

  if (body.action === 'copy') {
    const source = targetPath(root, 'workflow', body.from);
    const target = targetPath(root, 'workflow', body.id);
    const raw = readText(source);
    if (raw === null)
      throw new HttpError(400, 'bad-target', `Workflow "${body.from}" does not exist`);
    if (existsSync(target))
      throw new HttpError(409, 'exists', `Workflow "${body.id}" already exists`);
    const parsed = parseModel(app, raw);
    if (parsed.error !== undefined)
      throw new HttpError(
        400,
        'bad-target',
        `Workflow "${body.from}" does not parse: ${parsed.error}`,
      );
    // The file's own id decides what `stage.mjs start` records.
    const model = { ...parsed.model, id: body.id };
    const p = prepare(
      app,
      { kind: 'workflow', id: body.id, model, baseHash: null },
      { raw, existingStageIds: stageIds(parsed.model) },
    );
    commit(app, [p]);
    return { ok: true };
  }

  if (body.action === 'create') {
    if (typeof body.id !== 'string' || !ID_RE.test(body.id))
      throw new HttpError(400, 'invalid', 'id may only contain letters, digits, - and _');
    if (typeof body.name !== 'string' || body.name.trim() === '')
      throw new HttpError(400, 'invalid', 'A name is required');
    const target = targetPath(root, 'workflow', body.id);
    if (existsSync(target))
      throw new HttpError(409, 'exists', `Workflow "${body.id}" already exists`);
    const model = {
      id: body.id,
      name: body.name.trim(),
      stages: [
        {
          id: 'implement',
          name: 'Implement',
          enforcement: 'guide',
          confirm_to_advance: false,
        },
      ],
    };
    commit(app, [prepare(app, { kind: 'workflow', id: body.id, model, baseHash: null })]); // wx inside
    return { ok: true };
  }

  if (body.action === 'delete') {
    const target = targetPath(root, 'workflow', body.id);
    if (!existsSync(target))
      throw new HttpError(400, 'bad-target', `Workflow "${body.id}" does not exist`);
    if (!app.repo.getConfig().cfg) {
      throw new HttpError(
        409,
        'in-use',
        "Open tasks can't be checked while config.yml does not parse; fix it first",
      );
    }
    const using = openTasksOf(app)
      .filter((t) => t.workflow === body.id)
      .map((t) => t.dir);
    if (using.length)
      throw new HttpError(409, 'in-use', `Open tasks still use workflow "${body.id}"`, {
        tasks: using,
      });
    const hash = sha256(readText(target));
    unlinkSync(target); // its rules files stay in place
    log('delete-workflow', { id: body.id, hashBefore: hash });
    return { ok: true };
  }

  throw new HttpError(400, 'bad-target', 'action must be "copy", "create" or "delete"');
}

// ---------- agents (Shipline's own agent files, tracked in VERSION) ----------

const AGENT_FILE = (name) => `.claude/agents/${name}.md`;

function fileHash(file) {
  try {
    return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// { raw, hash, data } of .shipline/bin/VERSION. data is null when the file is missing or not a JSON object.
function readVersionFile(root) {
  const raw = readText(path.join(root, VERSION_FILE));
  let data = null;
  if (raw !== null) {
    try {
      const v = JSON.parse(raw);
      if (isObj(v)) data = v;
    } catch {
      // Reported by the caller.
    }
  }
  return { raw, hash: sha256(raw ?? ''), data };
}

const excludedOf = (v) =>
  Array.isArray(v.excluded) ? v.excluded.filter((p) => typeof p === 'string') : [];

function agentsSetup(root, version, names) {
  const excluded = new Set(version.data ? excludedOf(version.data) : []);
  const own = new Set(names);
  return {
    shipline: names.map((name) => {
      const hash = fileHash(path.join(root, AGENT_FILE(name)));
      return { name, installed: hash !== null, excluded: excluded.has(AGENT_FILE(name)), hash };
    }),
    repo: listAgents(root).filter((n) => !own.has(n)),
  };
}

function stagesUsingAgent(app, name) {
  const out = [];
  const dir = path.join(app.repo.root, '.shipline', 'workflows');
  for (const id of listIds(dir, '.yml')) {
    const raw = readText(path.join(dir, `${id}.yml`));
    const parsed = raw === null ? {} : parseModel(app, raw);
    for (const st of parsed.model && Array.isArray(parsed.model.stages)
      ? parsed.model.stages
      : []) {
      if (isObj(st) && st.agent === name) out.push(`${id}.${st.id}`);
    }
  }
  return out;
}

// Works out what an add/remove request does, without writing. Throws 400 for a bad request.
// Returns { changes: [{ name, path, action: 'write'|'delete', current: string|null, text: string|null }], before, after }.
function planAgents(app, body) {
  const { root } = app.repo;
  if (!isObj(body)) throw badRequest('Expected { add?, remove?, baseVersionHash, baseHashes }');
  const names = shippedAgents();
  const list = (k) => {
    const v = body[k] ?? [];
    if (!Array.isArray(v) || v.some((n) => typeof n !== 'string'))
      throw badRequest(`${k} must be a list of agent names`);
    for (const n of v)
      if (!names.includes(n))
        throw new HttpError(400, 'bad-target', `"${n}" is not one of Shipline's agents`);
    return [...new Set(v)];
  };
  const add = list('add');
  const remove = list('remove');
  if (add.some((n) => remove.includes(n)))
    throw badRequest('An agent cannot be both added and removed');
  if (add.length + remove.length === 0) throw badRequest('Nothing to add or remove');

  const version = readVersionFile(root);
  if (!version.data)
    throw badRequest(
      '.shipline/bin/VERSION is missing or unreadable; run `npx @forgeyard/shipline upgrade`',
    );
  const files = isObj(version.data.files) ? { ...version.data.files } : {};
  const excluded = new Set(excludedOf(version.data));
  const changes = [];
  const notes = new Map();

  for (const name of remove) {
    const rel = AGENT_FILE(name);
    const abs = path.join(root, rel);
    const exists = existsSync(abs);
    // In `excluded` with a file on disk: the team's own agent (a "keep yours" clash).
    if (exists && excluded.has(rel))
      throw new HttpError(
        400,
        'not-shipline',
        `${rel} is your own agent, not Shipline's; it is not removed`,
        {
          path: rel,
        },
      );
    excluded.add(rel);
    delete files[rel];
    if (exists) {
      changes.push({
        name,
        path: rel,
        action: 'delete',
        current: readFileSync(abs, 'utf8'),
        text: null,
      });
      const used = stagesUsingAgent(app, name);
      if (used.length)
        notes.set(name, [
          `Stages that use "${name}" will show "agent not installed": ${used.join(', ')}`,
        ]);
    }
  }
  for (const name of add) {
    const rel = AGENT_FILE(name);
    const abs = path.join(root, rel);
    const exists = existsSync(abs);
    const ours = readFileSync(path.join(TEMPLATES, 'claude', 'agents', `${name}.md`), 'utf8');
    const wasExcluded = excluded.has(rel);
    if (exists && !wasExcluded) continue; // already Shipline's: nothing to do
    excluded.delete(rel);
    files[rel] = sha256(ours);
    changes.push({
      name,
      path: rel,
      action: 'write',
      current: exists ? readFileSync(abs, 'utf8') : null,
      text: ours,
    });
  }

  const sorted = (o) =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  const after = { ...version.data, files: sorted(files), excluded: [...excluded].sort() };
  const before = { ...version.data, excluded: excludedOf(version.data) };
  return { changes, notes, version, before, after };
}

async function agentsPreview(app, body) {
  const plan = planAgents(app, body);
  const files = [];
  for (const c of plan.changes) {
    const out = {
      kind: 'agent',
      id: c.name,
      text: c.text,
      diff: await textDiff(app.repo.root, c.current ?? '', c.text ?? ''),
      removedComments: [],
      errors: [],
    };
    if (plan.notes.has(c.name)) out.notes = plan.notes.get(c.name);
    files.push(out);
  }
  return { files, version: { before: plan.before, after: plan.after } };
}

async function agentsApply(app, body) {
  const { root } = app.repo;
  const plan = planAgents(app, body);
  const baseHashes = body.baseHashes;
  if (!isObj(baseHashes)) throw badRequest('baseHashes is required');
  if (typeof body.baseVersionHash !== 'string') throw badRequest('baseVersionHash is required');

  // Every hash, before the first write.
  const changed = [];
  if (plan.version.hash !== body.baseVersionHash) changed.push(VERSION_FILE);
  for (const c of plan.changes) {
    if (!(c.path in baseHashes)) throw badRequest(`baseHashes has no entry for ${c.path}`);
    if (fileHash(path.join(root, c.path)) !== baseHashes[c.path]) changed.push(c.path);
  }
  if (changed.length)
    throw new HttpError(409, 'changed', 'A file changed on disk since it was loaded', {
      paths: changed,
    });

  for (const c of plan.changes) {
    const abs = path.join(root, c.path);
    if (c.action === 'delete') rmSync(abs, { force: true });
    else writeAtomic(abs, c.text);
    log('agents', {
      id: c.name,
      action: c.action,
      hashBefore: c.current === null ? null : sha256(c.current),
      hashAfter: c.text === null ? null : sha256(c.text),
    });
  }
  writeAtomic(path.join(root, VERSION_FILE), JSON.stringify(plan.after, null, 2) + '\n'); // last
  return { written: plan.changes.map((c) => ({ kind: 'agent', id: c.name, action: c.action })) };
}

// ---------- CI check (.github/workflows/shipline.yml and config.yml's ci:) ----------

const CONFIG_REL = '.shipline/config.yml';

// The ci: values in effect for a parsed config model (defaults where absent or invalid).
function ciValues(model) {
  const ci = model && isObj(model.ci) ? model.ci : {};
  return {
    missing_block: CI_MISSING_BLOCK.includes(ci.missing_block)
      ? ci.missing_block
      : DEFAULT_CI.missing_block,
    skip_label:
      typeof ci.skip_label === 'string' && ci.skip_label.trim()
        ? ci.skip_label
        : DEFAULT_CI.skip_label,
  };
}

function ciSetup(app) {
  const workflowHash = fileHash(path.join(app.repo.root, CI_WORKFLOW));
  const config = loadFile(app, 'config');
  return { installed: workflowHash !== null, ...ciValues(config.model), workflowHash };
}

// Works out a { install, missing_block, skip_label } request without writing. Throws 400 for a bad request.
// Returns { config: prepared entry, workflow: { action, current, text } | null, version }.
function planCi(app, body) {
  const { root } = app.repo;
  if (!isObj(body) || typeof body.install !== 'boolean')
    throw badRequest('Expected { install, missing_block, skip_label, baseHashes }');
  const config = loadFile(app, 'config');
  if (config.parseError !== undefined)
    throw badRequest(`config.yml does not parse (${config.parseError}); fix it by hand first`);

  const want = {
    missing_block: body.missing_block ?? DEFAULT_CI.missing_block,
    skip_label: body.skip_label ?? DEFAULT_CI.skip_label,
  };
  const model = structuredClone(config.model);
  // Don't add a ci: section that only repeats the defaults.
  const hadCi = Object.prototype.hasOwnProperty.call(model, 'ci') && model.ci !== null;
  const isDefault =
    want.missing_block === DEFAULT_CI.missing_block && want.skip_label === DEFAULT_CI.skip_label;
  // stale_checks isn't edited on this screen (the config form owns it); it is kept as it is.
  const keep =
    hadCi && isObj(model.ci) && model.ci.stale_checks !== undefined
      ? { stale_checks: model.ci.stale_checks }
      : {};
  if (hadCi || !isDefault) model.ci = { ...want, ...keep };
  const entry = prepare(app, { kind: 'config', model, baseHash: config.hash });

  const abs = path.join(root, CI_WORKFLOW);
  const current = readText(abs);
  let workflow = null;
  if (body.install && current === null)
    workflow = { action: 'write', current, text: readFileSync(CI_WORKFLOW_TEMPLATE, 'utf8') };
  else if (!body.install && current !== null) workflow = { action: 'delete', current, text: null };
  return { config: entry, workflow, version: readVersionFile(root) };
}

async function ciPreview(app, body) {
  const plan = planCi(app, body);
  const files = [];
  const p = plan.config;
  if (p.text !== p.current || p.errors.length || p.roundTrip) {
    const errors = [...p.errors];
    if (p.roundTrip) errors.push(p.roundTrip);
    files.push({
      kind: 'config',
      text: p.text,
      diff: await textDiff(app.repo.root, p.current ?? '', p.text),
      removedComments: p.removedComments,
      errors,
    });
  }
  if (plan.workflow) {
    files.push({
      kind: 'ci',
      text: plan.workflow.text,
      diff: await textDiff(app.repo.root, plan.workflow.current ?? '', plan.workflow.text ?? ''),
      removedComments: [],
      errors: [],
    });
  }
  return { files };
}

async function ciApply(app, body) {
  app.repo.requireWritable();
  const { root } = app.repo;
  const plan = planCi(app, body);
  const baseHashes = body.baseHashes;
  if (!isObj(baseHashes)) throw badRequest('baseHashes is required');
  for (const key of [CONFIG_REL, CI_WORKFLOW])
    if (!(key in baseHashes)) throw badRequest(`baseHashes has no entry for ${key}`);

  // Every hash, before the first write.
  const changed = [];
  if (fileHash(path.join(root, CI_WORKFLOW)) !== baseHashes[CI_WORKFLOW]) changed.push(CI_WORKFLOW);
  if (fileHash(path.join(root, CONFIG_REL)) !== baseHashes[CONFIG_REL]) changed.push(CONFIG_REL);
  if (typeof body.baseVersionHash === 'string' && plan.version.hash !== body.baseVersionHash)
    changed.push(VERSION_FILE);
  if (changed.length)
    throw new HttpError(409, 'changed', 'A file changed on disk since it was loaded', {
      paths: changed,
    });

  // config.yml first: it validates everything and writes nothing when there is an error.
  const written = [];
  const entry = { ...plan.config, baseHash: baseHashes[CONFIG_REL] };
  written.push(...commit(app, [entry]).written);

  const wf = plan.workflow;
  if (wf) {
    const abs = path.join(root, CI_WORKFLOW);
    if (wf.action === 'delete') {
      rmSync(abs, { force: true });
      for (const dir of [path.dirname(abs), path.dirname(path.dirname(abs))]) {
        try {
          rmdirSync(dir); // only succeeds when empty
        } catch {
          break;
        }
      }
    } else writeAtomic(abs, wf.text);
    log('ci-workflow', {
      action: wf.action,
      hashBefore: wf.current === null ? null : sha256(wf.current),
      hashAfter: wf.text === null ? null : sha256(wf.text),
    });
    written.push({ kind: 'ci', action: wf.action });
    if (plan.version.data) {
      const files = isObj(plan.version.data.files) ? { ...plan.version.data.files } : null;
      if (files) {
        if (wf.action === 'write') files[CI_WORKFLOW] = sha256(wf.text);
        else delete files[CI_WORKFLOW];
        const sorted = Object.fromEntries(
          Object.keys(files)
            .sort()
            .map((k) => [k, files[k]]),
        );
        writeAtomic(
          path.join(root, VERSION_FILE),
          JSON.stringify({ ...plan.version.data, files: sorted }, null, 2) + '\n',
        ); // last
      }
    }
  }
  return { written };
}

// ---------- add a shipped workflow ----------

// Works out what adding a shipped workflow writes, without writing. Throws 400/409 for a bad request.
// Returns { writes: [{ to, data, agent? }], version, files, excluded }, where files and excluded are VERSION's
// `files` and `excluded` after the agents it installs are recorded.
function planAddWorkflow(app, body) {
  const { root } = app.repo;
  if (!isObj(body)) throw badRequest('Expected { id, ui, baseVersionHash, baseHashes, preview? }');
  if (typeof body.id !== 'string' || !shippedWorkflows().some((w) => w.id === body.id))
    throw new HttpError(400, 'bad-target', `"${body.id}" is not one of Shipline's workflows`);
  if (typeof body.ui !== 'boolean') throw badRequest('ui must be true or false');
  if (existsSync(path.join(root, '.shipline', 'workflows', `${body.id}.yml`)))
    throw new HttpError(409, 'exists', `The ${body.id} workflow is already installed`);
  const version = readVersionFile(root);
  if (!version.data)
    throw badRequest(
      '.shipline/bin/VERSION is missing or unreadable; run `npx @forgeyard/shipline upgrade`',
    );
  const plan = planWorkflowAdd(root, body.id, body.ui);
  const files = isObj(version.data.files) ? { ...version.data.files } : {};
  const excluded = new Set(excludedOf(version.data));
  for (const w of plan.writes) {
    if (!w.agent) continue;
    excluded.delete(w.to);
    files[w.to] = sha256(w.data);
  }
  return { writes: plan.writes, version, files, excluded: [...excluded].sort() };
}

async function addWorkflowPreview(app, body) {
  const plan = planAddWorkflow(app, body);
  const files = [];
  for (const w of plan.writes) {
    const text = w.data.toString('utf8');
    const kind = w.agent ? 'agent' : w.to.startsWith('.shipline/workflows/') ? 'workflow' : 'rules';
    const id = path.basename(w.to).replace(/\.(yml|md)$/, '');
    files.push({
      kind,
      id,
      text,
      diff: await textDiff(app.repo.root, '', text),
      removedComments: [],
      errors: [],
    });
  }
  return {
    files,
    // The exact paths this preview would write. The dialog sends them back as baseHashes (null = must not
    // exist yet), so the save can refuse when the plan changed in between.
    paths: plan.writes.map((w) => w.to),
    version: {
      before: plan.version.data,
      after: { ...plan.version.data, files: plan.files, excluded: plan.excluded },
    },
  };
}

async function addWorkflowApply(app, body) {
  const { root } = app.repo;
  const plan = planAddWorkflow(app, body);
  if (typeof body.baseVersionHash !== 'string') throw badRequest('baseVersionHash is required');
  if (!isObj(body.baseHashes)) throw badRequest('baseHashes is required');

  // Everything written is new. The version file must be unchanged, and the set of paths must be exactly the
  // previewed one (baseHashes: { path: null }): a file that appeared since the preview would otherwise be
  // silently left out, and one that disappeared would be written without having been shown.
  const changed = [];
  if (plan.version.hash !== body.baseVersionHash) changed.push(VERSION_FILE);
  const previewed = Object.keys(body.baseHashes);
  const planned = plan.writes.map((w) => w.to);
  for (const p of previewed) {
    if (body.baseHashes[p] !== null) throw badRequest(`baseHashes["${p}"] must be null`);
    if (!planned.includes(p) || fileHash(path.join(root, p)) !== null) changed.push(p);
  }
  for (const p of planned) if (!previewed.includes(p)) changed.push(p);
  if (changed.length)
    throw new HttpError(409, 'changed', 'The repo changed since the preview. Preview again.', {
      paths: [...new Set(changed)],
    });

  // All or nothing: a failed write removes the files this call already created; VERSION is written last.
  const created = [];
  const written = [];
  try {
    for (const w of plan.writes) {
      const abs = path.join(root, w.to);
      writeNew(abs, w.data);
      created.push(abs);
      const kind = w.agent
        ? 'agent'
        : w.to.startsWith('.shipline/workflows/')
          ? 'workflow'
          : 'rules';
      const id = path.basename(w.to).replace(/\.(yml|md)$/, '');
      written.push({ kind, id, action: 'write', file: w.to, hash: sha256(w.data) });
    }
    if (plan.writes.some((w) => w.agent)) {
      const sorted = Object.fromEntries(
        Object.keys(plan.files)
          .sort()
          .map((k) => [k, plan.files[k]]),
      );
      writeAtomic(
        path.join(root, VERSION_FILE),
        JSON.stringify({ ...plan.version.data, files: sorted, excluded: plan.excluded }, null, 2) +
          '\n',
      ); // last
    }
  } catch (e) {
    for (const abs of created.reverse()) {
      try {
        unlinkSync(abs);
      } catch {
        // Best effort: report the original error.
      }
    }
    log('add-workflow-failed', { workflow: body.id, message: e && e.message });
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      500,
      'write-failed',
      `Adding the workflow failed and was rolled back: ${e.message}`,
    );
  }
  for (const w of written)
    log('add-workflow', { workflow: body.id, file: w.file, hashAfter: w.hash });
  return { written: written.map(({ kind, id, action }) => ({ kind, id, action })) };
}

// ---------- GET /api/setup ----------

function setup(app) {
  const { root } = app.repo;
  const version = readVersionFile(root);
  const { cfg } = app.repo.getConfig();
  return {
    config: loadFile(app, 'config'),
    workflows: listIds(path.join(root, '.shipline', 'workflows'), '.yml').map((id) =>
      loadFile(app, 'workflow', id),
    ),
    rules: listIds(path.join(root, '.shipline', 'rules'), '.md').map((id) =>
      loadFile(app, 'rules', id),
    ),
    agents: agentsSetup(root, version, shippedAgents()),
    skills: {
      repo: listSkills(root),
      selected: cfg && Array.isArray(cfg.skills) ? cfg.skills : [],
    },
    versionHash: version.hash,
    ci: ciSetup(app),
    addableWorkflows: shippedWorkflows()
      .filter((w) => !existsSync(path.join(root, '.shipline', 'workflows', `${w.id}.yml`)))
      .map((w) => ({ id: w.id, name: w.name, description: w.description })),
    uiDetected: detectUi(root).ui,
  };
}

export function routes(app) {
  return [
    { method: 'GET', path: '/api/setup', handler: () => setup(app) },
    { method: 'POST', path: '/api/setup/preview', handler: ({ body }) => preview(app, body) },
    { method: 'POST', path: '/api/setup/save', handler: ({ body }) => save(app, body) },
    { method: 'POST', path: '/api/setup/workflows', handler: ({ body }) => workflows(app, body) },
    {
      method: 'POST',
      path: '/api/setup/agents',
      handler: async ({ body, url }) => {
        app.repo.requireWritable();
        return url.searchParams.get('preview') === '1'
          ? agentsPreview(app, body)
          : agentsApply(app, body);
      },
    },
    {
      method: 'POST',
      path: '/api/setup/add-workflow',
      handler: async ({ body, url }) => {
        app.repo.requireWritable();
        return url.searchParams.get('preview') === '1' || (isObj(body) && body.preview === true)
          ? addWorkflowPreview(app, body)
          : addWorkflowApply(app, body);
      },
    },
    {
      method: 'POST',
      path: '/api/setup/ci',
      handler: async ({ body, url }) => {
        app.repo.requireWritable();
        return url.searchParams.get('preview') === '1' ? ciPreview(app, body) : ciApply(app, body);
      },
    },
  ];
}
