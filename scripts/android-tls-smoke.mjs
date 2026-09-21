// Untrusted HTTPS fixture: never installs a CA or changes device certificate settings.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:https';
const run = promisify(execFile);
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(x => /^emulator-\d+\s+device$/.test(x.trim()))
  .map(x => x.split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run this fixture only on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
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
adb(
  'forward',
  'tcp:9225',
  `localabstract:webview_devtools_remote_${adb('shell', 'pidof', 'dev.omarchy.remote')}`
);
const shell = async expression =>
  JSON.parse((await run(process.execPath, ['scripts/android-cdp.mjs', expression])).stdout).result
    .value;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw Error('Android TLS condition timed out');
}
await until(() => shell('!!window.HyprlandDesk'));
assert.deepEqual(
  await shell('JSON.parse(localStorage.getItem("omarchy-layout-phone"))?.open || ["home"]'),
  ['home'],
  'Start with only Home open'
);
const original = await shell(
  'window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})'
);
assert.ok(original.selected && !original.disconnected && original.hosts.length < 10);
const dir = mkdtempSync(path.join(tmpdir(), 'android-tls-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(dir, 'key.pem'),
    '-out',
    path.join(dir, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ],
  { stdio: 'ignore' }
);
let requests = 0,
  connections = 0,
  rejected = 0;
const server = createServer(
  { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) },
  (_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<script>window.__UNTRUSTED_TLS_QA__=true</script><h1>Untrusted fixture</h1>');
  }
);
server.on('connection', () => connections++);
server.on('tlsClientError', () => rejected++);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const host = `https://127.0.0.1:${port}/native/`;
const connect = id =>
  shell(
    `void window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'connect', id })})`
  );
function ui() {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/tls-qa.xml');
  } catch (error) {
    if (!error.stdout?.includes('dumped to:')) throw error;
  }
  return adb('shell', 'cat', '/sdcard/tls-qa.xml');
}
function nativeNode(node) {
  assert.ok(node, 'Native host dialog control exists');
  const b = node
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .slice(1)
    .map(Number);
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round((b[0] + b[2]) / 2)),
    String(Math.round((b[1] + b[3]) / 2))
  );
}

try {
  await shell('void HyprlandHosts.manage()');
  await until(() => shell('location.pathname.endsWith("/hosts.html") && !!window.HyprlandHosts'));
  await shell(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='Add a host').click();true"
  );
  await until(() => ui().includes('text="Add host"'));
  let fields = ui()
    .match(/<node\b[^>]*>/g)
    .filter(n => n.includes('class="android.widget.EditText"'));
  assert.equal(fields.length, 2);
  nativeNode(fields[0]);
  adb('shell', 'input', 'text', 'Untrusted%sTLS%sQA');
  fields = ui()
    .match(/<node\b[^>]*>/g)
    .filter(n => n.includes('class="android.widget.EditText"'));
  nativeNode(fields[1]);
  adb('shell', 'input', 'text', host);
  nativeNode(
    ui()
      .match(/<node\b[^>]*>/g)
      .find(n => n.includes('text="SAVE"') || n.includes('text="Save"'))
  );
  await until(() =>
    shell(
      "[...document.querySelectorAll('.host-connect')].some(b=>b.textContent.includes('Untrusted TLS QA'))"
    )
  );
  await shell(
    "[...document.querySelectorAll('.host-connect')].find(b=>b.textContent.includes('Untrusted TLS QA')).click();true"
  );
  await until(() =>
    shell(
      `location.href===${JSON.stringify(host)} && window.__OMARCHY_BUNDLED__===true && [...document.querySelectorAll('.home-app-grid')].some(n=>n.checkVisibility())`
    )
  );
  await until(() => connections > 0 && rejected > 0);
  assert.equal(
    await shell("fetch('/api/qa-probe',{cache:'no-store'}).then(()=>false,()=>true)"),
    true,
    'An explicit API request must reject the certificate'
  );
  assert.equal(requests, 0, 'The untrusted server must never receive an HTTP request');
  assert.equal(await shell('window.__UNTRUSTED_TLS_QA__===true'), false);
  // A native retry must also refuse the certificate, while bundled UI stays usable.
  const initialConnections = connections;
  await until(() => connections > initialConnections);
  assert.equal(requests, 0, 'Automatic retries must not bypass certificate validation');
  await shell(
    "HyprlandUtil.storage.set('omarchy-tls-qa','offline');void HyprlandHosts.disconnect()"
  );
  await until(() =>
    shell('location.pathname.endsWith("/hosts.html") && !!document.querySelector(".host-connect")')
  );
  assert.equal(
    (await shell('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})'))
      .disconnected,
    true
  );
  await connect(host);
  await until(() => shell('window.__OMARCHY_BUNDLED__===true && !!window.HyprlandUtil'));
  assert.equal(await shell("localStorage.getItem('omarchy-tls-qa')"), 'offline');
  assert.equal(requests, 0);
  console.log(
    'PASS: native Add host dialog and saved row, invalid certificate rejected for page/API/retries; bundled shell, host picker and scoped offline preferences remain usable'
  );
} finally {
  try {
    await connect(original.selected);
    await until(() =>
      shell(`location.href===${JSON.stringify(original.selected)} && !!window.HyprlandDesk`)
    );
    await shell(
      `window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'remove', id: host })})`
    );
    assert.equal(await shell("localStorage.getItem('omarchy-tls-qa')"), null);
  } finally {
    adb('reverse', '--remove', `tcp:${port}`);
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}
