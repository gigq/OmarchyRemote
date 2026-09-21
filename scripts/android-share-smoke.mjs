// Shares only a generated fixture with an opt-in, local-only Android receiver APK.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(x => /^emulator-\d+\s+device$/.test(x.trim()))
  .map(x => x.split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'This fixture runs only on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
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
const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], { encoding: 'utf8' })
  ).result.value;
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw Error('Android share condition timed out');
}
function ui() {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/files-qa.xml');
  } catch (e) {
    if (!e.stdout?.includes('dumped to:')) throw e;
  }
  return adb('shell', 'cat', '/sdcard/files-qa.xml');
}
function native(match, long = false) {
  const node = ui()
    .match(/<node\b[^>]*>/g)
    ?.find(match);
  assert.ok(node, 'Native picker control exists');
  const b = node
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .slice(1)
    .map(Number);
  const x = String(Math.round((b[0] + b[2]) / 2)),
    y = String(Math.round((b[1] + b[3]) / 2));
  if (long) adb('shell', 'input', 'swipe', x, y, x, y, '800');
  else adb('shell', 'input', 'tap', x, y);
}
await until(() => evaluate('!!window.HyprlandDesk'));
assert.deepEqual(
  evaluate('JSON.parse(localStorage.getItem("omarchy-layout-phone"))?.open || ["home"]'),
  ['home'],
  'Start with only Home open'
);
const receiver = 'dev.omarchy.qa.share';
const receiverAPK = 'android/qa-share-receiver/build/outputs/apk/debug/qa-share-receiver-debug.apk';
assert.equal(
  adb('shell', 'pm', 'list', 'packages', receiver),
  '',
  'The test receiver must not already be installed'
);
adb('install', receiverAPK);
const filename = 'android-share-' + Date.now() + '.txt';
const line = 'Android private share fixture\n';
const payload = line.repeat(20000);
try {
  evaluate(
    `window.androidShareResult=null;navigator.share({files:[new File([${JSON.stringify(line)}.repeat(20000)],${JSON.stringify(filename)},{type:'text/plain'})]}).then(()=>window.androidShareResult='handed-off',e=>window.androidShareResult=e.name);true`
  );
  await until(() => ui().includes('Save to device'));
  native(n => n.includes('text="Share…"'));
  await until(() => ui().includes('com.android.intentresolver'));
  const size = adb('shell', 'wm', 'size')
    .match(/(?:Override|Physical) size: (\d+)x(\d+)\s*$/)
    .slice(1)
    .map(Number);
  adb(
    'shell',
    'input',
    'swipe',
    String(Math.round(size[0] / 2)),
    String(Math.round(size[1] * 0.58)),
    String(Math.round(size[0] / 2)),
    String(Math.round(size[1] * 0.18)),
    '400'
  );
  await until(() => ui().includes('Omarchy QA Receiver'));
  native(n => n.includes('text="Omarchy QA Receiver"'));
  await until(
    () =>
      adb(
        'shell',
        'run-as',
        receiver,
        'sh',
        '-c',
        "'if test -f files/report.json; then echo ready; fi'"
      ) === 'ready'
  );
  const report = JSON.parse(adb('shell', 'run-as', receiver, 'cat', 'files/report.json'));
  assert.deepEqual(report, {
    name: filename,
    type: 'text/plain',
    scheme: 'content',
    writeDenied: true,
  });
  const digest = adb('shell', 'run-as', receiver, 'sha256sum', 'files/received.bin').split(
    /\s+/
  )[0];
  assert.equal(
    digest,
    createHash('sha256').update(payload).digest('hex'),
    'The receiving app reads the exact shared bytes'
  );
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until(() => evaluate('window.androidShareResult==="handed-off"'));
  evaluate(
    `window.androidShareResult=null;navigator.share({files:[new File(['cancelled'],'cancel.txt',{type:'text/plain'})]}).then(()=>window.androidShareResult='unexpected',e=>window.androidShareResult=e.name);true`
  );
  await until(() => ui().includes('Save to device'));
  native(n => n.includes('text="CANCEL"') || n.includes('text="Cancel"'));
  await until(() => evaluate('window.androidShareResult==="AbortError"'));
  console.log(
    'PASS: native share sheet to isolated receiver, exact bytes/name/MIME, read-only URI grant and cancellation'
  );
} catch (error) {
  writeFileSync(
    'artifacts/android/share-failure.png',
    execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      maxBuffer: 16 * 1024 * 1024,
    })
  );
  console.error(ui());
  throw error;
} finally {
  adb('uninstall', receiver);
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
  // Remove only this fixture's retained share; other user shares remain intact.
  adb(
    'shell',
    'run-as',
    'dev.omarchy.remote',
    'sh',
    '-c',
    `'find cache/shares -name ${filename} -delete'`
  );
}
