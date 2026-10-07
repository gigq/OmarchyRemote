import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localHostId, openHostFolder } from '../src/folders.js';

test('local identity is read from the host database without creating a missing database', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-folder-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(await localHostId(home), null);
  assert.deepEqual(fs.readdirSync(home), []);
  const dir = path.join(home, '.local/share/omarchy-remote');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'settings.sqlite3'));
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('host_id','local-id')"
  );
  db.close();
  assert.equal(await localHostId(home), 'local-id');
});

test('open directories only for the matching host, with fallback on all failures', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-folder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'spaces & unicode café');
  fs.mkdirSync(folder);
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, 'test');
  const opened = [];
  let selected = 'https://local.tailnet.example/native/';
  const options = {
    selected: () => selected,
    hostId: async () => 'local-id',
    fetch: async (url, init) => {
      assert.equal(url, 'https://local.tailnet.example/api/state');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['X-Hyprland-Client'], '1');
      return { ok: true, json: async () => ({ host_id: 'local-id' }) };
    },
    openPath: async p => {
      opened.push(p);
      return '';
    },
  };
  assert.equal(await openHostFolder(folder, options), true);
  assert.deepEqual(opened, [folder]);
  opened.length = 0;
  for (const bad of [
    file,
    path.join(dir, 'missing'),
    'relative',
    'https://example.com',
    null,
    '/bad\0path',
  ])
    assert.equal(await openHostFolder(bad, options), false);
  for (const result of [{ host_id: 'remote-id' }, {}, { host_id: '' }])
    assert.equal(
      await openHostFolder(folder, {
        ...options,
        fetch: async () => ({ ok: true, json: async () => result }),
      }),
      false
    );
  assert.equal(await openHostFolder(folder, { ...options, hostId: async () => null }), false);
  assert.equal(
    await openHostFolder(folder, {
      ...options,
      fetch: async () => {
        throw new Error('Offline');
      },
    }),
    false
  );
  assert.equal(
    await openHostFolder(folder, { ...options, fetch: async () => ({ ok: false }) }),
    false
  );
  assert.equal(
    await openHostFolder(folder, { ...options, openPath: async () => 'No application' }),
    false
  );
  assert.equal(
    await openHostFolder(folder, {
      ...options,
      openPath: async () => {
        throw new Error('Failed');
      },
    }),
    false
  );
  assert.equal(
    await openHostFolder(folder, {
      ...options,
      fetch: async () => {
        selected = 'https://other.example/native/';
        return { ok: true, json: async () => ({ host_id: 'local-id' }) };
      },
    }),
    false
  );
  assert.deepEqual(opened, []);
});
