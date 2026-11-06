// Teams Phase 2 (docs/plans/shipline-teams-phase2.md), C and Tests: the required-sections helpers in the vendored
// lib.mjs, findSection(markdown, heading) and sectionProblems(markdown, sections). The `advance` message built
// from them is tested end to end in stage-gate.test.mjs. Node 18+, so it stays in test:hooks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findSection, sectionProblems } from '../templates/shipline/bin/lib.mjs';

const TEXT = 'Enough real text to pass the twenty character minimum.';

describe('sectionProblems', () => {
  test('a present section with enough text has no problem', () => {
    assert.deepEqual(sectionProblems(`# Plan\n\n## Scope\n\n${TEXT}\n`, ['Scope']), []);
  });

  test('a missing heading is "(no heading)"; text that only mentions it does not count', () => {
    assert.deepEqual(sectionProblems(`# Plan\n\nThe scope is small. ${TEXT}\n`, ['Scope']), ['Scope (no heading)']);
  });

  test('under 20 non-whitespace characters is "(too short: ...)"; whitespace does not count, 20 is enough', () => {
    assert.deepEqual(sectionProblems('## Scope\n\n', ['Scope']), ['Scope (too short: write at least 20 characters under it)']);
    assert.deepEqual(sectionProblems('## Scope\n\n  a b c d e f g h i j k l m n o p q r s  \n\n', ['Scope']), ['Scope (too short: write at least 20 characters under it)'], '19 characters');
    assert.deepEqual(sectionProblems('## Scope\n\n  a b c d e f g h i j k l m n o p q r s t\n', ['Scope']), [], '20 characters');
  });

  test('matching ignores case and surrounding whitespace', () => {
    assert.deepEqual(sectionProblems(`##   FILES TO TOUCH   \n${TEXT}\n`, ['Files to touch']), []);
    assert.deepEqual(sectionProblems(`## files to touch\n${TEXT}\n`, ['  Files To Touch ']), []);
  });

  test('any heading level from # to ######; seven #s is not a heading', () => {
    for (let n = 1; n <= 6; n++) assert.deepEqual(sectionProblems(`${'#'.repeat(n)} Scope\n${TEXT}\n`, ['Scope']), [], `level ${n}`);
    assert.deepEqual(sectionProblems(`####### Scope\n${TEXT}\n`, ['Scope']), ['Scope (no heading)']);
    assert.deepEqual(sectionProblems(`#Scope\n${TEXT}\n`, ['Scope']), ['Scope (no heading)'], 'a heading needs a space after the #s');
  });

  test('a trailing ":" is ignored, on the heading and on the configured name', () => {
    assert.deepEqual(sectionProblems(`## Scope:\n${TEXT}\n`, ['Scope']), []);
    assert.deepEqual(sectionProblems(`## Scope\n${TEXT}\n`, ['Scope:']), []);
  });

  test('headings inside fenced code blocks are ignored', () => {
    const fenced = `# Plan\n\n\`\`\`md\n## Scope\n${TEXT}\n\`\`\`\n\n~~~\n## Verification\n${TEXT}\n~~~\n`;
    assert.deepEqual(sectionProblems(fenced, ['Scope', 'Verification']), ['Scope (no heading)', 'Verification (no heading)']);
  });

  test('a section runs to the next heading of the same or a higher level; nested headings are inside it', () => {
    // The text sits under a deeper heading: it still belongs to Scope.
    const nested = `## Scope\n\n### In\n${TEXT}\n\n## Verification\n\n`;
    assert.deepEqual(sectionProblems(nested, ['Scope', 'Verification']), ['Verification (too short: write at least 20 characters under it)']);
    // A same-level heading ends it, so the text after it is not Scope's.
    assert.deepEqual(sectionProblems(`## Scope\n\n## Other\n${TEXT}\n`, ['Scope']), ['Scope (too short: write at least 20 characters under it)']);
    // A higher-level heading ends it too.
    assert.deepEqual(sectionProblems(`### Scope\n\n# Next\n${TEXT}\n`, ['Scope']), ['Scope (too short: write at least 20 characters under it)']);
  });

  test('every problem is listed, in the order of `sections`; CRLF text works the same', () => {
    const md = `# Plan\r\n\r\n## Verification\r\n\r\n## Scope\r\n${TEXT}\r\n`;
    assert.deepEqual(sectionProblems(md, ['Scope', 'Files to touch', 'Verification']), ['Files to touch (no heading)', 'Verification (too short: write at least 20 characters under it)']);
  });

  test('no sections, or a non-list, gives no problems', () => {
    assert.deepEqual(sectionProblems('', []), []);
    assert.deepEqual(sectionProblems('', undefined), []);
  });
});

describe('findSection', () => {
  test('returns the trimmed text under the first matching heading, up to the next same-or-higher heading', () => {
    const md = `# Plan\n\n## Scope\n\n- one\n- two\n\n### Detail\nmore\n\n## Files to touch\nx\n`;
    assert.deepEqual(findSection(md, 'scope'), { found: true, text: '- one\n- two\n\n### Detail\nmore' });
    assert.deepEqual(findSection(md, 'Files to touch'), { found: true, text: 'x' });
    assert.deepEqual(findSection(md, 'Risks'), { found: false, text: '' });
  });

  test('a closing run of #s is not part of the title', () => {
    assert.deepEqual(findSection('## Scope ##\nbody\n', 'Scope'), { found: true, text: 'body' });
  });
});
