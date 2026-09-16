import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
const base = process.env.REMOTE_TEST_URL || 'http://127.0.0.1:4187';
async function api(path, body) {
  const r = await fetch(base + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  assert.equal(r.status, 200, JSON.stringify(value));
  return value;
}
function herdr(method, params) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(
      process.env.OMARCHY_HERDR_SOCKET || `${process.env.HOME}/.config/herdr/herdr.sock`
    );
    s.setTimeout(8000);
    let buffer = '';
    s.on('connect', () =>
      s.write(JSON.stringify({ id: 'omarchy-integration-test', method, params }) + '\n')
    );
    s.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        s.end();
        const r = JSON.parse(buffer.split('\n')[0]);
        r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result);
      }
    });
    s.on('error', reject);
    s.on('timeout', () => {
      s.destroy();
      reject(Error('Herdr timeout'));
    });
  });
}
async function connect(path) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/' + path, { origin: base });
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    messages,
    send: v => ws.send(JSON.stringify(v)),
    wait: async predicate => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise(r => setTimeout(r, 30));
      }
      throw Error('WebSocket message timeout');
    },
  };
}

test('host gateway rejects cross-site requests and unknown hosts', async () => {
  assert.equal((await fetch(base + '/api/capabilities')).status, 403);
  assert.equal(
    (
      await fetch(base + '/api/capabilities', {
        headers: { 'X-Hyprland-Client': '1', Origin: 'https://attacker.invalid' },
      })
    ).status,
    403
  );
  assert.equal(
    await new Promise(resolve =>
      http.get(
        base + '/api/capabilities',
        { headers: { 'X-Hyprland-Client': '1', Host: 'attacker.invalid' } },
        r => {
          r.resume();
          resolve(r.statusCode);
        }
      )
    ),
    403
  );
  const status = await new Promise(resolve => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/herdr/ws', {
      origin: 'https://attacker.invalid',
    });
    ws.on('unexpected-response', (_, r) => {
      resolve(r.statusCode);
      r.resume();
      ws.terminate();
    });
    ws.on('error', () => {});
  });
  assert.equal(status, 403);
  assert.equal((await api('capabilities')).apps.length, 9);
});

test('persistent real shell accepts input, resizes, and reconnects', async () => {
  const session = await api('terminal/session', {});
  let c = await connect(`terminal/${session.id}/ws`);
  try {
    await c.wait(m => m.type === 'screen');
    c.send({ type: 'resize', cols: 60, rows: 20 });
    // Wait until interactive shell initialization has finished before submitting.
    await new Promise(r => setTimeout(r, 700));
    c.send({ type: 'input', data: "printf '\\nMOBILE_REAL_SHELL\\n'; stty size\r" });
    await c.wait(() =>
      c.messages
        .filter(m => m.type === 'output')
        .map(m => Buffer.from(m.data).toString())
        .join('')
        .includes('20 60')
    );
    c.ws.close();
    c = await connect(`terminal/${session.id}/ws`);
    const screen = await c.wait(m => m.type === 'screen');
    assert.ok(Buffer.from(screen.data).toString().includes('MOBILE_REAL_SHELL'));
    assert.equal(screen.cols, 60);
    assert.equal(screen.rows, 20);
    assert.equal((await api('terminal/session', { id: session.id })).resumed, true);
    c.send({ type: 'input', data: 'exit\r' });
    await c.wait(m => m.type === 'exit');
    assert.equal((await api(`terminal/${session.id}/close`, {})).closed, true);
  } finally {
    c.ws.close();
  }
});

test('real Herdr snapshot, selected pane output, literal input and Return', async () => {
  let workspace;
  try {
    const created = await herdr('workspace.create', {
      label: 'Omarchy automated test',
      cwd: '/tmp',
      focus: false,
    });
    workspace = created.workspace?.workspace_id || created.workspace_id;
    assert.ok(workspace, JSON.stringify(created));
    const snap = await api('herdr/snapshot');
    const pane = snap.panes.find(p => p.workspace_id === workspace);
    assert.ok(pane);
    const c = await connect('herdr/ws');
    try {
      await c.wait(m => m.type === 'snapshot');
      c.send({ type: 'select', pane_id: pane.pane_id });
      await c.wait(m => m.type === 'pane');
      c.send({
        type: 'input',
        id: 'test-input',
        pane_id: pane.pane_id,
        text: "printf 'HERDR_MOBILE_%s\\n' OK",
        keys: ['Enter'],
      });
      await c.wait(m => m.type === 'ack' && m.id === 'test-input');
      await c.wait(m => m.type === 'pane' && m.read.text.includes('HERDR_MOBILE_OK'));
      const read = await api('herdr/panes/' + encodeURIComponent(pane.pane_id));
      assert.ok(read.text.includes('HERDR_MOBILE_OK'));
      c.send({ type: 'select', pane_id: null });
      c.send({
        type: 'input',
        id: 'wrong-pane',
        pane_id: pane.pane_id,
        text: 'DO_NOT_SEND',
        keys: [],
      });
      await c.wait(m => m.type === 'input_error' && m.id === 'wrong-pane');
    } finally {
      c.ws.close();
    }
  } finally {
    if (workspace) await herdr('workspace.close', { workspace_id: workspace });
  }
});

