import http from 'node:http';
import { watch, readFileSync, existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const nativeRoot = path.join(root, 'ios/Generated/Web');
const clients = new Set();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let version = `${Date.now()}`;
let refreshTimer;
function prepareNative() {
  execFileSync(process.env.PYTHON || 'python3', [path.join(root, 'scripts/prepare-native.py')], { cwd: root, stdio: 'pipe' });
}
prepareNative();
function sendVersion(client) { client.write(`event: version\ndata: ${version}\n\n`); }
function changed() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    try {
      prepareNative();
      version = `${Date.now()}`;
      for (const client of clients) sendVersion(client);
      console.log(`Reload ${version}: ${clients.size} connected preview(s)`);
    } catch (error) { console.error('Native preparation failed; preserving current previews:', error.message); }
  }, 180);
}
const watchers = [publicRoot, path.join(root, 'ios/WebOverrides')].map(dir => watch(dir, { recursive: true }, changed));
watchers.push(watch(path.join(root, 'scripts/prepare-native.py'), changed));
const liveScript = readFileSync(path.join(root, 'scripts/live-reload.js'), 'utf8');

const server = http.createServer(async (req, res) => {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__dev/events' && req.method === 'GET') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      sendVersion(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      res.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }
    if (url.pathname === '/__dev/status') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'hyprland-touch-dev', version, clients: clients.size })); return;
    }
    if (url.pathname === '/__dev/live-reload.js') {
      res.writeHead(200, { ...headers, 'Content-Type': types['.js'] }); res.end(req.method === 'HEAD' ? undefined : liveScript); return;
    }
    if (url.pathname === '/native') { res.writeHead(307, { ...headers, Location: '/native/' }); res.end(); return; }
    const native = url.pathname.startsWith('/native/');
    const base = native ? nativeRoot : publicRoot;
    let relative = decodeURIComponent(native ? url.pathname.slice('/native/'.length) : url.pathname.slice(1));
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    if (relative.includes('\0') || relative.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) {
      res.writeHead(404, headers); res.end('Not found'); return;
    }
    const requested = path.resolve(base, relative);
    if (!requested.startsWith(base + path.sep) || !existsSync(requested)) { res.writeHead(404, headers); res.end('Not found'); return; }
    const actual = await realpath(requested);
    if (!actual.startsWith(base + path.sep) || !(await stat(actual)).isFile()) { res.writeHead(404, headers); res.end('Not found'); return; }
    const documentVersion = version;
    let body = await readFile(actual);
    if (path.extname(actual) === '.html') {
      // Include the document version so edits made before SSE connects still reload.
      body = Buffer.from(body.toString().replace('</head>', `<script>window.__HYPRLAND_DEV__ = true; window.__HYPRLAND_VERSION__ = ${JSON.stringify(documentVersion)};</script><script src="/__dev/live-reload.js" defer></script></head>`));
    }
    res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(actual)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.writeHead(error instanceof URIError ? 400 : 500, headers);
    res.end(error instanceof URIError ? 'Invalid path' : 'Could not load preview');
  }
});
const port = Number(process.env.PORT || 4187);
server.listen(port, '127.0.0.1', () => console.log(`Hyprland live preview: http://127.0.0.1:${port}/native/`));
function shutdown() { for (const watcher of watchers) watcher.close(); clearTimeout(refreshTimer); for (const client of clients) client.end(); server.close(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
