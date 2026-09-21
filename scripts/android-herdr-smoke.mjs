// Uses only newly created Herdr workspaces. Never sends input to existing agent panes.
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Run this fixture on an emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
function forward() {
  const pid = adb('shell', 'pidof', 'dev.omarchy.remote');
  assert.match(pid, /^\d+$/);
  adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
}
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
forward();
const evaluate = expression =>
  JSON.parse(
    execFileSync(process.execPath, ['scripts/android-cdp.mjs', expression], { encoding: 'utf8' })
  ).result.value;
const base = process.env.REMOTE_TEST_URL || 'http://127.0.0.1:4187';
async function api(route) {
  const response = await fetch(base + '/api/' + route, { headers: { 'X-Hyprland-Client': '1' } });
  assert.equal(response.status, 200);
  return response.json();
}
function herdr(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      process.env.OMARCHY_HERDR_SOCKET || path.join(homedir(), '.config/herdr/herdr.sock')
    );
    socket.setTimeout(8000);
    let buffer = '';
    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 'android-herdr-qa', method, params }) + '\n')
    );
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
async function until(check) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Herdr Android condition did not become true');
}
const root = '#remote-herdr-app';
const field = root + ' .native-input';
const value = () => evaluate(`document.querySelector(${JSON.stringify(field)})?.value`);
const chord = (...keys) =>
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', ...keys);
async function tap(selector) {
  // Editing can reopen the IME; wait for its inset animation before measuring touch coordinates.
  let last,
    stable = 0;
  await until(async () => {
    const rect = evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`
    );
    const current = JSON.stringify(rect);
    stable = current === last ? stable + 1 : 0;
    last = current;
    return stable >= 5;
  });
  const target = evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()`
  );
  assert.ok(target, 'Touch target exists: ' + selector);
  const width = Number(
    adb('shell', 'wm', 'size').match(/(?:Override|Physical) size: (\d+)x\d+\s*$/)[1]
  );
  adb(
    'shell',
    'input',
    'tap',
    String(Math.round((target.x * width) / target.width)),
    String(Math.round((target.y * width) / target.width))
  );
}
await until(() => {
  try {
    forward();
    return evaluate('document.readyState==="complete" && !!window.HyprlandDesk');
  } catch {
    return false;
  }
});
const previous = evaluate(
  '({pane:localStorage.getItem("omarchy-herdr-pane"),recent:localStorage.getItem("omarchy-herdr-recent-panes")})'
);
assert.deepEqual(
  evaluate('JSON.parse(localStorage.getItem("omarchy-layout-phone"))?.open || ["home"]'),
  ['home'],
  'Start with only Home open'
);
const owned = [];
let attached;
let expectedOne = 'draftone';
const temporary = mkdtempSync(path.join(tmpdir(), 'android-herdr-'));
const filename = 'android-herdr-' + Date.now() + '.png';
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64'
);
writeFileSync(path.join(temporary, filename), image);
adb('push', path.join(temporary, filename), '/sdcard/Download/' + filename);
adb(
  'shell',
  'am',
  'broadcast',
  '-a',
  'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
  '-d',
  'file:///sdcard/Download/' + filename
);
function ui() {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/herdr-picker-qa.xml');
  } catch (error) {
    if (!error.stdout?.includes('dumped to:')) throw error;
  }
  return adb('shell', 'cat', '/sdcard/herdr-picker-qa.xml');
}
function tapNative(match) {
  const node = ui()
    .match(/<node\b[^>]*>/g)
    ?.find(match);
  assert.ok(node, 'Expected Android picker control');
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

function selected(id) {
  assert.ok(
    owned.some(p => p.pane_id === id),
    'Only a QA-owned pane may receive input'
  );
  assert.equal(evaluate('localStorage.getItem("omarchy-herdr-pane")'), id);
}
async function select(id) {
  evaluate(
    `document.querySelector(${JSON.stringify(root + ' .herdr-back')})?.click();document.querySelector(${JSON.stringify(root + ` .herdr-pane[data-pane="${id}"]`)})?.click()`
  );
  await until(() => {
    if (evaluate('localStorage.getItem("omarchy-herdr-pane")') === id) return true;
    evaluate(
      `document.querySelector(${JSON.stringify(root + ` .herdr-pane[data-pane="${id}"]`)})?.click()`
    );
    return false;
  });
  selected(id);
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(field)})`));
  if (
    evaluate(
      `document.querySelector(${JSON.stringify(field)}).closest('.native-input-panel').hidden`
    )
  )
    await tap(root + ' .herdr-prompt');
  // Wait for the keyboard inset/layout animation before touching the composer.
  await until(() =>
    evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(field)}).getBoundingClientRect();const inset=keyboardInset();return r.bottom<=innerHeight-inset+2})()`
    )
  );
  if (
    !evaluate(
      `document.activeElement===document.querySelector(${JSON.stringify(field)}) && keyboardInset()>80`
    )
  )
    await tap(field);
  await until(() =>
    evaluate(`document.activeElement===document.querySelector(${JSON.stringify(field)})`)
  );
}
try {
  for (let index = 0; index < 2; index++) {
    const created = await herdr('workspace.create', {
      label: 'Android input QA ' + index,
      cwd: '/tmp',
      focus: false,
    });
    const workspace = created.workspace?.workspace_id || created.workspace_id;
    assert.ok(workspace);
    owned.push({ workspace_id: workspace });
    const snapshot = await api('herdr/snapshot');
    const pane = snapshot.panes.find(p => p.workspace_id === workspace);
    assert.ok(pane);
    owned[index] = pane;
  }
  chord('KEYCODE_SHIFT_LEFT', 'KEYCODE_A');
  await until(() =>
    evaluate(
      `!!document.querySelector(${JSON.stringify(root + ` .herdr-pane[data-pane="${owned[0].pane_id}"]`)})`
    )
  );
  await select(owned[0].pane_id);
  if (process.env.ANDROID_TOUCH_IME_QA) {
    await until(() => evaluate('keyboardInset()>80'));
    assert.match(adb('shell', 'wm', 'size'), /size: 1080x2400\s*$/);
    assert.match(
      adb('shell', 'settings', 'get', 'secure', 'default_input_method'),
      /com.google.android.inputmethod.latin/
    );
    assert.match(adb('shell', 'wm', 'density'), /density: 420\s*$/);
    await tap(field);
    await new Promise(resolve => setTimeout(resolve, 1000));
    evaluate(
      `window.androidImeEvents=[];for(const type of ['compositionstart','compositionend','input','keydown'])document.querySelector(${JSON.stringify(field)}).addEventListener(type,event=>window.androidImeEvents.push({type,trusted:event.isTrusted,key:event.key,inputType:event.inputType}))`
    );
    writeFileSync(
      'artifacts/android/ime-keyboard.png',
      execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
        maxBuffer: 16 * 1024 * 1024,
      })
    );
    // Portrait English Gboard coordinates for the asserted 1080x2400 emulator.
    const keys = {
      e: [270, 1715],
      c: [432, 2020],
      h: [648, 1870],
      o: [918, 1715],
      space: [540, 2180],
      w: [162, 1715],
      r: [378, 1715],
      k: [864, 1870],
      s: [216, 1870],
    };
    for (const key of ['e', 'c', 'h', 'o', 'space', 'w', 'o', 'r', 'k', 's']) {
      selected(owned[0].pane_id);
      adb('shell', 'input', 'tap', ...keys[key].map(String));
    }
    assert.equal(value(), 'echo works');
    adb('shell', 'input', 'tap', '1000', '2180');
    await until(async () =>
      (await api('herdr/panes/' + encodeURIComponent(owned[0].pane_id))).text
        .split('\n')
        .some(line => line.trim() === 'works')
    );
    await until(() => value() === '');
    await until(() => evaluate('keyboardInset()<80'));
    assert.ok(
      evaluate(
        "window.androidImeEvents.filter(event=>event.type==='input'&&event.trusted).length===10"
      )
    );
    console.log(
      'PASS: real Gboard touch input and keyboard Send execute only in the owned pane and dismiss the IME'
    );
  } else {
    adb('shell', 'input', 'text', 'draftone');
    await until(() => value() === 'draftone');
    await select(owned[1].pane_id);
    assert.equal(value(), '');
    adb('shell', 'input', 'text', 'drafttwo');
    await until(() => value() === 'drafttwo');
    await select(owned[0].pane_id);
    assert.equal(value(), 'draftone');
    writeFileSync(
      'artifacts/android/herdr-input.png',
      execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
        maxBuffer: 16 * 1024 * 1024,
      })
    );
    await until(() =>
      evaluate(
        `keyboardInset()>80 && document.querySelector(${JSON.stringify(field)}).getBoundingClientRect().bottom <= innerHeight-keyboardInset()+2`
      )
    );
    selected(owned[0].pane_id);
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
    await until(() =>
      evaluate(
        `document.querySelector(${JSON.stringify(field)}).selectionEnd-document.querySelector(${JSON.stringify(field)}).selectionStart===8`
      )
    );
    evaluate(
      `window.androidHerdrCopied=false;document.querySelector(${JSON.stringify(field)}).addEventListener('copy',()=>window.androidHerdrCopied=true,{once:true})`
    );
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_C');
    await until(() => evaluate('window.androidHerdrCopied'));
    adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_RIGHT');
    await until(() =>
      evaluate(
        `document.querySelector(${JSON.stringify(field)}).selectionStart===8 && document.querySelector(${JSON.stringify(field)}).selectionEnd===8`
      )
    );
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_V');
    await until(() => value() === 'draftonedraftone');
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_Z');
    await until(() => value() === 'draftone');
    // Android's temporary clipboard preview can cover the lower-left attachment control.
    await new Promise(resolve => setTimeout(resolve, 20000));
    await tap(root + ' .herdr-attach');
    await until(() => ui().includes('com.google.android.documentsui'));
    tapNative(node => node.includes('content-desc="Show roots"'));
    tapNative(node => node.includes('text="Downloads"'));
    await until(() => ui().includes(filename));
    tapNative(node => node.includes('text="' + filename + '"'));
    await until(() => value()?.includes('Image: '));
    attached = value().match(/Image: (.+)\n/)[1];
    assert.ok(
      attached.startsWith(path.join(homedir(), '.local/share/omarchy-remote/uploads') + '/')
    );
    assert.deepEqual(readFileSync(attached), image);
    expectedOne = 'draftone\nImage: ' + attached + '\n';
    assert.equal(value(), expectedOne);
    // Ordinary backgrounding and process death must retain each pane's local draft.
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await new Promise(resolve => setTimeout(resolve, 300));
    adb('shell', 'am', 'force-stop', 'dev.omarchy.remote');
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
        return !!evaluate(`document.querySelector(${JSON.stringify(root + ' .herdr-list')})`);
      } catch {
        return false;
      }
    });
    await select(owned[0].pane_id);
    assert.equal(value(), expectedOne);
    await select(owned[1].pane_id);
    assert.equal(value(), 'drafttwo');
    selected(owned[1].pane_id);
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
    adb('shell', 'input', 'text', 'echo%sANDROID_HERDR_OK');
    await until(() => value() === 'echo ANDROID_HERDR_OK');
    await tap(root + ' .native-send');
    await until(async () =>
      (await api('herdr/panes/' + encodeURIComponent(owned[1].pane_id))).text
        .split('\n')
        .some(line => line.trim() === 'ANDROID_HERDR_OK')
    );
    await until(() => value() === '');
    await until(() => evaluate('keyboardInset()<80'));
    console.log(
      'PASS: separate native Herdr drafts, clipboard copy/paste/undo, composer above IME, process-death recovery, image upload with byte verification, and real send/dismiss to the owned pane'
    );
  }
} catch (error) {
  writeFileSync(
    'artifacts/android/herdr-input-failure.png',
    execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      maxBuffer: 16 * 1024 * 1024,
    })
  );
  console.error(
    evaluate(
      '({h:innerHeight,v:visualViewport.height,inset:window.__HYPRLAND_KEYBOARD__,css:getComputedStyle(document.documentElement).getPropertyValue("--keyboard-inset"),calc:keyboardInset(),classes:document.querySelector("#remote-herdr-app")?.className,field:document.querySelector("#remote-herdr-app .native-input")?.getBoundingClientRect().toJSON()})'
    )
  );
  throw error;
} finally {
  try {
    if (evaluate(`!!document.querySelector(${JSON.stringify(root + ' .herdr-list')})`)) {
      evaluate('HyprlandDesk.nativeKey({code:"KeyW",meta:true})');
      await until(
        () => !evaluate(`!!document.querySelector(${JSON.stringify(root + ' .herdr-list')})`)
      );
    }
    evaluate(
      `(()=>{const storage=HyprlandUtil.storage;const saved=${JSON.stringify(previous)};storage.set('omarchy-herdr-pane',saved.pane);storage.set('omarchy-herdr-recent-panes',saved.recent);const drafts=storage.read('omarchy-herdr-drafts-v1',{});for(const id of ${JSON.stringify(owned.map(p => p.pane_id))})delete drafts[id];storage.write('omarchy-herdr-drafts-v1',drafts)})()`
    );
  } finally {
    for (const pane of owned) await herdr('workspace.close', { workspace_id: pane.workspace_id });
    if (attached) rmSync(attached, { force: true });
    adb('shell', 'rm', '-f', '/sdcard/Download/' + filename);
    rmSync(temporary, { recursive: true, force: true });
  }
}
