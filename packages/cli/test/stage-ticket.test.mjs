// Teams Phase 1, D: the ticket stage in the vendored stage.mjs. GitHub Issues keys (`--ticket 123 | #123 |
// issue-123` with tracker: github), `Closes #n` in pr-summary, the tracker line at the ticket stage, and the
// jira/ticket alias in both directions (a 0.9.0 manifest against a 0.10.0 workflow, and the reverse): advance, skip,
// status, reopen and rules loading. 1.0 (plan item 19): tracker: none, the default, skips the ticket stage on its own.
// Runs the scripts of a real temp repo. Node 18+.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo, removeDir, stage, storeOf } from './helpers.mjs';

let dir;
let configText;
let n = 0;
const session = () => `ticket-${++n}`;
const tasks = () => path.join(storeOf(dir), 'tasks');
const manifest = (folder) => JSON.parse(readFileSync(path.join(tasks(), folder, 'manifest.json'), 'utf8'));
const cfgFile = () => path.join(dir, '.shipline', 'config.yml');
const setTracker = (tracker) => writeFileSync(cfgFile(), configText.replace(/^tracker: jira$/m, `tracker: ${tracker}`));
const ok = (r, what) => {
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  return r;
};

before(() => {
  dir = makeRepo({ commitInit: true });
  const installed = readFileSync(cfgFile(), 'utf8');
  assert.match(installed, /^tracker: none$/m, 'none is the default');
  // Most tests below need a ticket stage to work with, so the base config here uses jira.
  configText = installed.replace(/^tracker: none$/m, 'tracker: jira');
  writeFileSync(cfgFile(), configText);
});
after(() => removeDir(dir));

describe('tracker: github', () => {
  before(() => setTracker('github'));
  after(() => writeFileSync(cfgFile(), configText));

  for (const [form, i] of [['123', 123], ['#123', 123], ['issue-123', 123], [' #45 ', 45], ['ISSUE-7', 7]]) {
    test(`--ticket "${form}" gives the key issue-${i}, task.issue ${i}, and that branch and folder`, () => {
      const s = session();
      const r = ok(stage(dir, ['start', '--workflow', 'feature', '--title', 'Add export', '--ticket', form], s), form);
      const folder = `issue-${i}-add-export`;
      assert.ok(r.stdout.startsWith(`Started Feature task in ${path.join(tasks(), folder)}\n`), r.stdout);
      assert.match(r.stdout, new RegExp(`^Suggested branch: feature/issue-${i}-add-export$`, 'm'));
      const m = manifest(folder);
      assert.equal(m.task.key, `issue-${i}`);
      assert.equal(m.task.issue, i);
      assert.equal(m.task.slug, folder);
      assert.equal(m.task.branch, `feature/issue-${i}-add-export`);
      // The ticket stage tells Claude how to read this issue.
      assert.ok(r.stdout.includes(`Tracker: github. Read the issue with \`gh issue view ${i} --json number,title,body,labels,url,state\` (read-only)`), r.stdout);
      rmSync(path.join(tasks(), folder), { recursive: true });
    });
  }

  test('anything else (a Jira key, words, an empty value) exits 1 and starts nothing', () => {
    for (const bad of ['PROJ-12', 'abc', '12a', '#', 'issue-', '1.5', '']) {
      const r = stage(dir, ['start', '--workflow', 'feature', '--title', 'Bad key', '--ticket', bad], session());
      assert.equal(r.code, 1, `${bad}: ${r.stdout}`);
      assert.match(r.stderr, /GitHub issue numbers look like 123 or #123\./, bad);
    }
    assert.ok(!readdirSafe(tasks()).some((f) => f.includes('bad-key')));
  });

  test('pr-summary starts with "Closes #123", then the summary', () => {
    const s = session();
    ok(stage(dir, ['start', '--workflow', 'small', '--title', 'Close it', '--ticket', '#123'], s), 'start');
    const r = ok(stage(dir, ['pr-summary'], s), 'pr-summary');
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], 'Closes #123');
    assert.equal(lines[1], '### Shipline');
    rmSync(path.join(tasks(), 'issue-123-close-it'), { recursive: true });
  });

  test('a task with no issue number: no Closes line, and the ticket stage says to use pasted details or skip', () => {
    const s = session();
    const r = ok(stage(dir, ['start', '--workflow', 'small', '--title', 'No issue'], s), 'start');
    assert.equal(manifest('no-issue').task.issue, undefined);
    assert.equal(manifest('no-issue').task.key, null);
    assert.match(r.stdout, /^Suggested branch: small\/no-issue$/m, 'an empty key is dropped from the branch');
    assert.match(r.stdout, /Tracker: github\. This task has no issue number/);
    assert.ok(ok(stage(dir, ['pr-summary'], s), 'pr-summary').stdout.startsWith('### Shipline\n'));
    rmSync(path.join(tasks(), 'no-issue'), { recursive: true });
  });
});

