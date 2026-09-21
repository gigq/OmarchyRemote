// Uses a temporary host and a signed APK for the installed debug app. Confirms a real update.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run installation QA on an emulator only');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
function forward() {
  const pid = adb('shell', 'pidof', 'dev.omarchy.remote');
  assert.match(pid, /^\d+$/);
  adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
}
forward();
const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], { encoding: 'utf8' })
  ).result.value;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error('Android update condition did not become true');
}
const xml = () => {
  adb('shell', 'uiautomator', 'dump', '/sdcard/update-qa.xml');
  return adb('shell', 'cat', '/sdcard/update-qa.xml');
};
function tapNode(match) {
  const node = xml()
    .match(/<node\b[^>]*>/g)
    ?.find(match);
  assert.ok(node, 'Expected Android control exists');
  const bounds = node
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .slice(1)
    .map(Number);
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round((bounds[0] + bounds[2]) / 2)),
    String(Math.round((bounds[1] + bounds[3]) / 2))
  );
}
const apk = readFileSync(
  process.env.ANDROID_UPDATE_APK || 'android/app/build/outputs/apk/debug/app-debug.apk'
);
const hash = createHash('sha256').update(apk).digest('hex');
const server = createServer((req, res) => {
  if (req.url.startsWith('/builds/')) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.end(apk);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><title>Update QA host</title><h1>Update QA</h1>'
    );
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const host = `http://127.0.0.1:${port}/native/`;
const original = evaluate('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})');
assert.ok(original.selected && !original.disconnected, 'Start connected to a host');
const hosts = body =>
  evaluate(`window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify(body)})`);
function connect(id) {
  evaluate(
    `void window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'connect', id })})`
  );
}
const install = async id => {
  const expression = `window.webkit.messageHandlers.shellInstallBuild.postMessage({build:${JSON.stringify(id)}}).catch(error=>({error:error.message}))`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    'scripts/android-cdp.mjs',
    expression,
  ]);
  return JSON.parse(stdout).result.value;
};
try {
  hosts({ action: 'save', name: 'Android update QA', url: host });
  connect(host);
  await until(() => evaluate('location.href') === host);
  assert.match((await install('../bad')).error, /Invalid build identity/);
  assert.match((await install('0'.repeat(64))).error, /checksum mismatch/);
  let result = await install(hash);
  if (result.permissionRequired) {
    await until(() => xml().includes('Allow from this source'));
    // Denying permission must leave the installed app untouched and remain retryable.
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    assert.equal((await install(hash)).permissionRequired, true);
    tapNode(node => node.includes('checkable="true"') && node.includes('clickable="true"'));
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    result = await install(hash);
  }
  assert.equal(result.opened, true, JSON.stringify(result));
  await until(() => /text="(Update|Install)"/.test(xml()));
  tapNode(node => node.includes('text="Cancel"'));
  assert.equal((await install(hash)).opened, true);
  await until(() => /text="(Update|Install)"/.test(xml()));
  const before = adb('shell', 'dumpsys', 'package', 'dev.omarchy.remote').match(
    /lastUpdateTime=(.*)/
  )?.[1];
  tapNode(node => /text="(Update|Install)"/.test(node));
  await until(
    () =>
      adb('shell', 'dumpsys', 'package', 'dev.omarchy.remote').match(/lastUpdateTime=(.*)/)?.[1] !==
      before
  );
  await until(() => xml().includes('App installed.'));
  adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-f',
    '0x10200000',
    '-n',
    'dev.omarchy.remote/.ShellActivity'
  );
  await until(() => {
    try {
      forward();
      return evaluate('location.href') === host;
    } catch {
      return false;
    }
  });
  const installedPath = adb('shell', 'pm', 'path', 'dev.omarchy.remote').replace(/^package:/, '');
  assert.equal(adb('shell', 'sha256sum', installedPath).split(/\s+/)[0], hash);
  console.log(
    'PASS: invalid identity/checksum rejection, permission retry, installer cancellation, confirmed APK update and retained host (permission retry when required)'
  );
} finally {
  try {
    adb(
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-f',
      '0x10200000',
      '-n',
      'dev.omarchy.remote/.ShellActivity'
    );
    await until(() => {
      try {
        forward();
        return true;
      } catch {
        return false;
      }
    });
    await until(() => {
      if (evaluate('location.href') === original.selected) return true;
      connect(original.selected);
      return false;
    });
    hosts({ action: 'remove', id: host });
  } finally {
    adb('reverse', '--remove', `tcp:${port}`);
    server.closeAllConnections();
    server.close();
  }
}
