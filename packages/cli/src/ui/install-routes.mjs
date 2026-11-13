// The install wizard's API, served while no repo is installed ("install mode"). Nothing here writes to the repo or
// to the store until POST /api/install succeeds. Node 20+, no dependencies.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION_FILE } from '../hashes.mjs';
import {
  agentDescription,
  applyInstall,
  baseHashes,
  checkSelection,
  defaultSelection,
  installInfo,
  installState,
  nextSteps,
  planInstall,
  DEFAULT_BRANCH_PATTERN,
} from '../install.mjs';
import { HttpError } from './http.mjs';
import { gitRun, parseUnifiedDiff } from './git.mjs';
import { log } from './log.mjs';

// Every other /api route while in install mode.
export function notInstalled() {
  throw new HttpError(409, 'not-installed', 'Shipline is not installed in this repo yet');
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function selectionOf(info, body) {
  if (!isObj(body)) throw new HttpError(400, 'invalid', 'Expected { selection }');
  try {
    checkSelection(info, body.selection);
  } catch (e) {
    // Validator problems carry `issues` ([{ file, path, message }]); shape errors are plain messages.
    throw new HttpError(400, 'invalid', e.message, e.issues);
  }
  return body.selection;
}

// Diffs two texts through two files in the OS temp folder: the store must stay untouched until Install.
async function diffTexts(cwd, a, b) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shipline-diff-'));
  try {
    const fa = path.join(dir, 'a');
    const fb = path.join(dir, 'b');
    writeFileSync(fa, a);
    writeFileSync(fb, b);
    const { stdout } = await gitRun(
      cwd,
      ['diff', '--no-index', '--no-color', '-U3', '--', fa, fb],
      [0, 1],
    );
    return parseUnifiedDiff(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cleanInfo(app) {
  const info = installInfo(app.install.root);
  if (info.state !== 'clean') {
    throw new HttpError(409, 'installed', 'Shipline is already (partly) installed here', {
      state: info.state,
      found: info.found,
    });
  }
  return info;
}

// installInfo for the wizard: no file contents, agents with their descriptions and the stages that use them.
function infoBody(app) {
  const info = installInfo(app.install.root);
  return {
    root: app.install.root,
    isGit: app.install.isGit,
    state: info.state,
    found: info.found,
    workflows: info.workflows,
    agents: info.agents.map((name) => ({
      name,
      description: agentDescription(name),
      usedBy: info.agentUse[name],
    })),
    repoAgents: info.repoAgents,
    repoSkills: info.repoSkills,
    detected: info.detected,
    trackerDefault: info.trackerDefault,
    uiDetected: info.uiDetected,
    templates: info.templates,
    branchPatternDefault: DEFAULT_BRANCH_PATTERN,
    defaults: defaultSelection(info),
  };
}

async function preview(app, body) {
  const root = app.install.root;
  const info = cleanInfo(app);
  const selection = selectionOf(info, body);
  const plan = planInstall(root, info, selection);
  if (plan.mergeError) throw new HttpError(400, 'bad-settings', plan.mergeError);

  const files = plan.writes.map((f) => ({
    path: f.to,
    action: f.overwrite ? 'overwrite' : 'create',
    text: f.data.toString('utf8'),
  }));
  files.push({ path: VERSION_FILE, action: 'create' });
  for (const [rel, m] of [
    ['.claude/settings.json', plan.settings],
    ['CLAUDE.md', plan.claudeMd],
  ]) {
    files.push(
      m.before === null
        ? { path: rel, action: 'create', text: m.after }
        : { path: rel, action: 'merge', diff: await diffTexts(root, m.before, m.after) },
    );
  }
  return { files, excluded: plan.excluded, collisions: plan.collisions, base: baseHashes(root) };
}

function checkBase(base) {
  const ok = (v) => v === null || (typeof v === 'string' && v !== '');
  if (
    !isObj(base) ||
    !ok(base.settings) ||
    !ok(base.claudeMd) ||
    base.settings === undefined ||
    base.claudeMd === undefined
  ) {
    throw new HttpError(400, 'invalid', 'Expected { selection, base: { settings, claudeMd } }');
  }
}

async function install(app, body) {
  const root = app.install.root;
  if (!isObj(body)) throw new HttpError(400, 'invalid', 'Expected { selection, base }');
  checkBase(body.base);
  const info = cleanInfo(app);
  const selection = selectionOf(info, body);
  const plan = planInstall(root, info, selection);
  if (plan.mergeError) throw new HttpError(400, 'bad-settings', plan.mergeError);
  if (plan.collisions.length)
    throw new HttpError(409, 'collision', 'These paths already exist', { paths: plan.collisions });

  try {
    applyInstall(root, plan, { base: body.base });
  } catch (e) {
    if (e.code === 'changed' || e.code === 'collision' || e.code === 'installed') {
      throw new HttpError(409, e.code, e.message, e.details);
    }
    console.error(`shipline: install failed (${e.message})`);
    throw new HttpError(500, 'install-failed', e.message);
  }
  try {
    await app.switchToRepo();
  } catch (e) {
    console.error(`shipline: installed, but the UI could not switch (${e.message})`);
    throw new HttpError(
      500,
      'install-failed',
      `Installed, but the UI could not open the repo (${e.message}). Stop this command and run \`npx @forgeyard/shipline ui\` again.`,
    );
  }
  log('installed', { root, workflows: selection.workflows, ui: selection.ui, ci: selection.ci });
  return { installed: true, nextSteps: nextSteps(selection) };
}

export function routes(app) {
  return [
    {
      method: 'GET',
      path: '/api/status',
      handler: () => ({
        mode: 'install',
        root: app.install.root,
        state: installState(app.install.root).state,
        uiVersion: app.uiVersion,
      }),
    },
    { method: 'GET', path: '/api/install/info', handler: () => infoBody(app) },
    { method: 'POST', path: '/api/install/preview', handler: ({ body }) => preview(app, body) },
    { method: 'POST', path: '/api/install', handler: ({ body }) => install(app, body) },
  ];
}

// The wizard's routes once the repo is installed (a second tab, or a reload racing the switch): 409 installed,
// on which the wizard reloads into the normal UI.
export function installedRoutes() {
  const installed = () => {
    throw new HttpError(409, 'installed', 'Shipline is installed here');
  };
  return [
    { method: 'GET', path: '/api/install/info', handler: installed },
    { method: 'POST', path: '/api/install/preview', handler: installed },
    { method: 'POST', path: '/api/install', handler: installed },
  ];
}
