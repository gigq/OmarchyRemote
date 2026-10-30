import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { standaloneConfiguration } from '../src/standalone.js';

test('standalone configuration validates the app identity and remote host', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-standalone-'));
  const file = path.join(folder, 'standalone.json');
  try {
    assert.equal(standaloneConfiguration(file), null);
    fs.writeFileSync(
      file,
      JSON.stringify({ key: 'corral', name: 'Corral', host: 'https://example.test:12443' })
    );
    assert.deepEqual(standaloneConfiguration(file), {
      key: 'corral',
      name: 'Corral',
      host: 'https://example.test:12443/native/',
    });
    fs.writeFileSync(
      file,
      JSON.stringify({ key: '../corral', name: 'Corral', host: 'https://example.test' })
    );
    assert.throws(() => standaloneConfiguration(file), /Invalid/);
    fs.writeFileSync(
      file,
      JSON.stringify({ key: 'corral', name: 'Corral', host: 'http://example.test' })
    );
    assert.throws(() => standaloneConfiguration(file), /HTTPS/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
