import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Appearance } from '../src/appearance.js';

test('independent app instances share appearance per host and retain other settings', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-appearance-'));
  let received;
  const first = new Appearance(folder);
  const second = new Appearance(folder, (scope, values) => {
    received = { scope, values };
  });
  try {
    assert.deepEqual(second.get('host-a'), {});
    first.set('host-a', 'omarchy-theme', 'catppuccin');
    const deadline = Date.now() + 5000;
    while (!received && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(received, { scope: 'host-a', values: { 'omarchy-theme': 'catppuccin' } });
    second.set('host-a', 'omarchy-wallpapers', '{"catppuccin":"waves"}');
    assert.deepEqual(first.get('host-a'), {
      'omarchy-theme': 'catppuccin',
      'omarchy-wallpapers': '{"catppuccin":"waves"}',
    });
    assert.deepEqual(first.get('host-b'), {});
    assert.throws(() => first.set('host-a', 'omarchy-layout-desk', 'x'), /Unsupported/);
    const reopened = new Appearance(folder);
    try {
      assert.equal(reopened.get('host-a')['omarchy-theme'], 'catppuccin');
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
    second.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