describe('tracker: jira', () => {
  test('--ticket is upper-cased as before; pr-summary has no Closes line even for a numeric key', () => {
    const s = session();
    const r = ok(stage(dir, ['start', '--workflow', 'small', '--title', 'Jira one', '--ticket', 'll-12'], s), 'start');
    assert.equal(manifest('LL-12-jira-one').task.key, 'LL-12');
    assert.equal(manifest('LL-12-jira-one').task.issue, undefined);
    assert.match(r.stdout, /Tracker: jira\. Read the ticket through the Atlassian tools \(read-only\)/);
    assert.ok(ok(stage(dir, ['pr-summary'], s), 'pr-summary').stdout.startsWith('### Shipline\n'));
    const s2 = session();
    ok(stage(dir, ['start', '--workflow', 'small', '--title', 'Numeric', '--ticket', '123'], s2), 'start');
    assert.equal(manifest('123-numeric').task.issue, undefined);
    assert.ok(!stage(dir, ['pr-summary'], s2).stdout.includes('Closes'));
    rmSync(path.join(tasks(), 'LL-12-jira-one'), { recursive: true });
    rmSync(path.join(tasks(), '123-numeric'), { recursive: true });
  });

  test('an unsupported tracker: the ticket stage says to skip', () => {
    setTracker('linear');
    try {
      const s = session();
      const r = ok(stage(dir, ['start', '--workflow', 'small', '--title', 'Linear', '--ticket', 'lin-1'], s), 'start');
      assert.match(r.stdout, /Tracker: "linear" is not supported; skip this stage/);
      rmSync(path.join(tasks(), 'LIN-1-linear'), { recursive: true });
    } finally {
      writeFileSync(cfgFile(), configText);
    }
  });
});

