// Teams Phase 4: packages/ui/src/lib/confirmations.ts is a TypeScript copy of `needsAnswer` in the hooks' lib.mjs
// (the task panel uses it to say whether Claude asks before moving on). This keeps the two in step: the copy's
// function body is plain JavaScript, so it is cut out of the .ts file, evaluated, and run over the same truth table
// as the lib.mjs version. The UI package has no test runner of its own, so this lives in the Node 20 suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_ROOT } from '../helpers.mjs';
import { needsAnswer as libNeedsAnswer } from '../../templates/shipline/bin/lib.mjs';

const UI_FILE = path.join(CLI_ROOT, '..', 'ui', 'src', 'lib', 'confirmations.ts');

// The exported needsAnswer of the .ts file as a JS function: its two parameter names and its body.
function uiNeedsAnswer() {
  const src = readFileSync(UI_FILE, 'utf8');
  const m = /export function needsAnswer\(\s*(\w+)\s*:[^,]+,\s*(\w+)\s*:[^)]+\)\s*:\s*boolean\s*\{/.exec(src);
  assert.ok(m, `export function needsAnswer(stage: ..., config: ...): boolean { ... } not found in ${UI_FILE}`);
  // The body: from after the opening brace to its matching closing brace.
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < src.length && depth; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  assert.equal(depth, 0, 'unbalanced braces in needsAnswer');
  const body = src.slice(start, i - 1);
  // A type annotation in the body would make it invalid JS; say so plainly instead of a SyntaxError.
  assert.ok(!/\bas\s+[A-Z]|:\s*(?:boolean|string|number)\b/.test(body), `needsAnswer's body uses TypeScript-only syntax; keep it plain JS:\n${body}`);
  return new Function(m[1], m[2], body);
}

const CONFIRM_VALUES = [true, false, undefined, null, 'true'];
const CHECKPOINT_VALUES = [true, false, undefined, null, 'true'];
const MODES = ['standard', 'light', undefined, null, '', 'Light', 'lite'];
const expected = (confirm, checkpoint, mode) => confirm === true && (mode !== 'light' || checkpoint === true);

describe('the UI copy of needsAnswer (packages/ui/src/lib/confirmations.ts)', () => {
  test('matches lib.mjs and the rule on every combination, including missing stage and config', () => {
    const ui = uiNeedsAnswer();
    let cases = 0;
    for (const confirm of CONFIRM_VALUES) {
      for (const checkpoint of CHECKPOINT_VALUES) {
        for (const mode of MODES) {
          const sc = { id: 's', confirm_to_advance: confirm, checkpoint };
          const cfg = { confirmations: mode };
          const label = JSON.stringify({ confirm, checkpoint, mode });
          assert.equal(ui(sc, cfg), expected(confirm, checkpoint, mode), `ui ${label}`);
          assert.equal(ui(sc, cfg), libNeedsAnswer(sc, cfg), `ui vs lib ${label}`);
          cases++;
        }
      }
    }
    assert.equal(cases, CONFIRM_VALUES.length * CHECKPOINT_VALUES.length * MODES.length);
    for (const [sc, cfg] of [
      [null, null],
      [undefined, undefined],
      [{ confirm_to_advance: true }, null],
      [{ confirm_to_advance: true }, undefined],
      [{ confirm_to_advance: true }, {}],
      [{ confirm_to_advance: true, checkpoint: true }, null],
      [null, { confirmations: 'light' }],
    ]) {
      assert.equal(ui(sc, cfg), libNeedsAnswer(sc, cfg), JSON.stringify([sc, cfg]));
    }
  });

  test('points back to lib.mjs as the source of the rule', () => {
    assert.match(readFileSync(UI_FILE, 'utf8'), /packages\/cli\/templates\/shipline\/bin\/lib\.mjs/);
  });
});
