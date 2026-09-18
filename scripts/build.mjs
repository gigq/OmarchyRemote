import { readdir, readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name)))
  );
  return nested.flat().sort();
}
const files = await walk('public');
const assets = {};
const hash = createHash('sha256');
for (const file of files) {
  const bytes = await readFile(file);
  hash.update(file).update(bytes);
  assets['/' + path.relative('public', file)] = {
    body: bytes.toString('base64'),
    type: types[path.extname(file)] || 'application/octet-stream',
  };
}
const version = hash.digest('hex').slice(0, 16);
const sw = `const CACHE = 'omarchy-remote-${version}';
const URLS = ${JSON.stringify(['/', ...Object.keys(assets)])};
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of URLS) {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok || response.redirected) throw new Error('Cannot cache ' + url);
      await cache.put(url, response);
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('omarchy-remote-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !URLS.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(url.pathname)) || fetch(event.request);
  })());
});
`;
assets['/sw.js'] = { body: Buffer.from(sw).toString('base64'), type: types['.js'] };
// Bundle this small static prototype into a portable Worker: no server runtime or asset binding needed.
const worker = `const assets = ${JSON.stringify(assets)};
export default {
  async fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const pathname = new URL(request.url).pathname;
    const asset = assets[pathname === '/' ? '/index.html' : pathname];
    if (!asset) return new Response('Not found', { status: 404 });
    const headers = { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.body), c => c.charCodeAt(0));
    return new Response(body, { headers });
  }
};
`;
await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await cp('public', 'dist/client', { recursive: true });
await writeFile('dist/client/sw.js', sw);
await writeFile('dist/server/index.js', worker);
console.log(`Built ${files.length + 1} assets; offline cache ${version}.`);
