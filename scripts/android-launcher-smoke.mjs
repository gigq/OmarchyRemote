// Regression smoke test for Android shell focus when the launcher opens.
// It uses only the current device's local shell state and leaves host/catalog data untouched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Use an emulator for the Android launcher smoke test');

const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function dimensions() {
  const size = adb('shell', 'wm', 'size').match(/(\d+x\d+)/)?.[1];
  const density = adb('shell', 'wm', 'density').match(/(\d+)$/)?.[1];
  return { size, density };
}

async function until(label, check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    await sleep(100);
  }
  throw Error(`${label} timed out${error ? `: ${error.message}` : ''}`);
}

let socket;
let sequence = 0;

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(Error('Android shell CDP evaluation timed out'));
    }, 10000);
    function receive(data) {
      const reply = JSON.parse(data);
      if (reply.id !== id) return;
      clearTimeout(timer);
      socket.off('message', receive);
      if (reply.error || reply.result?.exceptionDetails) reject(Error(JSON.stringify(reply)));
      else resolve(reply.result?.result?.value);
    }
    socket.on('message', receive);
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      })
    );
  });
}

async function connectShell() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await (await fetch('http://127.0.0.1:9225/json/list')).json();
    const target = targets.find(target => target.url.includes('/native/'));
    if (target) {
      const candidate = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        candidate.once('open', resolve);
        candidate.once('error', reject);
      });
      socket = candidate;
      try {
        if (await evaluate('!!document.querySelector("#touch-shell") && !!window.HyprlandDesk'))
          return;
      } catch {
        socket.close();
        socket = null;
      }
      if (socket) {
        socket.close();
        socket = null;
      }
    }
    await sleep(100);
  }
  throw Error('Android shell WebView did not become ready');
}

const state = () =>
  evaluate(`(() => {
    const active = document.activeElement;
    const layout = JSON.parse(localStorage.getItem('omarchy-layout-phone') || 'null');
    return {
      value: document.querySelector('.dashboard-search')?.value || '',
      active: active?.getAttribute('aria-label') || active?.tagName || '',
      nativeFocus: document.hasFocus(),
      launch: document.querySelector('.shell-overlay')?.style.visibility || '',
      open: layout?.open || [],
      visibleWorkspaces: [...document.querySelectorAll('[data-workspace]')]
        .filter(element => getComputedStyle(element).opacity !== '0')
        .map(element => element.dataset.workspace),
    };
  })()`);

const dimensionsBefore = dimensions();
assert.equal(dimensionsBefore.size, '1080x2400', 'The launcher smoke test requires phone geometry');
assert.equal(dimensionsBefore.density, '420', 'The launcher smoke test requires phone density');

async function dismissWithLauncherButton() {
  const button = await evaluate(`(() => {
    const element = document.querySelector('#dashboard-launcher .launcher-search-line > .keycap');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      scale: window.devicePixelRatio || 1,
    };
  })()`);
  assert.ok(button, 'The visible launcher Escape button must be present for cleanup');
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round(button.x * button.scale)),
    String(Math.round(button.y * button.scale))
  );
  await until('launcher button dismissal', async () => (await state()).launch === 'hidden');
}

let previousViewport;

async function waitForDashboard() {
  return until('dashboard launcher readiness', async () => {
    const current = await evaluate(`(() => {
      const field = document.querySelector('.dashboard-search');
      const rect = field?.getBoundingClientRect();
      const viewport = window.visualViewport;
      return {
        field: !!field,
        handlers: !!field?.oninput && !!field?.onkeydown,
        width: window.innerWidth,
        height: window.innerHeight,
        visualWidth: viewport?.width || 0,
        visualHeight: viewport?.height || 0,
        fieldWidth: rect?.width || 0,
        fieldHeight: rect?.height || 0,
      };
    })()`);
    const stable = previousViewport && JSON.stringify(previousViewport) === JSON.stringify(current);
    previousViewport = current;
    return stable && current.field && current.handlers && current.fieldWidth > 0 ? current : false;
  });
}

