// Native saved-app lifecycle against an isolated in-memory catalog; no live host writes.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import WebSocket from 'ws';
const run = promisify(execFile);
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const devices = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(x => /^emulator-\d+\s+device$/.test(x.trim()))
  .map(x => x.split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : '');
assert.match(serial, /^emulator-\d+$/, 'Use an emulator for the isolated host fixture');
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
    try {
      if (await check()) return;
    } catch {
      // Navigating or replacing the shell temporarily invalidates CDP targets.
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw Error('Android saved-app condition timed out');
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
assert.ok(original.selected && !original.disconnected);
assert.ok(original.hosts.length < 10, 'The isolated host needs one free saved-host slot');
let catalog = [];
let catalogOnline = true;
const mutations = [];
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/state' || req.url === '/api/state/webapps') {
      if (!catalogOnline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Catalog offline for persistence test' }));
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const change = JSON.parse(Buffer.concat(chunks));
        mutations.push(change.action);
        if (change.action === 'remove') catalog = catalog.filter(a => a.id !== change.id);
        else catalog = [...catalog.filter(a => a.id !== change.app.id), change.app];
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ schema: 1, webapps: catalog }));
      return;
    }
    if (req.url.startsWith('/qa/')) {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width"><style>html,body,#pointer-target{margin:0;width:100%;height:100%}#pointer-target{box-sizing:border-box;padding:24px;background:#fff;color:#111}html[data-qa-hover="on"] #pointer-target:hover{background:#b7f7d0}</style><div id="pointer-target"><h1>Saved app QA</h1><a id="next" href="/qa/two" target="_blank">Next page</a><input aria-label="Fixture input"></div>'
      );
      return;
    }
    if (req.url.startsWith('/api/') || req.url.startsWith('/__dev/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Isolated saved-app fixture' }));
      return;
    }
    const upstream = await fetch('http://127.0.0.1:4187' + req.url);
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502);
    res.end();
  }
});
server.on('upgrade', (_req, socket) => socket.destroy());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const host = `http://127.0.0.1:${port}/native/`;
const site = `http://127.0.0.1:${port}/qa/one`;
const sockets = [];
let hoverQaBuild;
const hoverQaRemote = '/data/local/tmp/omarchy-remote-qa-hover.jar';
async function page(suffix = '') {
  let target;
  await until(async () => {
    target = (await (await fetch('http://127.0.0.1:9225/json/list')).json()).find(
      t => t.url.startsWith(`http://127.0.0.1:${port}/qa/`) && t.url.endsWith(suffix)
    );
    return target;
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let sequence = 0;
  return expression =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        socket.off('message', receive);
        reject(Error('Page evaluation timed out'));
      }, 10000);
      function receive(data) {
        const reply = JSON.parse(data);
        if (reply.id !== id) return;
        clearTimeout(timer);
        socket.off('message', receive);
        if (reply.error || reply.result?.exceptionDetails) reject(Error(JSON.stringify(reply)));
        else resolve(reply.result.result.value);
      }
      socket.on('message', receive);
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        })
      );
    });
}
const click = label => shell(`document.querySelector('[aria-label="${label}"]').click();true`);
try {
  await shell(
    `window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'save', name: 'Android saved-app QA', url: host })})`
  );
  await shell(
    `void window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'connect', id: host })})`
  );
  await until(() => shell(`location.href===${JSON.stringify(host)} && !!window.HyprlandWebApps`));
  await shell('HyprlandWebApps.manage();true');
  await until(() => shell('!!document.querySelector(".webapps-install")'));
  await shell(
    `document.querySelector('[aria-label="Web app name"]').value='Saved app QA';document.querySelector('[aria-label="Web app URL"]').value=${JSON.stringify(site)};document.querySelector('.webapps-install').requestSubmit();true`
  );
  await until(() => catalog.length === 1 && mutations.includes('install'));
  const id = catalog[0].id;
  await click('Open Saved app QA');
  let web = await page();
  await until(() => web('document.readyState==="complete"'));
  assert.equal(await web('typeof AndroidShell'), 'undefined');
  assert.equal(await shell('!!document.querySelector(".browser-chrome")'), false);
  await web(
    'document.cookie="savedAppQA=retained; Max-Age=3600; Path=/qa/; SameSite=Lax";document.querySelector("#next").click();true'
  );
  await until(() => web('location.pathname==="/qa/two"'));
  assert.equal(await web('document.cookie.includes("savedAppQA=retained")'), true);
  assert.equal(
    (await (await fetch('http://127.0.0.1:9225/json/list')).json()).filter(t =>
      t.url.includes(`:${port}/qa/`)
    ).length,
    1
  );
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until(() => web('location.pathname==="/qa/one"'));
  if (process.env.ANDROID_TABLET_WEBAPPS_QA) {
    assert.match(adb('shell', 'wm', 'size'), /size: 1280x800\s*$/);
    assert.match(adb('shell', 'wm', 'density'), /density: 160\s*$/);
    const chord = (...keys) =>
      adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', ...keys);
    await shell('HyprlandWebApps.manage();true');
    await shell(
      `document.querySelector('[aria-label="Web app name"]').value='Second app QA';document.querySelector('[aria-label="Web app URL"]').value=${JSON.stringify(site.replace('/one', '/other'))};document.querySelector('.webapps-install').requestSubmit();true`
    );
    await until(() => catalog.length === 2);
    const second = catalog.find(app => app.id !== id).id;
    await click('Open Second app QA');
    const other = await page('/other');
    await until(() => other('document.readyState === "complete"'));
    chord('KEYCODE_SHIFT_LEFT', 'KEYCODE_2');
    await until(() =>
      shell(
        `(()=>{const l=JSON.parse(localStorage.getItem('omarchy-layout-desk'));return l.tiles[${JSON.stringify(id)}]===l.tiles[${JSON.stringify(second)}]})()`
      )
    );
    const bounds = key =>
      shell(
        `document.querySelector('[data-workspace="${key}"] .webapp-app').getBoundingClientRect().toJSON()`
      );
    async function fits(key, evaluate) {
      const rect = await bounds(key);
      const size = await evaluate('({width:innerWidth,height:innerHeight})');
      return Math.abs(rect.width - size.width) <= 2 && Math.abs(rect.height - size.height) <= 2;
    }
    await until(async () => (await fits(id, web)) && (await fits(second, other)));

    hoverQaBuild = mkdtempSync(join('/tmp', 'omarchy-android-hover-'));
    const hoverQaClasses = join(hoverQaBuild, 'classes');
    const hoverQaDex = join(hoverQaBuild, 'dex');
    mkdirSync(hoverQaClasses);
    mkdirSync(hoverQaDex);
    const androidJar =
      process.env.ANDROID_JAR || '/opt/android-sdk/platforms/android-36/android.jar';
    const d8 = process.env.D8 || '/opt/android-sdk/build-tools/36.0.0/d8';
    const hoverQaSource = join(process.cwd(), 'scripts/android-qa/AndroidHoverInject.java');
    const hoverQaClass = join(hoverQaClasses, 'AndroidHoverInject.class');
    const hoverQaJar = join(hoverQaBuild, 'android-hover.jar');
    execFileSync('javac', [
      '--release',
      '8',
      '-classpath',
      androidJar,
      '-d',
      hoverQaClasses,
      hoverQaSource,
    ]);
    execFileSync(d8, [
      '--min-api',
      '29',
      '--lib',
      androidJar,
      '--output',
      hoverQaDex,
      hoverQaClass,
    ]);
    execFileSync('jar', ['cf', hoverQaJar, '-C', hoverQaDex, 'classes.dex']);
    adb('push', hoverQaJar, hoverQaRemote);

    // These probes only observe events delivered by Android; no JavaScript pointer events are
    // dispatched here. The QA helper injects MotionEvents through InputManager and InputDispatcher.
    const installPointerProbe = evaluate =>
      evaluate(
        `(()=>{const target=document.querySelector('#pointer-target');document.documentElement.dataset.qaHover='on';window.__androidPointerEvents=[];for(const type of ['pointerenter','pointermove','pointerover'])target.addEventListener(type,e=>window.__androidPointerEvents.push({type,pointerType:e.pointerType,buttons:e.buttons}),true);return true})()`
      );
    await installPointerProbe(web);
    await installPointerProbe(other);
    await shell(
      'window.__androidHoverStates=[];window.addEventListener("host-browser-state",e=>{if(e.detail?.hovered)window.__androidHoverStates.push(e.detail.appID||null)});true'
    );
    const focus = () =>
      shell('JSON.parse(localStorage.getItem("omarchy-layout-desk") || "null")?.focus || null');
    const setPointerFocus = async enabled => {
      await shell(
        `HyprlandUtil.storage.set('omarchy-focus-follows-pointer',${JSON.stringify(String(enabled))});true`
      );
      await until(() =>
        shell(
          `HyprlandUtil.storage.get('omarchy-focus-follows-pointer')===${JSON.stringify(String(enabled))}`
        )
      );
    };
    const rectCenter = key =>
      shell(
        `document.querySelector('[data-workspace="${key}"] .webapp-app').getBoundingClientRect().toJSON()`
      ).then(rect => ({
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
      }));
    const injectHover = point => {
      adb(
        'shell',
        `CLASSPATH=${hoverQaRemote}`,
        'app_process',
        '/',
        'AndroidHoverInject',
        'MOVE',
        String(point.x),
        String(point.y)
      );
    };
    const nativeHover = async point => {
      injectHover(point);
      await new Promise(resolve => setTimeout(resolve, 350));
    };
    let initialFocus;
    await until(async () => {
      const current = await focus();
      if (current !== id && current !== second) return false;
      initialFocus = current;
      return true;
    });
    const hoverTarget = initialFocus === id ? second : id;
    const hoverPage = hoverTarget === id ? web : other;
    const otherTarget = hoverTarget === id ? second : id;
    const hoverPoint = await rectCenter(hoverTarget);
    const otherPoint = await rectCenter(otherTarget);
    await setPointerFocus(false);
    await nativeHover(hoverPoint);
    assert.equal(
      await focus(),
      initialFocus,
      'Mouse hover does not focus a tile while the setting is off'
    );
    await setPointerFocus(true);
    await nativeHover(otherPoint);
    assert.equal(
      await focus(),
      initialFocus,
      'Hovering the already focused tile leaves focus unchanged'
    );
    await nativeHover(hoverPoint);
    await until(() => focus().then(value => value === hoverTarget));
    assert.equal(
      await focus(),
      hoverTarget,
      'Native mouse hover focuses the hovered native tile when enabled'
    );
    assert.ok(
      await shell(`window.__androidHoverStates.includes(${JSON.stringify(hoverTarget)})`),
      'Native hover event reaches the shell bridge'
    );
    assert.equal(
      await hoverPage('document.querySelector("#pointer-target").matches(":hover")'),
      true,
      'The website under the native tile receives CSS hover state'
    );
    assert.ok(
      await hoverPage(
        'window.__androidPointerEvents.some(e=>e.type==="pointermove"&&e.pointerType==="mouse"&&e.buttons===0)'
      ),
      'The website receives a real mouse pointermove while native hover focus is enabled'
    );
    const resetPointerProbe = evaluate =>
      evaluate(
        `(()=>{document.documentElement.removeAttribute('data-qa-hover');window.__androidPointerEvents=[];return true})()`
      );
    await resetPointerProbe(web);
    await resetPointerProbe(other);
    const initialWidth = await web('innerWidth');
    const divider = await shell(
      'document.querySelector(".desk-divider").getBoundingClientRect().toJSON()'
    );
    const x = Math.round(divider.x + divider.width / 2),
      y = Math.round(divider.y + divider.height / 2);
    adb('shell', 'input', 'swipe', String(x), String(y), String(x + 110), String(y), '400');
    await until(
      async () =>
        Math.abs((await web('innerWidth')) - initialWidth) > 50 &&
        (await fits(id, web)) &&
        (await fits(second, other))
    );
    writeFileSync(
      'artifacts/android/tablet-webapps.png',
      execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
        maxBuffer: 16 * 1024 * 1024,
      })
    );
    await until(() =>
      shell(
        '[...document.querySelectorAll(".webapp-preview")].length === 2 && [...document.querySelectorAll(".webapp-preview")].every(image => image.complete && image.naturalWidth > 0 && !image.hidden)'
      )
    );
    chord('KEYCODE_E');
    await until(() => shell('document.querySelectorAll(".native-surface-visible").length === 0'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const expo = execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync('artifacts/android/tablet-webapps-expo.png', expo);
    const sample = execFileSync(
      'python',
      [
        '-c',
        'from PIL import Image; import sys,io; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); print(*im.getpixel((100,100)))',
      ],
      { input: expo, encoding: 'utf8' }
    )
      .trim()
      .split(' ')
      .map(Number);
    assert.ok(
      sample.every(channel => channel < 100),
      'Expo hides the full-size native page above its preview cards'
    );
    adb('shell', 'input', 'keyevent', 'KEYCODE_ESCAPE');
    await until(() => shell('document.querySelectorAll(".native-surface-visible").length === 2'));
    await until(async () => (await fits(id, web)) && (await fits(second, other)));
    await shell('HyprlandWebApps.manage();true');
    await click('Uninstall Second app QA from host');
    await click('Uninstall');
    await until(() => catalog.length === 1);
    await until(() => fits(id, web));
    console.log(
      'PASS: two independent Android tablet web apps match their tiles, resize with divider drag, hide in Expo and restore their geometry'
    );
  }
  // Wait for the device's asynchronous preference mirror before testing ordinary process death.
  await new Promise(resolve => setTimeout(resolve, 1000));
  catalogOnline = false;
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
  adb(
    'forward',
    'tcp:9225',
    `localabstract:webview_devtools_remote_${adb('shell', 'pidof', 'dev.omarchy.remote')}`
  );
  await until(async () => {
    try {
      return await shell('!!window.HyprlandWebApps');
    } catch {
      return false;
    }
  });
  await shell('HyprlandWebApps.manage();true');
  await until(() => shell('!!document.querySelector(\'[aria-label="Open Saved app QA"]\')'));
  assert.equal(
    await shell(
      `JSON.parse(localStorage.getItem('omarchy-home-pins')).includes(${JSON.stringify(id)})`
    ),
    true
  );
  await click('Open Saved app QA');
  web = await page();
  await until(() => web('document.readyState==="complete"'));
  assert.equal(
    await web('document.cookie.includes("savedAppQA=retained")'),
    true,
    'Website session survives process death'
  );
  const screenshot = execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync('artifacts/android/saved-webapp.png', screenshot);
  const canvas = execFileSync(
    'python',
    [
      '-c',
      'from PIL import Image; import io,sys; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); print(*im.getpixel((im.width//2,im.height//2)))',
    ],
    { input: screenshot, encoding: 'utf8' }
  ).trim();
  // The shell intentionally composites active pages at slightly reduced opacity.
  const rgb = canvas.split(' ').map(Number);
  assert.ok(
    rgb.every(channel => channel >= 235) && Math.max(...rgb) - Math.min(...rgb) <= 2,
    'Unstyled website canvas remains readable against default black text'
  );
  catalogOnline = true;
  await shell('HyprlandWebApps.manage();true');
  await click('Uninstall Saved app QA from host');
  await click('Uninstall');
  await until(() => catalog.length === 0 && mutations.includes('remove'));
  await until(() => shell(`!document.querySelector('[data-workspace="${id}"]')`));
  assert.equal(
    await shell(
      `JSON.parse(localStorage.getItem('omarchy-home-pins')).includes(${JSON.stringify(id)})`
    ),
    false
  );
  console.log(
    'PASS: native saved-app install, chrome-free page, inline new-window link, Back, cookie/catalog/pin persistence across process death, and uninstall against an isolated catalog'
  );
} finally {
  for (const socket of sockets) socket.close();
  try {
    await shell(
      `void window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'connect', id: original.selected })})`
    );
    await until(() =>
      shell(`location.href===${JSON.stringify(original.selected)} && !!window.HyprlandDesk`)
    );
    await shell(
      `window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'remove', id: host })})`
    );
  } finally {
    if (hoverQaBuild) {
      try {
        adb('shell', 'rm', '-f', hoverQaRemote);
      } catch {}
      rmSync(hoverQaBuild, { recursive: true, force: true });
    }
    adb('reverse', '--remove', `tcp:${port}`);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
