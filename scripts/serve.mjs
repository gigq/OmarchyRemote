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
const apiPort = Number(process.env.OMARCHY_API_PORT || 4188);
const proxyToken = process.env.OMARCHY_PROXY_TOKEN;
const allowedHosts = new Set((process.env.OMARCHY_ORIGINS || 'http://127.0.0.1:4187,http://localhost:4187').split(',').map(origin => new URL(origin).host));
function apiHeaders(req) {
  const headers = { ...req.headers, 'x-omarchy-proxy': proxyToken };
  delete headers['transfer-encoding'];
  return headers;
}
function proxyApi(req, res) {
  if (!proxyToken || !allowedHosts.has(req.headers.host)) { res.writeHead(403); res.end('Host not allowed'); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: apiHeaders(req) }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'Host backend unavailable' })); });
  upstream.setTimeout(10000, () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
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
    if (req.url.startsWith('/api/')) { proxyApi(req, res); return; }
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
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/') || !proxyToken || !allowedHosts.has(req.headers.host)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: req.url, headers: apiHeaders(req) });
  upstream.on('upgrade', (response, peer, peerHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
    if (head.length) peer.write(head);
    if (peerHead.length) socket.write(peerHead);
    peer.pipe(socket); socket.pipe(peer);
    peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
    peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy());
  });
  upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.end();
});
const port = Number(process.env.PORT || 4187);
server.listen(port, '127.0.0.1', () => console.log(`Hyprland live preview: http://127.0.0.1:${port}/native/`));
function shutdown() { for (const watcher of watchers) watcher.close(); clearTimeout(refreshTimer); for (const client of clients) client.end(); server.close(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
