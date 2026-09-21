// Verify the native host switch saves the departing scoped snapshot before replacing the shell.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run this fixture only on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

function launch() {
  adb(
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-f',
    '0x10200000',
    '-n',
    'dev.omarchy.remote/.ShellActivity'
  );
  const pid = adb('shell', 'pidof', 'dev.omarchy.remote').split(/\s+/)[0];
  assert.match(pid, /^\d+$/, 'The Android app must be running');
  adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
}

launch();

const shell = async expression =>
  JSON.parse((await run(process.execPath, ['scripts/android-cdp.mjs', expression])).stdout).result
    .value;

async function until(check, message) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error(message);
}

const settleNativeState = () => new Promise(resolve => setTimeout(resolve, 1000));

function bridge(channel, body) {
  return shell(`window.webkit.messageHandlers.${channel}.postMessage(${JSON.stringify(body)})`);
}

function proxyServer() {
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/__dev/')) {
        response.writeHead(404);
        response.end();
        return;
      }
      // The host-state fixture only needs the shell document and assets. Blocking
      // APIs keeps all temporary-host activity away from the production backend.
      if (request.url.startsWith('/api/')) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Isolated host-state fixture' }));
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405);
        response.end();
        return;
      }
      const upstream = await fetch(`http://127.0.0.1:4187${request.url}`, {
        method: request.method,
      });
      response.writeHead(upstream.status, {
        'Cache-Control': 'no-store',
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502);
      response.end('Fixture unavailable');
    }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function forceRestart() {
  adb('shell', 'am', 'force-stop', 'dev.omarchy.remote');
  launch();
}

const original = await bridge('shellHosts', { action: 'list' });
assert.ok(original.selected && !original.disconnected, 'The fixture needs a connected host');
assert.ok(original.hosts.length <= 8, 'The fixture needs two free saved-host slots');

const serverA = proxyServer();
const serverB = proxyServer();
const portA = await listen(serverA);
const portB = await listen(serverB);
const hostA = `http://127.0.0.1:${portA}/native/`;
const hostB = `http://127.0.0.1:${portB}/native/`;
const key = `omarchy-android-host-state-${process.pid}`;
let savedA = false;
let savedB = false;

async function connect(id) {
  await bridge('shellHosts', { action: 'connect', id });
  await until(
    () => shell(`location.href===${JSON.stringify(id)} && !!window.HyprlandDesk`),
    `Timed out loading ${id}`
  );
}

async function snapshotValue() {
  return shell(`window.__OMARCHY_DEVICE__?.snapshot?.[${JSON.stringify(key)}] ?? null`);
}

try {
  adb('reverse', `tcp:${portA}`, `tcp:${portA}`);
  adb('reverse', `tcp:${portB}`, `tcp:${portB}`);
  await bridge('shellHosts', { action: 'save', name: 'Android host state QA A', url: hostA });
  savedA = true;
  await bridge('shellHosts', { action: 'save', name: 'Android host state QA B', url: hostB });
  savedB = true;

  await connect(hostA);
  // This marker exists only in the switch payload. A delayed page mirror cannot make
  // the test pass because the A page has no matching localStorage value.
  await bridge('shellHosts', {
    action: 'connect',
    id: hostB,
    scope: hostA,
    values: { [key]: 'from-a' },
  });
  await until(
    () => shell(`location.href===${JSON.stringify(hostB)} && !!window.HyprlandDesk`),
    'Timed out switching from host A to host B'
  );

  // Persist B, then submit a deliberately wrong scope. Android must ignore the latter.
  await shell(`localStorage.setItem(${JSON.stringify(key)}, 'from-b'); true`);
  await bridge('shellStorage', { scope: hostB, values: { [key]: 'from-b' } });
  await settleNativeState();
  await bridge('shellStorage', { scope: hostA, values: { [key]: 'wrong-scope' } });
  await bridge('shellHosts', {
    action: 'list',
    scope: hostA,
    values: { [key]: 'wrong-scope' },
  });
  forceRestart();
  await until(
    () => shell(`location.href===${JSON.stringify(hostB)} && !!window.HyprlandDesk`),
    'Timed out restoring host B after process death'
  );
  assert.equal(await snapshotValue(), 'from-b', 'A wrong-scope snapshot must not overwrite host B');

  // This second switch checks the departing snapshot path after a real process restart.
  await bridge('shellHosts', {
    action: 'connect',
    id: hostA,
    scope: hostB,
    values: { [key]: 'from-b' },
  });
  await until(
    () => shell(`location.href===${JSON.stringify(hostA)} && !!window.HyprlandDesk`),
    'Timed out switching back to host A'
  );
  assert.equal(await snapshotValue(), 'from-a', 'Host A snapshot must survive an immediate switch');
  // The switch assertion above is isolated to the hosts payload. Seed the page mirror
  // only after that assertion so the following restart checks ordinary persistence.
  await shell(`localStorage.setItem(${JSON.stringify(key)}, 'from-a'); true`);
  await bridge('shellStorage', { scope: hostA, values: { [key]: 'from-a' } });
  await settleNativeState();
  forceRestart();
  await until(
    () => shell(`location.href===${JSON.stringify(hostA)} && !!window.HyprlandDesk`),
    'Timed out restoring host A after process death'
  );
  assert.equal(await snapshotValue(), 'from-a', 'Host A snapshot must survive process death');
  console.log('PASS: immediate host-switch snapshots and scope isolation survive process death');
} finally {
  try {
    // Clear only the fixture key and scoped state before deleting the temporary hosts.
    for (const [id, saved] of [
      [hostA, savedA],
      [hostB, savedB],
    ]) {
      if (!saved) continue;
      try {
        await connect(id);
        await shell(`localStorage.removeItem(${JSON.stringify(key)}); true`);
        await bridge('shellStorage', { scope: id, values: {} });
      } catch {}
    }
    await connect(original.selected);
    for (const [id, saved] of [
      [hostA, savedA],
      [hostB, savedB],
    ]) {
      if (saved) await bridge('shellHosts', { action: 'remove', id });
    }
    assert.equal(
      (await bridge('shellHosts', { action: 'list' })).selected,
      original.selected,
      'The original host must be restored'
    );
  } finally {
    adb('reverse', '--remove', `tcp:${portA}`);
    adb('reverse', '--remove', `tcp:${portB}`);
    serverA.closeAllConnections();
    serverB.closeAllConnections();
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve)),
    ]);
  }
}
