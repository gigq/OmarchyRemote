import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchSources } from './source-watch.mjs';

test('source polling survives atomic replacement, directory replacement, and deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omarchy-watch-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  const file = path.join(source, 'file.js');
  await writeFile(file, 'one');
  let revisions = 0;
  const watcher = watchSources([source], () => revisions++, { interval: 20 });
  async function expectChange(action) {
    const before = revisions;
    await action();
    const deadline = Date.now() + 2000;
    while (revisions === before && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(revisions > before, 'source change was detected');
  }
  try {
    await expectChange(() => writeFile(file, 'two'));
    await writeFile(path.join(root, 'replacement'), 'new');
    await expectChange(() => rename(path.join(root, 'replacement'), file));
    await mkdir(path.join(root, 'new-source'));
    await writeFile(path.join(root, 'new-source/file.js'), 'directory replacement');
    await expectChange(async () => {
      await rename(source, path.join(root, 'old-source'));
      await rename(path.join(root, 'new-source'), source);
    });
    await expectChange(() => writeFile(file, 'after directory replacement'));
    await expectChange(() => rm(file));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
