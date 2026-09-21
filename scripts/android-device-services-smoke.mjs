// Verify Android's native battery and locale services through the shell bridge.
// The fixture changes only emulator battery simulation and the app locale override, then restores both.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run this fixture only on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

function startApp() {
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

startApp();

function evaluate(expression) {
  return JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  ).result.value;
}

const bridge = (channel, body) =>
  evaluate(`window.webkit.messageHandlers.${channel}.postMessage(${JSON.stringify(body)})`);

async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw Error(message);
}

function restartApp() {
  adb('shell', 'am', 'force-stop', 'dev.omarchy.remote');
  startApp();
}

async function waitForShell() {
  await until(
    () => evaluate('document.readyState === "complete" && !!window.HyprlandDesk'),
    'Android shell did not reload'
  );
}

function parseLocaleTags(output) {
  const list = output.match(/\[([^\]]*)\]/);
  assert.ok(list, 'LocaleManager must return a bracketed locale list');
  return list[1]
    .split(/[\s,]+/)
    .map(tag => tag.trim().replaceAll('_', '-'))
    .filter(tag => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(tag));
}

const appPackage = 'dev.omarchy.remote';

function appLocales() {
  return parseLocaleTags(
    adb('shell', 'cmd', 'locale', 'get-app-locales', appPackage, '--user', '0')
  );
}

function setLocales(tags) {
  // Android LocaleManager app override API; an empty value clears the override.
  adb(
    'shell',
    'cmd',
    'locale',
    'set-app-locales',
    appPackage,
    '--user',
    '0',
    '--locales',
    tags.join(',')
  );
}

const originalLocaleTags = appLocales();
const originalBattery = adb('shell', 'dumpsys', 'battery');
assert.match(originalBattery, /level:/, 'Could not read the emulator battery state');
const originalHosts = bridge('shellHosts', { action: 'list' });
assert.ok(
  originalHosts.selected && !originalHosts.disconnected,
  'The fixture needs a connected host'
);

async function assertShellRestored() {
  await waitForShell();
  const hosts = bridge('shellHosts', { action: 'list' });
  assert.equal(hosts.selected, originalHosts.selected, 'The original host must remain selected');
  assert.equal(hosts.disconnected, false, 'The original host must remain connected');
  assert.deepEqual(
    evaluate(
      'JSON.parse(localStorage.getItem(Math.min(innerWidth,innerHeight)>=600 ? "omarchy-layout-desk" : "omarchy-layout-phone"))?.open || ["home"]'
    ),
    ['home'],
    'The fixture must leave only Home open'
  );
}

function batteryState() {
  return evaluate('window.__HYPRLAND_BATTERY__ || null');
}

function batteryLabel() {
  return evaluate(
    '([...document.querySelectorAll("#touch-shell [data-device-battery]")].at(-1)?.getAttribute("aria-label") || null)'
  );
}

function setBattery(level, status) {
  adb('shell', 'dumpsys', 'battery', 'unplug');
  adb('shell', 'dumpsys', 'battery', 'set', 'level', String(level));
  adb('shell', 'dumpsys', 'battery', 'set', 'status', String(status));
}

async function assertBattery(level, state, label) {
  await until(() => {
    const battery = batteryState();
    return battery?.percent === level && battery.state === state && batteryLabel() === label;
  }, `Battery did not publish ${label}`);
}

function assertLocale(response, base, unit, extension) {
  assert.equal(response.unit, unit, `${base}: native temperature unit`);
  assert.equal(typeof response.locale, 'string', `${base}: native locale tag`);
  assert.ok(response.locale.toLowerCase().startsWith(base.toLowerCase()), `${base}: locale tag`);
  if (extension)
    assert.match(
      response.locale.toLowerCase(),
      new RegExp(`-u(?:-[a-z0-9]+)*-mu-${extension}`),
      `${base}: Unicode temperature override`
    );
}

let localeRestored = false;
try {
  await assertShellRestored();
  assert.ok(
    evaluate('document.querySelectorAll("#touch-shell [data-device-battery]").length') > 0,
    'Home must expose a native battery label'
  );

  setBattery(37, 3);
  await assertBattery(37, 'unplugged', 'Battery: 37%');
  setBattery(82, 2);
  await assertBattery(82, 'charging', 'Battery: 82%, charging');
  setBattery(100, 5);
  await assertBattery(100, 'full', 'Battery: 100%, fully charged');

  const localeCases = [
    ['en-US', 'en-US', 'f'],
    ['en-GB', 'en-GB', 'c'],
    ['en-US-u-mu-celsius', 'en-US', 'c', 'celsius'],
    ['en-GB-u-mu-fahrenhe', 'en-GB', 'f', 'fahrenhe'],
  ];
  for (const [tag, base, unit, extension] of localeCases) {
    setLocales([tag]);
    restartApp();
    await assertShellRestored();
    assertLocale(bridge('weatherDevice', { action: 'locale' }), base, unit, extension);
  }

  setLocales(originalLocaleTags);
  restartApp();
  await assertShellRestored();
  assert.deepEqual(
    appLocales(),
    originalLocaleTags,
    'The exact original app locale override must be restored'
  );
  const restored = bridge('weatherDevice', { action: 'locale' });
  if (originalLocaleTags.length > 0) {
    assert.ok(
      originalLocaleTags.some(
        tag => restored.locale === tag || restored.locale.startsWith(tag + '-')
      ),
      'The exact original locale family must be restored'
    );
  }
  localeRestored = true;
  console.log(
    'PASS: native battery levels/charging, Home labels, locale regions and Unicode temperature overrides'
  );
} finally {
  try {
    if (!localeRestored) {
      setLocales(originalLocaleTags);
      restartApp();
      await assertShellRestored();
    }
  } finally {
    adb('shell', 'dumpsys', 'battery', 'reset');
  }
}
