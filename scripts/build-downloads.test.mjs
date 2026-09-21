import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveBuildDownload } from './build-downloads.mjs';

test('fresh hosts show setup and private files cannot escape the download directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'omarchy-builds-'));
  const previous = process.env.OMARCHY_BUILDS_DIR;
  process.env.OMARCHY_BUILDS_DIR = path.join(root, 'downloads');
  const server = http.createServer((req, res) => {
    serveBuildDownload(req, res, new URL(req.url, 'http://localhost').pathname).catch(() =>
      res.destroy()
    );
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.match(await (await fetch(base + '/builds/')).text(), /No builds yet/);
    assert.deepEqual(await (await fetch(base + '/builds/catalog.json')).json(), []);
    assert.match(await (await fetch(base + '/builds/SKILL.md')).text(), /name: omarchy-builds/);
    const hash = 'a'.repeat(64);
    await mkdir(path.join(process.env.OMARCHY_BUILDS_DIR, hash), { recursive: true });
    await writeFile(path.join(root, 'private'), 'private');
    await symlink(
      path.join(root, 'private'),
      path.join(process.env.OMARCHY_BUILDS_DIR, hash, 'app.ipa')
    );
    assert.equal((await fetch(base + `/builds/${hash}/app.ipa`)).status, 404);
    assert.equal((await fetch(base + '/builds/.publish.lock')).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.OMARCHY_BUILDS_DIR;
    else process.env.OMARCHY_BUILDS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