try {
  adb('shell', 'am', 'force-stop', 'dev.omarchy.remote');
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
  const pid = adb('shell', 'pidof', 'dev.omarchy.remote');
  assert.match(pid, /^\d+$/, 'The debug Android app did not start');
  try {
    adb('forward', '--remove', 'tcp:9225');
  } catch {}
  adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
  await connectShell();
  const dashboard = await waitForDashboard();
  console.log(`Dashboard ready: ${JSON.stringify(dashboard)}`);
  const initial = await state();
  assert.deepEqual(initial.open, ['home'], 'Start with only Home open');
  assert.equal(initial.launch, 'hidden', 'Start with the launcher closed');

  await evaluate(`(() => {
    window.__androidLauncherTrace = [];
    const describe = element =>
      element?.getAttribute?.('aria-label') || element?.id || element?.tagName || '';
    const record = (kind, eventName, event) =>
      window.__androidLauncherTrace.push({
        t: Math.round(performance.now() * 10) / 10,
        kind,
        event: eventName || '',
        target: describe(event?.target),
        active: describe(document.activeElement),
        nativeFocus: document.hasFocus(),
        launch: document.querySelector('.shell-overlay')?.style.visibility || '',
    });
    for (const event of ['focus', 'focusin', 'focusout', 'blur', 'keydown'])
      document.addEventListener(event, value => record('event', event, value), true);
    record('installed', '', document.activeElement);
    return true;
  })()`);

  // A real Android gesture followed immediately by text is the regression trigger.
  adb('shell', 'input', 'swipe', '540', '100', '540', '800', '500');
  adb('shell', 'input', 'text', 'settings');
  let swipe;
  try {
    swipe = await until('topbar swipe search input', async () => {
      const current = await state();
      return current.value === 'settings' ? current : false;
    });
  } catch (error) {
    const failureState = await state();
    const failureTrace = await evaluate('window.__androidLauncherTrace.slice(-20)');
    console.error(
      JSON.stringify({
        failure: error.message,
        state: failureState,
        trace: failureTrace,
      })
    );
    throw error;
  }
  assert.equal(swipe.active, 'Search apps, panes and files');
  assert.equal(swipe.nativeFocus, true, 'The WebView must retain native focus after the swipe');
  assert.equal(swipe.launch, 'visible');
  assert.deepEqual(swipe.open, ['home']);
  assert.deepEqual(swipe.visibleWorkspaces, ['home']);

  const traceBeforeEscape = await evaluate('window.__androidLauncherTrace.length');
  adb('shell', 'input', 'keyevent', 'KEYCODE_ESCAPE');
  await until('Escape launcher dismissal', async () => {
    const current = await state();
    return current.launch === 'hidden' ? current : false;
  });
  const escapeTrace = await evaluate(`window.__androidLauncherTrace.slice(${traceBeforeEscape})`);
  assert.equal(
    escapeTrace.filter(
      event => event.event === 'keydown' && event.target === 'Search apps, panes and files'
    ).length,
    1,
    'Escape must deliver one DOM keydown to the focused launcher field'
  );

  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_K');
  await until('Ctrl+Alt+K launcher open', async () => {
    const current = await state();
    return current.launch === 'visible' ? current : false;
  });
  adb('shell', 'input', 'text', 'settings');
  const chord = await until('Ctrl+Alt+K search input', async () => {
    const current = await state();
    return current.value === 'settings' ? current : false;
  });
  assert.equal(chord.active, 'Search apps, panes and files');
  assert.equal(chord.nativeFocus, true);
  assert.deepEqual(chord.open, ['home']);

  await dismissWithLauncherButton();
  const restored = await state();
  assert.deepEqual(restored.open, ['home']);
  assert.deepEqual(restored.visibleWorkspaces, ['home']);
  const trace = await evaluate('window.__androidLauncherTrace');
  assert.ok(trace.some(event => event.event === 'focusin'));
  console.log(
    'PASS: Android launcher swipe and Ctrl+Alt+K retain native search focus, accept immediate text, dismiss with Escape, and restore Home-only state'
  );
} finally {
  try {
    if (socket) {
      await evaluate('window.HyprlandDesk?.nativeBack(); document.activeElement?.blur?.(); true');
      await sleep(300);
    }
  } catch {}
  if (socket) socket.close();
  try {
    adb('forward', '--remove', 'tcp:9225');
  } catch {}
}