test('closing an app-owned shell ends it without affecting another session', async () => {
  const first = await api('terminal/session', {}),
    second = await api('terminal/session', {});
  const a = await connect(`terminal/${first.id}/ws`),
    b = await connect(`terminal/${second.id}/ws`);
  try {
    await a.wait(m => m.type === 'screen');
    await b.wait(m => m.type === 'screen');
    assert.equal((await api(`terminal/${first.id}/close`, {})).closed, true);
    await a.wait(m => m.type === 'exit');
    assert.equal((await api('terminal/session', { id: second.id })).resumed, true);
    assert.equal((await api(`terminal/${first.id}/close`, {})).closed, true);
  } finally {
    await api(`terminal/${first.id}/close`, {});
    await api(`terminal/${second.id}/close`, {});
    a.ws.close();
    b.ws.close();
  }
});

test('home widgets expose live host metrics and sanitized CodexBar windows', async () => {
  const d = await api('widgets');
  assert.ok(d.metrics.memory_total > 0);
  assert.ok(d.metrics.cores > 0);
  assert.ok(d.metrics.updated_at > 0);
  assert.ok(d.codexbar.providers.length === 2);
  for (const p of d.codexbar.providers) {
    assert.ok(['codex', 'claude'].includes(p.id));
    assert.equal(p.accountEmail, undefined);
    assert.equal(p.identity, undefined);
    for (const w of p.windows) assert.ok(w.used_percent >= 0 && w.used_percent <= 100);
  }
});

test('uploads keep bytes and names privately, classify images, and reject empty or oversized files', async () => {
  const { readFile, stat, unlink } = await import('node:fs/promises');
  const uploads = process.env.HOME + '/.local/share/omarchy-remote/uploads/';
  const upload = (body, name, route = 'files') =>
    fetch(
      base +
        '/api/uploads/' +
        route +
        (name === undefined ? '' : '?name=' + encodeURIComponent(name)),
      {
        method: 'POST',
        headers: { 'X-Hyprland-Client': '1', 'Content-Type': 'application/octet-stream' },
        body,
      }
    );
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(65536, 42)]);
  const zip = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(4096, 7)]);
  const stored = [];
  try {
    for (const [body, name, route, kind, pattern] of [
      [png, 'photo.png', 'files', 'image', '[a-f0-9-]+-photo\\.png'],
      [png, undefined, 'images', 'image', 'image-[a-f0-9-]+\\.png'],
      [zip, '../../etc/passwd/../bundle (1).zip', 'files', 'file', '[a-f0-9-]+-bundle _1_\\.zip'],
      [zip, '///', 'files', 'file', 'file-[a-f0-9-]+'],
    ]) {
      const response = await upload(body, name, route);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      stored.push(result.path);
      assert.equal(result.kind, kind);
      assert.match(result.path, new RegExp('^' + uploads + pattern + '$'));
      assert.deepEqual(await readFile(result.path), body);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    }
  } finally {
    for (const path of stored) await unlink(path).catch(() => {});
  }
  assert.equal((await upload(Buffer.alloc(0), 'empty.zip')).status, 400);
  assert.equal((await upload(Buffer.alloc(100 * 1024 * 1024 + 1), 'big.bin')).status, 413);
  assert.equal(
    (await fetch(base + '/api/uploads/files?name=x.zip', { method: 'POST', body: zip })).status,
    403
  );
});

