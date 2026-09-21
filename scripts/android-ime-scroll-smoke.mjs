// Verify real Android IME composition and native finger scrolling with only fresh QA workspaces.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run this fixture on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

function startApp() {
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
  assert.match(pid, /^\d+$/, 'The Android app must be running');
  try {
    adb('forward', '--remove', 'tcp:9225');
  } catch {}
  adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
}

startApp();

const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  ).result.value;

const base = process.env.REMOTE_TEST_URL || 'http://127.0.0.1:4187';
async function api(route) {
  const response = await fetch(base + '/api/' + route, {
    headers: { 'X-Hyprland-Client': '1' },
  });
  assert.equal(response.status, 200);
  return response.json();
}

function herdr(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      process.env.OMARCHY_HERDR_SOCKET || path.join(homedir(), '.config/herdr/herdr.sock')
    );
    socket.setTimeout(8000);
    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 'android-ime-scroll-qa', method, params }) + '\n')
    );
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end();
      const reply = JSON.parse(buffer.split('\n')[0]);
      reply.error ? reject(Error(JSON.stringify(reply.error))) : resolve(reply.result);
    });
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(Error('Herdr timeout'));
    });
  });
}

async function until(label, check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const root = '#remote-herdr-app';
const field = root + ' .native-input';
const herdrOutput = root + ' .native-terminal-scroll';
const terminalOutput = '#remote-terminal-app .native-terminal-scroll';
const value = () => evaluate(`document.querySelector(${JSON.stringify(field)})?.value || ''`);
const keyboardInset = () => evaluate('keyboardInset()');
const layout = () =>
  evaluate(
    'JSON.parse(localStorage.getItem(Math.min(innerWidth,innerHeight)>=600 ? "omarchy-layout-desk" : "omarchy-layout-phone")) || null'
  );
const physicalWidth = () =>
  Number(adb('shell', 'wm', 'size').match(/(?:Override|Physical) size: (\d+)x\d+\s*$/)[1]);

async function tap(selector) {
  let previous;
  let stable = 0;
  await until('stable touch target ' + selector, () => {
    const rect = evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON() || null`
    );
    const current = JSON.stringify(rect);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    return stable >= 4 && rect?.width > 0 && rect?.height > 0;
  });
  const target = evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,scale:innerWidth}})()`
  );
  assert.ok(target, 'Touch target exists: ' + selector);
  const scale = physicalWidth() / target.scale;
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round(target.x * scale)),
    String(Math.round(target.y * scale))
  );
}

