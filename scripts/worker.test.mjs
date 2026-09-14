import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../dist/server/index.js';

const request = (pathname, method = 'GET') =>
  worker.fetch(new Request(`https://hyprland.test${pathname}`, { method }));
test('install metadata and every precached asset are served with valid types', async () => {
  const manifestResponse = await request('/manifest.webmanifest');
  assert.match(manifestResponse.headers.get('content-type'), /manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const response = await request(icon.src);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32BE(16), Number(icon.sizes.split('x')[0]));
  }
  const sw = await (await request('/sw.js')).text();
  const paths = JSON.parse(sw.match(/const URLS = (.*);/)[1]);
  for (const pathname of paths) assert.equal((await request(pathname)).status, 200, pathname);
  const html = await (await request('/')).text();
  for (const match of html.matchAll(/(?:src|href)="(\/[^"{}]+)"/g))
    assert.equal((await request(match[1])).status, 200, match[1]);
  assert.ok(!html.includes('<x-import'));
});
test('service worker installs and serves the shell with network unavailable', async () => {
  const handlers = {};
  const entries = new Map();
  let offline = false;
  const context = {
    URL,
    Request,
    self: {
      location: { origin: 'https://hyprland.test' },
      clients: { claim: async () => {} },
      addEventListener: (name, fn) => {
        handlers[name] = fn;
      },
    },
    caches: {
      open: async () => ({
        put: async (key, value) => entries.set(key, value),
        match: async key => entries.get(key)?.clone(),
      }),
      keys: async () => [],
      delete: async () => {},
    },
    fetch: async req => {
      if (offline) throw Error('Offline');
      return worker.fetch(req);
    },
  };
  // Browser Request resolves relative URLs against the worker's origin.
  context.Request = class extends Request {
    constructor(url, init) {
      super(new URL(url, 'https://hyprland.test'), init);
    }
  };
  vm.runInNewContext(await (await request('/sw.js')).text(), context);
  let completion;
  handlers.install({
    waitUntil: promise => {
      completion = promise;
    },
  });
  await completion;
  offline = true;
  handlers.fetch({
    request: new Request('https://hyprland.test/'),
    respondWith: promise => {
      completion = promise;
    },
  });
  const response = await completion;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Hyprland Touch/);
});
test('worker preserves missing paths and rejects write requests', async () => {
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal(await (await request('/', 'HEAD')).text(), '');
  assert.equal((await request('/sw.js')).headers.get('service-worker-allowed'), '/');
});