test('Files browses, uploads, previews and creates folders without overwriting', async () => {
  const { mkdtemp, rm, writeFile, symlink, readFile } = await import('node:fs/promises');
  const folder = await mkdtemp(process.env.HOME + '/omarchy-files-test-');
  const request = (route, params, options = {}) =>
    fetch(base + '/api/' + route + '?' + new URLSearchParams(params), {
      ...options,
      headers: { 'X-Hyprland-Client': '1' },
    });
  try {
    await writeFile(folder + '/.hidden', 'hidden');
    await symlink('/etc', folder + '/outside');
    const bytes = Buffer.from('A real phone upload\n<script>plain text</script>\n');
    let r = await request(
      'files/upload',
      { path: folder, name: 'hello.txt' },
      { method: 'POST', body: bytes }
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await readFile(folder + '/hello.txt'), bytes);
    r = await request(
      'files/upload',
      { path: folder, name: 'hello.txt' },
      { method: 'POST', body: 'replacement' }
    );
    assert.equal(r.status, 400);
    assert.deepEqual(await readFile(folder + '/hello.txt'), bytes);
    r = await request(
      'files/upload',
      { path: folder, name: '../escape' },
      { method: 'POST', body: 'bad' }
    );
    assert.equal(r.status, 400);
    r = await request('files/content', { path: folder + '/outside/passwd' });
    assert.equal(r.status, 400);
    r = await request('files', { path: folder });
    let listing = await r.json();
    assert.deepEqual(
      listing.entries.map(e => e.name),
      ['hello.txt']
    );
    r = await request('files', { path: folder, hidden: true });
    listing = await r.json();
    assert.equal(listing.entries.length, 2);
    await api('files/folders', { path: folder, name: 'Phone photos' });
    r = await request('files', { path: folder });
    listing = await r.json();
    assert.equal(listing.entries[0].name, 'Phone photos');
    assert.equal(listing.entries[0].directory, true);
    r = await request('files/content', { path: folder + '/hello.txt' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await r.text(), bytes.toString());
    r = await request(
      'files/upload',
      { path: folder, name: 'too-big' },
      { method: 'POST', body: Buffer.alloc(25 * 1024 * 1024 + 1) }
    );
    assert.equal(r.status, 413);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

for (const [app, marker] of [
  ['btop', 'CPU'],
  ['services', 'Units'],
  ['lazydocker', 'Containers'],
  ['dua', 'mark-move'],
  ['lnav', '\x1b[>c'],
])
  // lnav starts after `ready` and probes the terminal (Secondary DA) before drawing
  test(`${app} launches separately with reconnect and isolated close`, async () => {
    const shell = await api('terminal/session', {}),
      monitor = await api('terminal/session', { app });
    const c = await connect(`terminal/${monitor.id}/ws`);
    try {
      await c.wait(m => m.type === 'screen');
      c.send({ type: 'ready' });
      await c.wait(() =>
        c.messages
          .filter(m => m.type === 'screen' || m.type === 'output')
          .map(m => Buffer.from(m.data).toString())
          .join('')
          .includes(marker)
      );
      assert.equal((await api('terminal/session', { app, id: monitor.id })).resumed, true);
      const wrong = await fetch(base + '/api/terminal/session', {
        method: 'POST',
        headers: { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: monitor.id }),
      });
      assert.equal(wrong.status, 400);
      await api(`terminal/${monitor.id}/close`, {});
      await c.wait(m => m.type === 'exit');
      assert.equal((await api('terminal/session', { id: shell.id })).resumed, true);
    } finally {
      c.ws.close();
      await api(`terminal/${monitor.id}/close`, {});
      await api(`terminal/${shell.id}/close`, {});
    }
  });

test('Files Trash is recoverable and contains the selected fixture bytes', async () => {
  const { mkdtemp, writeFile, readFile, rm, readdir } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const folder = await mkdtemp(process.env.HOME + '/omarchy-trash-test-');
  const name = basename(folder) + '.txt';
  const trash = (process.env.XDG_DATA_HOME || process.env.HOME + '/.local/share') + '/Trash';
  try {
    await writeFile(folder + '/' + name, 'recoverable fixture');
    const result = await api('files/operate', { action: 'trash', paths: [folder + '/' + name] });
    assert.equal(result.completed.length, 1);
    assert.deepEqual(result.errors, []);
    const infos = (await readdir(trash + '/info')).filter(
      n => n.startsWith(name) && n.endsWith('.trashinfo')
    );
    assert.equal(infos.length, 1);
    const info = infos[0];
    assert.match(await readFile(trash + '/info/' + info, 'utf8'), /\[Trash Info\]/);
    assert.equal(
      await readFile(trash + '/files/' + info.slice(0, -10), 'utf8'),
      'recoverable fixture'
    );
  } finally {
    // Remove only this uniquely named QA item, never empty the user's Trash.
    for (const info of (await readdir(trash + '/info').catch(() => [])).filter(
      n => n.startsWith(name) && n.endsWith('.trashinfo')
    )) {
      await rm(trash + '/files/' + info.slice(0, -10), { force: true });
      await rm(trash + '/info/' + info, { force: true });
    }
    await rm(folder, { recursive: true, force: true });
  }
});
