// Cleanup and rollout plan, section C (Windows), the parts that run on every OS: line endings (detectEol, toEol,
// CRLF config/workflow/rules saves, the CRLF CLAUDE.md block through init, upgrade and uninstall), path rules
// with an injected platform (isInside, sameRoot), the store path encoding of a drive-letter path, and how the
// UI starts a Windows `claude` (startSpec). Node 18+ (runs in test:hooks); the UI parts need Node 20.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BIN, makeRepo, removeDir, run, runInit, stage, tmpDir } from './helpers.mjs';
import { detectEol, encodePath, isInside, parseYaml, sameRoot, toEol } from '../templates/shipline/bin/lib.mjs';
import { emitConfig, emitWorkflow } from '../src/yaml-emit.mjs';
import { configLayout, headerFor } from '../src/setup-schema.mjs';
import { START, END, removeClaudeMdBlock } from '../src/hashes.mjs';

const major = Number(process.versions.node.split('.')[0]);
const NEEDS_UI = major < 20 ? 'UI code (Node 20+); runs in the cli + ui job' : false;

const dirs = [];
after(() => {
  for (const d of dirs) removeDir(d);
});
const keep = (d) => (dirs.push(d), d);

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');
// Every line break is CRLF: no bare \n, no stray \r.
function assertAllCrlf(text, label = '') {
  assert.ok(text.includes('\r\n'), `${label}: has line breaks`);
  assert.ok(!/(^|[^\r])\n/.test(text), `${label}: a bare \\n`);
  assert.ok(!/\r(?!\n)/.test(text), `${label}: a stray \\r`);
}
function assertAllLf(text, label = '') {
  assert.ok(!text.includes('\r'), `${label}: a \\r`);
}

// ---------- line endings ----------

describe('detectEol', () => {
  test('CRLF, LF and no line break', () => {
    assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
    assert.equal(detectEol('a\nb\n'), '\n');
    assert.equal(detectEol('no line break'), '\n');
    assert.equal(detectEol(''), '\n');
  });

  test('a mixed text follows its first line break', () => {
    assert.equal(detectEol('a\r\nb\nc\n'), '\r\n');
    assert.equal(detectEol('a\nb\r\nc\r\n'), '\n');
  });
});

describe('toEol', () => {
  test('rewrites every line break once (no \\r\\r\\n), either way', () => {
    assert.equal(toEol('a\nb\r\nc\n', '\r\n'), 'a\r\nb\r\nc\r\n');
    assert.equal(toEol('a\r\nb\nc\r\n', '\n'), 'a\nb\nc\n');
    assert.equal(toEol('a\r\nb\r\n', '\r\n'), 'a\r\nb\r\n');
    assert.equal(toEol('none', '\r\n'), 'none');
  });
});

describe('YAML on CRLF', () => {
  const tpl = (rel) => readFileSync(path.join(path.dirname(BIN), '..', 'templates', 'shipline', rel), 'utf8');

  test('parseYaml reads a CRLF file exactly like its LF original (no trailing \\r in any value)', () => {
    for (const rel of ['config.yml', 'workflows/feature.yml', 'workflows/small.yml']) {
      const lf = tpl(rel);
      assert.deepEqual(parseYaml(CRLF(lf)), parseYaml(lf), rel);
      assert.ok(!JSON.stringify(parseYaml(CRLF(lf))).includes('\\r'), rel);
    }
  });

  test('emitConfig / emitWorkflow keep a CRLF file CRLF, write a new file with \\n, and read back the same', () => {
    const cfgLf = tpl('config.yml');
    const cfgCrlf = CRLF(cfgLf);
    const cfg = parseYaml(cfgCrlf);
    const cfgOut = emitConfig(cfg, { layout: configLayout(), raw: cfgCrlf });
    assertAllCrlf(cfgOut, 'config.yml');
    assert.deepEqual(parseYaml(cfgOut), cfg);
    assert.equal(cfgOut, cfgCrlf, 'a no-edit save of a CRLF config gives the same bytes');
    assertAllLf(emitConfig(cfg, { layout: configLayout() }), 'new config');

    const wfCrlf = CRLF(tpl('workflows/feature.yml'));
    const wf = parseYaml(wfCrlf);
    const wfOut = emitWorkflow(wf, { header: headerFor('feature'), raw: wfCrlf });
    assertAllCrlf(wfOut, 'feature.yml');
    assert.deepEqual(parseYaml(wfOut), wf);
    assertAllLf(emitWorkflow(wf, { header: headerFor('feature') }), 'new workflow');
  });

  test('a mixed file is written with its first line break', () => {
    const lf = tpl('workflows/feature.yml');
    const lines = lf.split('\n');
    const crlfFirst = lines[0] + '\r\n' + lines.slice(1).join('\n');
    const lfFirst = lines[0] + '\n' + CRLF(lines.slice(1).join('\n'));
    const wf = parseYaml(lf);
    assertAllCrlf(emitWorkflow(wf, { header: headerFor('feature'), raw: crlfFirst }), 'CRLF first');
    assertAllLf(emitWorkflow(wf, { header: headerFor('feature'), raw: lfFirst }), 'LF first');
  });

  test('the hooks read CRLF workflows and config: stage.mjs start works on an all-CRLF .shipline', () => {
    const dir = keep(makeRepo());
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(yml|md)$/.test(e.name)) writeFileSync(full, CRLF(readFileSync(full, 'utf8')));
      }
    };
    walk(path.join(dir, '.shipline'));
    const r = stage(dir, ['start', '--workflow', 'feature', '--title', 'CRLF task'], 's-crlf');
    assert.equal(r.code, 0, r.stderr);
    const status = stage(dir, ['status'], 's-crlf');
    assert.equal(status.code, 0, status.stderr);
    assert.ok(!/\r/.test(status.stdout.replace(/\r\n/g, '\n')), 'no stray \\r in what stage.mjs prints');
  });
});

