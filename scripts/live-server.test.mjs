import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import vm from 'node:vm';

const base = process.env.HYPRLAND_TEST_URL || 'http://127.0.0.1:4187';
test('live server serves native assets without caching and confines file reads', async () => {
  const response = await fetch(base + '/native/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /class="native-shell"/);
  assert.match(html, /__HYPRLAND_DEV__ = true/);
  assert.match(html, /__HYPRLAND_VERSION__/);
  for (const match of html.matchAll(/(?:src|href)="([^"{}]+)"/g)) {
    const resource = await fetch(new URL(match[1], base + '/native/'));
    assert.equal(resource.status, 200, match[1]);
  }
  for (const url of [
    '/native/..%2f..%2fREADME.md',
    '/.git/config',
    '/native/%00',
    '/missing',
    '/native/sw.js',
  ]) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
  assert.equal((await fetch(base + '/native/%ZZ')).status, 400);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test(
  'a saved source file emits a reload event and the native copy updates',
  { timeout: 10000 },
  async () => {
    const controller = new AbortController();
    const file = `public/__live_probe_${process.pid}.txt`;
    let created = false;
    try {
      const response = await fetch(base + '/__dev/events', { signal: controller.signal });
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      async function nextVersion() {
        while (true) {
          const match = buffered.match(/event: version\ndata: ([^\n]+)\n\n/);
          if (match) {
            buffered = buffered.slice(match.index + match[0].length);
            return match[1];
          }
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffered += decoder.decode(value, { stream: true });
        }
      }
      const before = await nextVersion();
      await writeFile(file, 'live reload probe', { flag: 'wx' });
      created = true;
      const after = await nextVersion();
      assert.notEqual(after, before);
      assert.equal(
        await (await fetch(base + '/native/' + file.slice('public/'.length))).text(),
        'live reload probe'
      );
      await unlink(file);
      created = false;
      await nextVersion();
      assert.equal((await fetch(base + '/native/' + file.slice('public/'.length))).status, 404);
    } finally {
      controller.abort();
      if (created) await unlink(file);
    }
  }
);

test('client reloads on new versions, reconnects, and foreground updates', async () => {
  const source = await readFile(new URL('./live-reload.js', import.meta.url), 'utf8');
  let events, foreground, count;
  function createContext() {
    count = 0;
    return {
      window: { __HYPRLAND_VERSION__: '1' },
      location: {
        reload() {
          count++;
        },
      },
      EventSource: class {
        constructor(url) {
          assert.equal(url, '/__dev/events');
        }
        addEventListener(name, callback) {
          events = callback;
        }
      },
      document: {
        visibilityState: 'visible',
        addEventListener(name, callback) {
          foreground = callback;
        },
      },
      fetch: async () => ({ ok: true, json: async () => ({ version: '2' }) }),
    };
  }
  vm.runInNewContext(source, createContext());
  events({ data: '1' });
  assert.equal(count, 0);
  events({ data: '2' });
  events({ data: '3' });
  assert.equal(count, 1);
  vm.runInNewContext(source, createContext());
  await foreground();
  assert.equal(count, 1);
  // A restarted server delivers a new version on the first/reconnected event.
  vm.runInNewContext(source, createContext());
  events({ data: 'restarted' });
  assert.equal(count, 1);
});
