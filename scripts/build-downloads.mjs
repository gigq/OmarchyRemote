import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function serveBuildDownload(req, res, pathname) {
  if (pathname !== '/builds' && !pathname.startsWith('/builds/')) return false;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (pathname === '/builds') {
    res.writeHead(307, { ...headers, Location: '/builds/' });
    res.end();
    return true;
  }
  const relative = pathname.slice('/builds/'.length) || 'index.html';
  // Expose only generated download assets, never the publisher lock or arbitrary files.
  if (
    !/^(index\.html|catalog\.json|SKILL\.md|[a-f0-9]{64}\/(app\.ipa|app\.apk|manifest\.plist))$/.test(
      relative
    )
  ) {
    res.writeHead(404, headers);
    res.end('Not found');
    return true;
  }
  const directory =
    process.env.OMARCHY_BUILDS_DIR || path.join(homedir(), '.local/share/omarchy-remote/builds');
  let file, size;
  try {
    const base = await realpath(directory);
    file = await realpath(path.join(base, relative));
    const info = await stat(file);
    if (!file.startsWith(base + path.sep) || !info.isFile()) throw new Error('Invalid file');
    size = info.size;
  } catch {
    let body;
    let type;
    if (relative === 'index.html') {
      body = (
        await readFile(new URL('../deploy/builds-template.html', import.meta.url), 'utf8')
      ).replace(
        '<!-- BUILD_CARDS -->',
        await readFile(new URL('../deploy/builds-welcome.html', import.meta.url), 'utf8')
      );
      type = 'text/html; charset=utf-8';
    } else if (relative === 'catalog.json') {
      body = '[]';
      type = 'application/json';
    } else if (relative === 'SKILL.md') {
      body = await readFile(new URL('../skills/omarchy-builds/SKILL.md', import.meta.url));
      type = 'text/plain; charset=utf-8';
    }
    if (body !== undefined) {
      res.writeHead(200, { ...headers, 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    res.writeHead(404, headers);
    res.end('Build not available');
    return true;
  }
  const extension = path.extname(file);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json',
    '.md': 'text/plain; charset=utf-8',
    '.plist': 'application/xml',
    '.ipa': 'application/octet-stream',
    '.apk': 'application/vnd.android.package-archive',
  };
  res.writeHead(200, {
    ...headers,
    'Content-Type': types[extension],
    'Content-Length': size,
    ...(['.ipa', '.apk'].includes(extension)
      ? { 'Content-Disposition': `attachment; filename="OmarchyRemote${extension}"` }
      : {}),
    ...(extension === '.html'
      ? {
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        }
      : {}),
  });
  if (req.method === 'HEAD') res.end();
  else {
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  return true;
}