// The real save path: POST /api/setup/save on a running UI server.
describe('Setup saves keep the file\'s line ending', { skip: NEEDS_UI }, () => {
  let dir;
  let ui;
  let api;
  const file = (rel) => path.join(dir, rel);
  const read = (rel) => readFileSync(file(rel), 'utf8');
  const getSetup = async () => {
    const r = await api(ui, 'GET', '/api/setup');
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const save = async (files) => {
    const r = await api(ui, 'POST', '/api/setup/save', { body: { files } });
    assert.equal(r.status, 200, r.text);
    return r;
  };

  test('setup', async () => {
    const h = await import('./ui/helpers.mjs');
    api = h.api;
    dir = keep(makeRepo({ commitInit: true }));
    for (const rel of ['.shipline/config.yml', '.shipline/workflows/feature.yml', '.shipline/rules/plan.md']) writeFileSync(file(rel), CRLF(read(rel)));
    ui = await h.startUi(dir);
  });

  test('a CRLF config.yml and workflow stay CRLF after an edit, and the edit is there', async () => {
    const s = await getSetup();
    const cfg = { ...s.config.model, branch_pattern: 'team/{slug}' };
    const wf = s.workflows.find((w) => w.id === 'feature');
    const model = JSON.parse(JSON.stringify(wf.model));
    model.stages[0].description = 'Edited on a CRLF file';
    await save([
      { kind: 'config', model: cfg, baseHash: s.config.hash },
      { kind: 'workflow', id: 'feature', model, baseHash: wf.hash },
    ]);
    const c = read('.shipline/config.yml');
    assertAllCrlf(c, 'config.yml');
    assert.equal(parseYaml(c).branch_pattern, 'team/{slug}');
    const w = read('.shipline/workflows/feature.yml');
    assertAllCrlf(w, 'feature.yml');
    assert.equal(parseYaml(w).stages[0].description, 'Edited on a CRLF file');
  });

  test('a mixed workflow is saved with its first line break', async () => {
    for (const [first, check] of [['\r\n', assertAllCrlf], ['\n', assertAllLf]]) {
      const lines = read('.shipline/workflows/bugfix.yml').replace(/\r\n/g, '\n').split('\n');
      const other = first === '\r\n' ? '\n' : '\r\n';
      writeFileSync(file('.shipline/workflows/bugfix.yml'), lines[0] + first + lines.slice(1).join(other));
      const s = await getSetup();
      const wf = s.workflows.find((w) => w.id === 'bugfix');
      const model = JSON.parse(JSON.stringify(wf.model));
      model.stages[0].description = first === '\r\n' ? 'first CRLF' : 'first LF';
      await save([{ kind: 'workflow', id: 'bugfix', model, baseHash: wf.hash }]);
      check(read('.shipline/workflows/bugfix.yml'), `bugfix.yml, first ${JSON.stringify(first)}`);
    }
  });

  test('a CRLF rules file stays CRLF (the browser sends \\n); a new rules file gets \\n', async () => {
    const s = await getSetup();
    const plan = s.rules.find((r) => r.id === 'plan');
    await save([
      { kind: 'rules', id: 'plan', text: plan.raw.replace(/\r\n/g, '\n') + '- One more rule.\n', baseHash: plan.hash },
      { kind: 'rules', id: 'security', text: 'Check auth.\nAlways.\n', baseHash: null },
    ]);
    const p = read('.shipline/rules/plan.md');
    assertAllCrlf(p, 'plan.md');
    assert.ok(p.endsWith('- One more rule.\r\n'));
    assert.equal(read('.shipline/rules/security.md'), 'Check auth.\nAlways.\n');
  });

  test('teardown', async () => {
    if (ui) await ui.close();
  });
});

// ---------- the CLAUDE.md block on CRLF ----------

describe('a CRLF CLAUDE.md', () => {
  const TEAM = '# Team\r\n\r\nShip small.\r\n';
  const upgrade = (dir, ...flags) => run(process.execPath, [BIN, 'upgrade', '--dir', dir, ...flags], { cwd: dir });
  const uninstall = (dir, ...flags) => run(process.execPath, [BIN, 'uninstall', '--dir', dir, ...flags], { cwd: dir });
  const md = (dir) => readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');

  test('init adds the block with CRLF; uninstall removes it and leaves the team text exactly as it was', () => {
    const dir = keep(makeRepo({ init: false }));
    writeFileSync(path.join(dir, 'CLAUDE.md'), TEAM);
    const r = runInit(dir);
    assert.equal(r.code, 0, r.stderr);
    const text = md(dir);
    assertAllCrlf(text, 'after init');
    assert.ok(text.startsWith('# Team\r\n\r\nShip small.\r\n\r\n' + START));
    assert.ok(text.includes(END));
    const u = uninstall(dir, '--yes');
    assert.equal(u.code, 0, u.stderr);
    assert.equal(md(dir), TEAM);
  });

  test('removeClaudeMdBlock keeps CRLF; a mixed file follows its first line break', () => {
    const block = `${START}\nShipline text\n${END}\n`;
    assert.equal(removeClaudeMdBlock(CRLF(`# Team\n\n${block}`)), '# Team\r\n');
    const mixed = `# Team\r\nmore\n\n${block}After.\n`;
    const out = removeClaudeMdBlock(mixed);
    assertAllCrlf(out, 'mixed, CRLF first');
    assert.equal(out, toEol(removeClaudeMdBlock(toEol(mixed, '\n')), '\r\n'), 'the same removal as on LF, then CRLF');
    assertAllLf(removeClaudeMdBlock(`# Team\nmore\r\n\r\n${CRLF(block)}After.\r\n`), 'mixed, LF first');
    assert.equal(removeClaudeMdBlock('# no block\r\n'), null);
  });

  test('upgrade re-adds a missing block with CRLF, and --force replaces an edited block keeping CRLF', () => {
    const dir = keep(makeRepo({ init: false }));
    writeFileSync(path.join(dir, 'CLAUDE.md'), TEAM);
    assert.equal(runInit(dir).code, 0);
    const f = path.join(dir, 'CLAUDE.md');
    writeFileSync(f, removeClaudeMdBlock(md(dir)));
    assert.equal(md(dir), TEAM);
    const add = upgrade(dir, '--yes');
    assert.equal(add.code, 0, add.stderr);
    assertAllCrlf(md(dir), 'after upgrade (add)');
    assert.ok(md(dir).startsWith('# Team\r\n\r\nShip small.\r\n\r\n' + START), md(dir));

    writeFileSync(f, md(dir).replace(END, '- Team line inside the block.\r\n' + END) + '\r\nAfter.\r\n');
    const forced = upgrade(dir, '--yes', '--force');
    assert.equal(forced.code, 0, forced.stderr);
    const text = md(dir);
    assertAllCrlf(text, 'after upgrade --force (replace)');
    assert.ok(!text.includes('Team line inside the block.'));
    assert.ok(text.endsWith('\r\nAfter.\r\n'));
  });
});

// ---------- paths ----------

describe('isInside', () => {
  test('posix', () => {
    const P = 'posix';
    assert.equal(isInside('/repo', '/repo', P), true, 'parent == child');
    assert.equal(isInside('/repo', '/repo/a/b.txt', P), true);
    assert.equal(isInside('/repo/', '/repo/a', P), true);
    assert.equal(isInside('/repo', '/repo-other/a', P), false, 'a sibling with the same prefix');
    assert.equal(isInside('/repo', '/', P), false);
    assert.equal(isInside('/repo/a', '/repo', P), false, 'the parent of parent');
    assert.equal(isInside('/repo', '/repo/../etc/passwd', P), false);
    assert.equal(isInside('/Repo', '/repo/a', P), false, 'case-sensitive');
  });

  test('win32: drive letters, case and separators', () => {
    const W = 'win32';
    assert.equal(isInside('C:\\Repo', 'C:\\Repo', W), true, 'parent == child');
    assert.equal(isInside('C:\\Repo', 'c:\\repo', W), true, 'parent == child, other case');
    assert.equal(isInside('C:\\Repo', 'c:\\repo\\src\\a.js', W), true, 'case-insensitive');
    assert.equal(isInside('c:\\repo', 'C:\\REPO\\src', W), true);
    assert.equal(isInside('C:\\Repo', 'C:/Repo/src/a.js', W), true, 'forward slashes');
    assert.equal(isInside('C:\\Repo\\', 'C:\\Repo\\a', W), true, 'a trailing separator');
    assert.equal(isInside('C:\\Repo', 'C:\\Repo-other\\a', W), false, 'a sibling with the same prefix');
    assert.equal(isInside('C:\\Repo', 'D:\\Repo\\a', W), false, 'another drive');
    assert.equal(isInside('C:\\Repo\\a', 'C:\\Repo', W), false);
    assert.equal(isInside('C:\\Repo', 'C:\\Repo\\..\\x', W), false);
  });
});

describe('sameRoot', () => {
  test('posix: an exact match only', () => {
    assert.equal(sameRoot('/Users/dev/repo', '/Users/dev/repo', 'posix'), true);
    assert.equal(sameRoot('/Users/dev/Repo', '/Users/dev/repo', 'posix'), false);
    assert.equal(sameRoot('/Users/dev/repo', '/Users/dev/other', 'posix'), false);
  });

  test('win32: case-insensitive, drive letter included, after resolving', () => {
    assert.equal(sameRoot('C:\\Repo', 'c:\\repo', 'win32'), true);
    assert.equal(sameRoot('C:\\Users\\X\\repo', 'c:\\users\\x\\REPO', 'win32'), true);
    assert.equal(sameRoot('C:\\Repo', 'C:/Repo/', 'win32'), true, 'separators and a trailing one');
    assert.equal(sameRoot('C:\\Repo', 'D:\\Repo', 'win32'), false);
    assert.equal(sameRoot('C:\\Repo', 'C:\\Repo2', 'win32'), false);
  });
});

describe('encodePath on a drive-letter path', () => {
  test('C:\\Users\\x\\repo becomes C--Users-x-repo (Claude Code\'s ~/.claude/projects rule)', () => {
    assert.equal(encodePath('C:\\Users\\x\\repo'), 'C--Users-x-repo');
    assert.equal(encodePath('C:\\Users\\x\\my repo'), 'C--Users-x-my-repo');
  });

  test('transcript.mjs looks for Claude\'s history under the same name', { skip: NEEDS_UI }, async () => {
    const store = await import('../src/store.mjs');
    assert.equal(store.encodePath, encodePath, 'store.mjs (which transcript.mjs uses) re-exports the one lib.mjs encodePath');
    const { findTranscript } = await import('../src/ui/transcript.mjs');
    const cfg = keep(tmpDir('shipline-claude-config-'));
    const root = 'C:\\Users\\x\\repo';
    const id = 'aaaaaaaa-0000-4000-8000-0000000000c1';
    const folder = path.join(cfg, 'projects', 'C--Users-x-repo');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${id}.jsonl`), '\n');
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      assert.equal(findTranscript(root, id), path.join(folder, `${id}.jsonl`));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

// ---------- starting claude on Windows ----------

describe('startSpec', { skip: NEEDS_UI }, () => {
  let startSpec;
  test('load', async () => {
    ({ startSpec } = await import('../src/ui/claude.mjs'));
  });

  test('win32 .cmd / .bat: through the shell, every part double-quoted, inner quotes doubled', () => {
    const args = ['-p', '--mcp-config', 'C:\\Users\\a b\\.shipline\\mcp-1.json', 'say "hi"', ''];
    for (const bin of ['C:\\Program Files\\nodejs\\claude.cmd', 'C:\\tools\\claude.bat', 'C:\\tools\\CLAUDE.CMD', 'C:\\tools\\claude.Bat']) {
      const s = startSpec(bin, args, 'win32');
      assert.equal(s.command, `"${bin}"`, bin);
      assert.deepEqual(s.args, ['"-p"', '"--mcp-config"', '"C:\\Users\\a b\\.shipline\\mcp-1.json"', '"say ""hi"""', '""']);
      assert.deepEqual(s.options, { shell: true, windowsHide: true });
    }
    assert.equal(startSpec('C:\\a "q"\\claude.cmd', [], 'win32').command, '"C:\\a ""q""\\claude.cmd"');
  });

  test('win32 .exe (or no extension): started directly, arguments untouched', () => {
    const args = ['-p', 'C:\\Users\\a b\\x.json'];
    for (const bin of ['C:\\Users\\x\\.local\\bin\\claude.exe', 'C:\\tools\\claude', 'C:\\tools\\claude.cmd.exe']) {
      const s = startSpec(bin, args, 'win32');
      assert.equal(s.command, bin);
      assert.deepEqual(s.args, args);
      assert.deepEqual(s.options, {});
    }
  });

  test('other platforms are unchanged, even for a .cmd name', () => {
    const args = ['-p', '/tmp/a b/x.json'];
    for (const platform of ['darwin', 'linux']) {
      for (const bin of ['/usr/local/bin/claude', '/x/claude.cmd']) {
        const s = startSpec(bin, args, platform);
        assert.deepEqual(s, { command: bin, args, options: {} });
      }
    }
  });
});
