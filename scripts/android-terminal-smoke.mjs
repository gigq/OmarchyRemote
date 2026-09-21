// Exercises rapid launch typing in an installed debug APK. Only new QA-owned shells are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.ok(serial, 'Set ANDROID_SERIAL when there is not exactly one running emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const pid = adb('shell', 'pidof', 'dev.omarchy.remote');
assert.match(pid, /^\d+$/);
adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], { encoding: 'utf8' })
  ).result.value;
const text = () =>
  evaluate('document.querySelector("#remote-terminal-app")?.innerText.trim() || ""');
async function until(check) {
  const limit = Date.now() + 10000;
  while (Date.now() < limit) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Terminal did not reach expected state: ' + text().slice(0, 100));
}
assert.equal(text(), '', 'Close any existing emulator Terminal before running this test');
for (let round = 0; round < 3; round++) {
  try {
    adb(
      'shell',
      `input keycombination KEYCODE_CTRL_LEFT KEYCODE_ALT_LEFT KEYCODE_ENTER; input text quickstart${round}`
    );
    await until(() => text().includes(`quickstart${round}`));
    adb(
      'shell',
      'input keycombination KEYCODE_CTRL_LEFT KEYCODE_ALT_LEFT KEYCODE_ENTER; input text again'
    );
    await until(() => text().includes(`quickstart${round}again`));
  } finally {
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_W');
    await until(() => text() === '');
  }
}
console.log(
  'PASS: three immediate launch/type cycles and already-active typing; all QA shells closed without executing typed text'
);