// The stage alias. `hotfix` is used: ticket (optional, guide) -> fix -> verify (block, confirm) -> pr.
describe('the jira/ticket alias', () => {
  const wfFile = () => path.join(dir, '.shipline', 'workflows', 'hotfix.yml');
  const rulesDir = () => path.join(dir, '.shipline', 'rules');
  let wfText;
  let ticketRules;
  before(() => {
    wfText = readFileSync(wfFile(), 'utf8');
    ticketRules = readFileSync(path.join(rulesDir(), 'ticket.md'), 'utf8');
    assert.match(wfText, /^ {2}- id: ticket\n {4}name: Ticket\n/m);
  });
  after(() => {
    writeFileSync(wfFile(), wfText);
    writeFileSync(path.join(rulesDir(), 'ticket.md'), ticketRules);
    rmSync(path.join(rulesDir(), 'jira.md'), { force: true });
  });
  const workflowWith = (id) => writeFileSync(wfFile(), wfText.replace('  - id: ticket\n', `  - id: ${id}\n`));

  // Starts a hotfix task while the workflow names the stage `startId`, then switches the workflow to `laterId`.
  function taskAcross(startId, laterId, title) {
    workflowWith(startId);
    const s = session();
    ok(stage(dir, ['start', '--workflow', 'hotfix', '--title', title], s), 'start');
    workflowWith(laterId);
    return s;
  }

  for (const [from, to] of [['jira', 'ticket'], ['ticket', 'jira']]) {
    test(`a manifest with \`${from}\` against a workflow with \`${to}\`: status, skip (optional, no question), reopen, advance`, () => {
      const title = `Alias ${from}`;
      const slug = `alias-${from}`;
      const s = taskAcross(from, to, title);
      assert.equal(manifest(slug).stages[0].id, from, 'the manifest keeps its own id');

      const st = ok(stage(dir, ['status', '--verbose'], s), 'status');
      assert.match(st.stdout, new RegExp(`^\\[>\\] ${from}$`, 'm'));
      assert.match(st.stdout, new RegExp(`^Current stage: Ticket \\[${from}\\]$`, 'm'), 'the stage name comes from the workflow');
      assert.match(st.stdout, /^Artifact to produce: .*ticket\.md$/m);
      assert.match(st.stdout, /^Tracker: jira\./m);

      // Optional in the workflow, so skipping needs no answer (without the alias it would ask).
      const sk = ok(stage(dir, ['skip', '--reason', 'Jira not connected'], s), 'skip');
      assert.match(sk.stdout, new RegExp(`^Skipped: ${from}$`, 'm'));
      assert.match(sk.stdout, /^Current stage: Fix \[fix\]$/m);
      assert.equal(manifest(slug).stages[0].status, 'skipped');

      // Reopen by either id.
      const ro = ok(stage(dir, ['reopen', to], s), 'reopen');
      assert.match(ro.stdout, new RegExp(`^Current stage: Ticket \\[${from}\\]$`, 'm'));
      assert.equal(manifest(slug).stages[0].status, 'in_progress');
      assert.equal(manifest(slug).stages[1].status, 'pending');

      // Advance needs the workflow's artifact, found through the alias.
      const early = stage(dir, ['advance'], s);
      assert.equal(early.code, 1);
      assert.match(early.stderr, /ticket\.md does not exist yet/);
      writeFileSync(path.join(tasks(), slug, 'ticket.md'), '# Ticket\n');
      ok(stage(dir, ['advance'], s), 'advance');
      assert.equal(manifest(slug).stages[0].status, 'done');

      // The summary the CI check reads: the stage's enforcement and provenance come from the workflow entry.
      const pr = ok(stage(dir, ['pr-summary'], s), 'pr-summary');
      const data = JSON.parse(/<!-- shipline:summary (.*) -->/.exec(pr.stdout)[1]);
      assert.deepEqual(data.stages[0], { id: from, status: 'done', enforcement: 'guide', confirmed: 'auto' });
      rmSync(path.join(tasks(), slug), { recursive: true });
      workflowWith('ticket');
    });
  }

  test('rules for the ticket stage: rules/ticket.md first, then rules/jira.md, for either id', () => {
    writeFileSync(path.join(rulesDir(), 'ticket.md'), '# Ticket rules\n\n- from ticket.md\n');
    writeFileSync(path.join(rulesDir(), 'jira.md'), '# Jira rules\n\n- from jira.md\n');
    for (const id of ['ticket', 'jira']) {
      workflowWith(id);
      const s = session();
      const r = ok(stage(dir, ['start', '--workflow', 'hotfix', '--title', `Rules ${id}`], s), 'start');
      assert.match(r.stdout, /Repo rules for this stage \(\.shipline\/rules\/ticket\.md\):\n# Ticket rules\n\n- from ticket\.md/, id);
      rmSync(path.join(rulesDir(), 'ticket.md'));
      const st = ok(stage(dir, ['status', '--verbose'], s), 'status');
      assert.match(st.stdout, /Repo rules for this stage \(\.shipline\/rules\/jira\.md\):\n# Jira rules\n\n- from jira\.md/, id);
      writeFileSync(path.join(rulesDir(), 'ticket.md'), '# Ticket rules\n\n- from ticket.md\n');
      rmSync(path.join(tasks(), `rules-${id}`), { recursive: true });
    }
    rmSync(path.join(rulesDir(), 'jira.md'));
    rmSync(path.join(rulesDir(), 'ticket.md'));
    workflowWith('ticket');
    const s = session();
    const r = ok(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'No rules'], s), 'start');
    assert.ok(!r.stdout.includes('Repo rules for this stage'), 'neither file: no rules section');
    rmSync(path.join(tasks(), 'no-rules'), { recursive: true });
  });

  test('a workflow with both a jira and a ticket stage: each matches only itself', () => {
    writeFileSync(
      wfFile(),
      wfText.replace('  - id: ticket\n', '  - id: jira\n    name: Old Jira\n    artifact: jira.md\n    enforcement: guide\n  - id: ticket\n'),
    );
    const s = session();
    const r = ok(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Both'], s), 'start');
    assert.match(r.stdout, /^Current stage: Old Jira \[jira\]$/m);
    assert.match(r.stdout, /^Artifact to produce: .*jira\.md$/m);
    writeFileSync(path.join(tasks(), 'both', 'jira.md'), 'x\n');
    const a = ok(stage(dir, ['advance'], s), 'advance');
    assert.match(a.stdout, /^Current stage: Ticket \[ticket\]$/m);
    assert.match(a.stdout, /^Artifact to produce: .*ticket\.md$/m);
    rmSync(path.join(tasks(), 'both'), { recursive: true });
    writeFileSync(wfFile(), wfText);
  });
});

// 1.0 plan, item 19: with no tracker there is no ticket to read, so the ticket stage is skipped on its own.
describe('tracker: none (the default)', () => {
  const wfDir = () => path.join(dir, '.shipline', 'workflows');
  before(() => setTracker('none'));
  after(() => {
    writeFileSync(cfgFile(), configText);
    rmSync(path.join(wfDir(), 'strict.yml'), { force: true });
  });

  test('every shipped workflow: the optional ticket stage is skipped on start ("No tracker", via optional), no question', () => {
    for (const wf of ['feature', 'bugfix', 'hotfix', 'small']) {
      const s = session();
      const r = ok(stage(dir, ['start', '--workflow', wf, '--title', `None ${wf}`, '--ui', 'false'], s), wf);
      const m = manifest(`none-${wf}`);
      const t = m.stages.find((x) => x.id === 'ticket');
      assert.equal(t.status, 'skipped', wf);
      assert.equal(t.reason, 'No tracker', wf);
      assert.equal(t.skipped.via, 'optional', wf);
      assert.equal(t.skipped.reason, 'No tracker', wf);
      assert.ok(!Number.isNaN(Date.parse(t.skipped.at)), wf);
      assert.notEqual(m.stages.find((x) => x.status === 'in_progress').id, 'ticket', wf);
      assert.ok(!/^Current stage: Ticket/m.test(r.stdout), r.stdout);
      const st = ok(stage(dir, ['status'], s), 'status');
      assert.match(st.stdout, /^\[-\] ticket \(No tracker\)$/m, wf);
      rmSync(path.join(tasks(), `none-${wf}`), { recursive: true });
    }
  });

  test('a custom workflow whose ticket stage is not optional: skipped via auto; the PR summary marks it skipped', () => {
    writeFileSync(
      path.join(wfDir(), 'strict.yml'),
      'id: strict\nname: Strict\nstages:\n  - id: ticket\n    name: Ticket\n    artifact: ticket.md\n    enforcement: block\n  - id: build\n    name: Build\n    enforcement: guide\n',
    );
    const s = session();
    ok(stage(dir, ['start', '--workflow', 'strict', '--title', 'Strict one'], s), 'start');
    const t = manifest('strict-one').stages[0];
    assert.equal(t.status, 'skipped');
    assert.equal(t.skipped.via, 'auto');
    assert.equal(t.skipped.reason, 'No tracker');
    assert.equal(manifest('strict-one').stages[1].status, 'in_progress');
    const pr = ok(stage(dir, ['pr-summary'], s), 'pr-summary');
    const data = JSON.parse(/<!-- shipline:summary (.*) -->/.exec(pr.stdout)[1]);
    assert.deepEqual(data.stages[0], { id: 'ticket', status: 'skipped', enforcement: 'block', confirmed: 'auto' });
    rmSync(path.join(tasks(), 'strict-one'), { recursive: true });
  });

  test('a --ticket key is still used in the branch and folder; the stage is still skipped', () => {
    const s = session();
    const r = ok(stage(dir, ['start', '--workflow', 'small', '--title', 'Keyed', '--ticket', 'll-9'], s), 'start');
    assert.match(r.stdout, /^Suggested branch: small\/LL-9-keyed$/m);
    assert.equal(manifest('LL-9-keyed').stages[0].status, 'skipped');
    rmSync(path.join(tasks(), 'LL-9-keyed'), { recursive: true });
  });

  test('an old manifest stage named `jira` is matched too', () => {
    const wf = path.join(wfDir(), 'hotfix.yml');
    const text = readFileSync(wf, 'utf8');
    try {
      writeFileSync(wf, text.replace('  - id: ticket\n', '  - id: jira\n'));
      const s = session();
      ok(stage(dir, ['start', '--workflow', 'hotfix', '--title', 'Old id'], s), 'start');
      assert.equal(manifest('old-id').stages[0].id, 'jira');
      assert.equal(manifest('old-id').stages[0].status, 'skipped');
      rmSync(path.join(tasks(), 'old-id'), { recursive: true });
    } finally {
      writeFileSync(wf, text);
    }
  });

  test('a missing or empty tracker key counts as none', () => {
    for (const cfg of [configText.replace(/^tracker: jira\n/m, ''), configText.replace(/^tracker: jira$/m, 'tracker: ""')]) {
      writeFileSync(cfgFile(), cfg);
      const s = session();
      ok(stage(dir, ['start', '--workflow', 'small', '--title', 'Keyless'], s), 'start');
      assert.equal(manifest('keyless').stages[0].status, 'skipped');
      rmSync(path.join(tasks(), 'keyless'), { recursive: true });
    }
    setTracker('none');
  });
});

function readdirSafe(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}
