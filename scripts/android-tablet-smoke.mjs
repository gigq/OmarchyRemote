// Exercises a tablet-sized Android debug APK. Only new QA-owned windows and shells are used.
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
assert.ok(
  evaluate('Math.min(innerWidth,innerHeight)>=600'),
  'Use a tablet-sized emulator viewport'
);
const layout = () => evaluate('JSON.parse(localStorage.getItem("omarchy-layout-desk"))');
assert.deepEqual(layout()?.open || ['home'], ['home'], 'Close existing tablet workspaces first');
const chord = (...keys) =>
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', ...keys);
try {
  chord('KEYCODE_ENTER');
  await until(() => text().includes('❯'));
  chord('KEYCODE_SHIFT_LEFT', 'KEYCODE_F');
  await until(() => layout().focus === 'files');
  chord('KEYCODE_SHIFT_LEFT', 'KEYCODE_2');
  await until(() => layout().tiles.terminal === layout().tiles.files);
  const divider = evaluate(
    'document.querySelector(".desk-divider").getBoundingClientRect().toJSON()'
  );
  const x = Math.round(divider.x + divider.width / 2),
    y = Math.round(divider.y + divider.height / 2);
  adb('shell', 'input', 'swipe', String(x), String(y), String(x + 100), String(y), '400');
  await until(() =>
    Object.values(layout().splits || {}).some(value => Math.abs(value - 0.5) > 0.04)
  );
  for (let round = 0; round < 3; round++) {
    adb(
      'shell',
      `input keycombination KEYCODE_CTRL_LEFT KEYCODE_ALT_LEFT KEYCODE_J; input text tilefocus${round}`
    );
    await until(() => text().includes(`tilefocus${round}`));
    chord('KEYCODE_J');
    await until(() => layout().focus === 'files');
  }
  chord('KEYCODE_J');
  await until(() => layout().focus === 'terminal');
  chord('KEYCODE_1');
  await until(() => layout().ws === 0);
  adb(
    'shell',
    'input keycombination KEYCODE_CTRL_LEFT KEYCODE_ALT_LEFT KEYCODE_2; input text workspacefocus'
  );
  await until(() => text().includes('workspacefocus'));
  console.log(
    'PASS: Android tablet tiling, divider drag, three immediate focus/type cycles, and immediate typing after workspace switch'
  );
} finally {
  for (let count = 0; count < 2; count++) {
    if ((layout()?.open || []).length <= 1) break;
    const before = layout().open.length;
    chord('KEYCODE_W');
    await until(() => layout().open.length < before);
  }
}