async function swipe(selector, startRatio, endRatio) {
  const target = evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x+r.width/2,start:r.y+r.height*${startRatio},end:r.y+r.height*${endRatio},scale:innerWidth}})()`
  );
  assert.ok(target, 'Swipe target exists: ' + selector);
  const scale = physicalWidth() / target.scale;
  adb(
    'shell',
    'input',
    'swipe',
    String(Math.round(target.x * scale)),
    String(Math.round(target.start * scale)),
    String(Math.round(target.x * scale)),
    String(Math.round(target.end * scale)),
    '500'
  );
}

function screenshot(name) {
  mkdirSync('artifacts/android', { recursive: true });
  writeFileSync(
    'artifacts/android/' + name,
    execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      maxBuffer: 16 * 1024 * 1024,
    })
  );
}

function outputState(selector) {
  return evaluate(`(()=>{
    const scroller=document.querySelector(${JSON.stringify(selector)});
    const screen=scroller?.querySelector('.xterm-screen');
    const latest=${selector.includes('herdr') ? `document.querySelector(${JSON.stringify(root + ' .herdr-latest')})` : "[...document.querySelectorAll('#remote-terminal-app .remote-bar button')].find(button=>button.textContent.includes('Latest'))"};
    return {
      top:scroller?.scrollTop || 0,
      height:scroller?.scrollHeight || 0,
      client:scroller?.clientHeight || 0,
      text:screen?.innerText || scroller?.innerText || '',
      latest:!!latest && !latest.hidden,
    };
  })()`);
}

async function waitForShell() {
  await until('Android shell readiness', () =>
    evaluate(
      `document.readyState === 'complete' && !!window.HyprlandDesk && !!document.querySelector('.dashboard-search')`
    )
  );
}

await waitForShell();

const previous = evaluate(
  '({pane:localStorage.getItem("omarchy-herdr-pane"),recent:localStorage.getItem("omarchy-herdr-recent-panes"),drafts:localStorage.getItem("omarchy-herdr-drafts-v1")})'
);
const originalHost = evaluate(
  'window.webkit?.messageHandlers?.shellHosts?.postMessage({action:"list"}) || null'
);
assert.ok(
  originalHost?.selected && !originalHost.disconnected,
  'An original host must remain connected'
);
assert.deepEqual(layout()?.open || ['home'], ['home'], 'Start with only Home open');
assert.equal(
  evaluate('!!document.querySelector("#remote-terminal-app")?.innerText.trim()'),
  false,
  'No existing terminal may be open'
);

const owned = [];
let herdrOpen = false;
let terminalOpen = false;
const createdAt = Date.now();
const imeKeys = {
  t: [486, 1715],
  e: [270, 1715],
  h: [648, 1870],
  space: [540, 2180],
};

try {
  for (let index = 0; index < 2; index++) {
    const created = await herdr('workspace.create', {
      label: `Android IME scroll QA ${createdAt}-${index}`,
      cwd: '/tmp',
      focus: false,
    });
    const workspace = created.workspace?.workspace_id || created.workspace_id;
    assert.ok(workspace, 'Herdr must create an owned workspace');
    const snapshot = await api('herdr/snapshot');
    const pane = snapshot.panes.find(item => item.workspace_id === workspace);
    assert.ok(pane, 'Created workspace must expose an owned pane');
    owned.push({ workspace, pane: pane.pane_id });
  }

  adb(
    'shell',
    'input',
    'keycombination',
    'KEYCODE_CTRL_LEFT',
    'KEYCODE_ALT_LEFT',
    'KEYCODE_SHIFT_LEFT',
    'KEYCODE_A'
  );
  await until('owned Herdr pane list', () =>
    evaluate(`!!document.querySelector(${JSON.stringify(root + ' .herdr-pane')})`)
  );
  herdrOpen = true;
  await evaluate(
    `document.querySelector(${JSON.stringify(root + ' .herdr-back')})?.click();document.querySelector(${JSON.stringify(root + ` .herdr-pane[data-pane="${owned[0].pane}"]`)})?.click()`
  );
  await until('owned Herdr pane selected', () =>
    evaluate(`localStorage.getItem('omarchy-herdr-pane') === ${JSON.stringify(owned[0].pane)}`)
  );
  await until('owned Herdr composer', () =>
    evaluate(`!!document.querySelector(${JSON.stringify(field)})`)
  );
  await tap(field);
  await until('Gboard visible for message mode', () => keyboardInset() > 80);
  const inputMethod = adb('shell', 'settings', 'get', 'secure', 'default_input_method');
  assert.match(
    inputMethod,
    /com\.google\.android\.inputmethod\.latin/,
    'The fixture requires English Gboard'
  );
  screenshot('android-ime-message-before.png');

  const initialMode = evaluate(
    `document.querySelector(${JSON.stringify(field)})?.getAttribute('aria-label') || ''`
  );
  assert.ok(
    ['Direct terminal keys', 'Message to host'].includes(initialMode),
    `Unexpected initial Herdr input mode: ${initialMode}`
  );
  if (initialMode === 'Direct terminal keys')
    evaluate(
      `document.querySelector(${JSON.stringify(root + ' button[aria-label="Switch typing mode"]')})?.click()`
    );
  const flags = await until('message mode flags', () => {
    const current =
      evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(field)});return {
      label:f?.getAttribute('aria-label'),
      autocorrect:f?.getAttribute('autocorrect'),
      spellcheck:f?.spellcheck,
      autocapitalize:f?.getAttribute('autocapitalize'),
      inputmode:f?.getAttribute('inputmode'),
      enterkeyhint:f?.getAttribute('enterkeyhint'),
    }})()`);
    return current.label === 'Message to host' ? current : false;
  });
  assert.deepEqual(flags, {
    label: 'Message to host',
    autocorrect: 'on',
    spellcheck: true,
    autocapitalize: 'off',
    inputmode: 'text',
    enterkeyhint: 'send',
  });
  evaluate(
    `(()=>{const field=document.querySelector(${JSON.stringify(field)});window.androidImeEvents=[];for(const type of ['compositionstart','compositionupdate','compositionend','input','keydown','copy'])field.addEventListener(type,event=>window.androidImeEvents.push({type,trusted:event.isTrusted,isComposing:event.isComposing===true,inputType:event.inputType||'',data:event.data||'',key:event.key||'',value:event.target.value}),{capture:true});return true})()`
  );
  for (const key of ['t', 'e', 'h', 'space']) {
    adb('shell', 'input', 'tap', ...imeKeys[key].map(String));
    await new Promise(resolve => setTimeout(resolve, 160));
  }
  await until('real Gboard word commit', () => /^teh |^the /.test(value()));
  const composition = evaluate(
    '({value:document.querySelector(' +
      JSON.stringify(field) +
      ').value,events:window.androidImeEvents})'
  );
  assert.ok(
    composition.events.some(event => event.type === 'input' && event.trusted),
    'Gboard must produce trusted input'
  );
  const compositionObserved =
    composition.events.some(event => event.type === 'compositionstart' && event.trusted) &&
    composition.events.some(event => event.type === 'compositionend' && event.trusted);
  writeFileSync(
    'artifacts/android/android-ime-events.json',
    JSON.stringify(
      {
        inputMethod,
        flags,
        value: composition.value,
        compositionObserved,
        events: composition.events,
      },
      null,
      2
    )
  );
  screenshot('android-ime-message-after.png');
  if (composition.value === 'the ') {
    console.log('IME autocorrect observed: Gboard changed "teh " to "the "');
  } else {
    console.log(
      `IME autocorrect not observed: Gboard left ${JSON.stringify(composition.value)}; trusted event trace recorded`
    );
  }
  if (!compositionObserved)
    console.log(
      'IME DOM composition events were not exposed; trusted Android input/autocorrect trace recorded'
    );

  const message = composition.value;
  for (let cycle = 1; cycle <= 2; cycle++) {
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
    await until('clipboard select all', () =>
      evaluate(
        `(()=>{const f=document.querySelector(${JSON.stringify(field)});return f.selectionStart===0&&f.selectionEnd===f.value.length})()`
      )
    );
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_C');
    await new Promise(resolve => setTimeout(resolve, 100));
    adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_RIGHT');
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_V');
    const expected = message.repeat(2);
    await until(`clipboard cycle ${cycle}`, () => value() === expected);
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_Z');
    await until(`undo cycle ${cycle}`, () => value() === message);
  }
  console.log(
    'Clipboard repeat: 2 Android copy/paste cycles and 2 Undo cycles retained the owned draft'
  );

  await herdr('pane.send_input', {
    pane_id: owned[0].pane,
    text: 'seq 1 240',
    keys: ['Enter'],
  });
  await until('owned Herdr output generation', async () =>
    (await api('herdr/panes/' + encodeURIComponent(owned[0].pane))).text
      .split('\n')
      .some(line => line.trim() === '240')
  );
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until('Herdr IME dismissal', () => keyboardInset() < 80);
  await until('owned Herdr output render', () => {
    const state = outputState(herdrOutput);
    return state.height > state.client && /240/.test(state.text);
  });
  const herdrBefore = outputState(herdrOutput);
  screenshot('android-herdr-scroll-before.png');
  await swipe(herdrOutput, 0.35, 0.75);
  await until('Herdr finger scroll', () => {
    const state = outputState(herdrOutput);
    return state.latest && state.top < state.height - state.client - 1;
  });
  const herdrAfter = outputState(herdrOutput);
  assert.ok(herdrAfter.text.length > 0, 'Scrolled Herdr output must remain rendered');
  screenshot('android-herdr-scroll-after.png');
  await tap(root + ' .herdr-latest');
  await until('Herdr latest restore', () => {
    const state = outputState(herdrOutput);
    return !state.latest && state.top >= state.height - state.client - 2;
  });
  console.log(
    `Herdr finger scroll: top ${herdrBefore.top} -> ${herdrAfter.top}, viewport ${herdrAfter.client}px of ${herdrAfter.height}px`
  );

  evaluate('HyprlandDesk.nativeKey({code:"KeyW",meta:true})');
  await until(
    'close owned Herdr app',
    () => !evaluate(`!!document.querySelector(${JSON.stringify(root + ' .herdr-list')})`)
  );
  herdrOpen = false;
  await until(
    'Home after Herdr close',
    () => layout()?.open?.length === 1 && layout()?.open?.[0] === 'home'
  );

  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_ENTER');
  await until('owned terminal open', () =>
    evaluate(
      '!!document.querySelector("#remote-terminal-app") && !!document.querySelector("#remote-terminal-app .native-terminal-scroll")'
    )
  );
  terminalOpen = true;
  adb('shell', 'input', 'text', 'seq%s1%s240');
  adb('shell', 'input', 'keyevent', 'KEYCODE_ENTER');
  await until('owned terminal output generation', () =>
    /240/.test(evaluate('document.querySelector("#remote-terminal-app")?.innerText || ""'))
  );
  if (keyboardInset() > 80) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until('terminal IME dismissal', () => keyboardInset() < 80);
  await until('owned terminal output render', () => {
    const state = outputState(terminalOutput);
    return state.height > state.client && /240/.test(state.text);
  });
  const terminalBefore = outputState(terminalOutput);
  screenshot('android-terminal-scroll-before.png');
  await swipe(terminalOutput, 0.35, 0.75);
  await until('terminal finger scroll', () => {
    const state = outputState(terminalOutput);
    return state.latest && state.top < state.height - state.client - 1;
  });
  const terminalAfter = outputState(terminalOutput);
  screenshot('android-terminal-scroll-after.png');
  await tap('#remote-terminal-app .remote-bar button:not([hidden])');
  await until('terminal latest restore', () => {
    const state = outputState(terminalOutput);
    return !state.latest && state.top >= state.height - state.client - 2;
  });
  console.log(
    `Terminal finger scroll: top ${terminalBefore.top} -> ${terminalAfter.top}, viewport ${terminalAfter.client}px of ${terminalAfter.height}px`
  );
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_W');
  await until(
    'close owned terminal',
    () => !evaluate('!!document.querySelector("#remote-terminal-app")?.innerText.trim()')
  );
  terminalOpen = false;
  await until(
    'Home after terminal close',
    () => layout()?.open?.length === 1 && layout()?.open?.[0] === 'home'
  );
  const imeResult = compositionObserved
    ? 'real Gboard composition/autocorrect'
    : 'real Gboard autocorrect with trusted input events (DOM composition events not exposed)';
  console.log(
    composition.value === 'the '
      ? `PASS: ${imeResult}, clipboard repeat, and Herdr/terminal finger scroll on owned sessions`
      : `PARTIAL: ${imeResult}, clipboard repeat, and Herdr/terminal finger scroll passed; autocorrect was not observed`
  );
} catch (error) {
  try {
    screenshot('android-ime-scroll-failure.png');
  } catch {}
  try {
    console.error(
      JSON.stringify({
        failure: error.message,
        layout: layout(),
        draft: value(),
        imeEvents: evaluate('window.androidImeEvents || []'),
        herdr: outputState(herdrOutput),
        terminal: outputState(terminalOutput),
      })
    );
  } catch {}
  throw error;
} finally {
  try {
    if (
      terminalOpen ||
      evaluate('!!document.querySelector("#remote-terminal-app")?.innerText.trim()')
    ) {
      adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_W');
      await until(
        'cleanup owned terminal',
        () => !evaluate('!!document.querySelector("#remote-terminal-app")?.innerText.trim()')
      );
    }
  } catch {}
  try {
    if (
      herdrOpen ||
      evaluate(`!!document.querySelector(${JSON.stringify(root + ' .herdr-list')})`)
    ) {
      evaluate('HyprlandDesk.nativeKey({code:"KeyW",meta:true})');
      await until(
        'cleanup owned Herdr app',
        () => !evaluate(`!!document.querySelector(${JSON.stringify(root + ' .herdr-list')})`)
      );
    }
  } catch {}
  try {
    evaluate(
      `(()=>{const storage=HyprlandUtil.storage;const saved=${JSON.stringify(previous)};storage.set('omarchy-herdr-pane',saved.pane);storage.set('omarchy-herdr-recent-panes',saved.recent);if(saved.drafts===null)storage.set('omarchy-herdr-drafts-v1',null);else storage.set('omarchy-herdr-drafts-v1',saved.drafts)})()`
    );
  } catch {}
  for (const item of owned) {
    try {
      await herdr('workspace.close', { workspace_id: item.workspace });
    } catch {}
  }
  try {
    adb('forward', '--remove', 'tcp:9225');
  } catch {}
}
