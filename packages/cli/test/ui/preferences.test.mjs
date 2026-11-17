// The server-wide UI preferences: GET/POST /api/preferences, backed by $SHIPLINE_HOME/ui-preferences.json.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeRepo, removeDir } from '../helpers.mjs';
import { api, openEvents, startUi } from './helpers.mjs';

let dir;
let ui;
let file;

before(async () => {
  dir = makeRepo({ commitInit: true });
  ui = await startUi(dir);
  file = path.join(ui.home, 'ui-preferences.json');
});
after(async () => {
  if (ui) await ui.close();
  removeDir(dir);
});

describe('/api/preferences', () => {
  test('a missing file reads as mocha, and is not created by reading', async () => {
    rmSync(file, { force: true });
    const r = await api(ui, 'GET', '/api/preferences');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { palette: 'mocha' });
    assert.throws(() => readFileSync(file, 'utf8'), { code: 'ENOENT' });
  });

  test('a corrupt file or an unknown palette reads as mocha, and reading leaves the file alone', async () => {
    writeFileSync(file, '{ not json');
    assert.deepEqual((await api(ui, 'GET', '/api/preferences')).json, { palette: 'mocha' });
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
    writeFileSync(file, JSON.stringify({ version: 1, palette: 'neon' }));
    assert.deepEqual((await api(ui, 'GET', '/api/preferences')).json, { palette: 'mocha' });
  });

  test('POST saves the palette, answers it, broadcasts it and GET returns it', async () => {
    rmSync(file, { force: true });
    const events = await openEvents(ui);
    try {
      const since = events.mark();
      const r = await api(ui, 'POST', '/api/preferences', { body: { palette: 'sage' } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { palette: 'sage' });
      const ev = await events.waitFor((e) => e.type === 'preferences', 3000, since);
      assert.deepEqual(ev.data, { palette: 'sage' });
    } finally {
      events.close();
    }
    assert.deepEqual((await api(ui, 'GET', '/api/preferences')).json, { palette: 'sage' });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).palette, 'sage');
  });

  test('an unknown or missing palette is a 400 and changes nothing', async () => {
    await api(ui, 'POST', '/api/preferences', { body: { palette: 'ink' } });
    for (const body of [{ palette: 'neon' }, {}, { palette: 3 }]) {
      const r = await api(ui, 'POST', '/api/preferences', { body });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, 'bad-request');
      assert.match(r.json.error.message, /classic, graphite, ink, sage, mocha/);
    }
    assert.deepEqual((await api(ui, 'GET', '/api/preferences')).json, { palette: 'ink' });
  });

  test('other keys in the file are kept on write', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, palette: 'classic', density: 'compact' }));
    const r = await api(ui, 'POST', '/api/preferences', { body: { palette: 'ink' } });
    assert.equal(r.status, 200);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.palette, 'ink');
    assert.equal(saved.density, 'compact');
    assert.equal(saved.version, 1);
  });
});
