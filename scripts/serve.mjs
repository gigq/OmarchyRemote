import http from 'node:http';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
const { default: worker } = await import('../dist/server/index.js');
const port = Number(process.env.PORT || 4187);
http.createServer(async (req, res) => {
  try {
    const response = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Server error'); }
}).listen(port, '0.0.0.0', () => console.log(`Local: http://localhost:${port}`));
