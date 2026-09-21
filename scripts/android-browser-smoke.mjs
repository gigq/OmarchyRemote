// Native WebView integration checks against an installed debug APK. No desktop tabs are changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import WebSocket from 'ws';
const adbPath = process.env.ADB || '/opt/android-sdk/platform-tools/adb';
const emulators = execFileSync(adbPath, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .filter(line => /^emulator-\d+\s+device$/.test(line.trim()))
  .map(line => line.trim().split(/\s+/)[0]);
const serial = process.env.ANDROID_SERIAL || (emulators.length === 1 ? emulators[0] : '');
assert.ok(serial, 'Set ANDROID_SERIAL when there is not exactly one running emulator');
const adb = (...args) =>
  execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }).trim();
const pid = adb('shell', 'pidof', 'dev.omarchy.remote');
assert.match(pid, /^\d+$/);
adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><title>Android browser QA</title><style>body{height:4000px;background:white;color:black}</style><div id="zoom-box" style="width:40px;height:20px;background:blue"></div><img id="zoom-image" width="20" height="10" alt="QA" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2210%22%3E%3Crect width=%2220%22 height=%2210%22 fill=%22red%22/%3E%3C/svg%3E"><h1>Needle one</h1><p>Needle two</p><input aria-label="QA page input"><a href="/next" target="_blank">New window link</a>'
  );
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const connections = [];
async function connect(match) {
  const targets = await (await fetch('http://127.0.0.1:9225/json/list')).json();
  const target = targets.find(match);
  assert.ok(target, 'WebView target exists');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  connections.push(socket);
  let serial = 0;
  return expression =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        socket.off('message', receive);
        reject(Error('CDP timeout'));
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
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Condition did not become true');
}
const shell = await connect(t => t.url.includes('/native/') || t.url.includes('/assets/Web/'));
const id = 'android-browser-qa';
const command = (action, body = {}) =>
  shell(
    `window.webkit.messageHandlers.browserDevice.postMessage(${JSON.stringify({ action, appID: id, ...body })})`
  );
try {
  await shell(
    `window.androidQAEvents=[];window.androidQAListener=e=>{if(e.detail.appID===${JSON.stringify(id)})androidQAEvents.push(e.detail)};window.addEventListener('host-browser-state',androidQAListener)`
  );
  await command('open', { url: `http://127.0.0.1:${port}/one` });
  await command('layout', { visible: true, rect: [12, 70, 388, 750], viewport: 412, radius: 16 });
  await until(() => shell('androidQAEvents.some(e=>e.title==="Android browser QA" && !e.loading)'));
  const page = await connect(t => t.url.includes(`:${port}/`));
  assert.equal(await page('typeof AndroidShell'), 'undefined');
  await page('history.pushState({}, "", "/two")');
  await until(() => shell('androidQAEvents.some(e=>e.url?.endsWith("/two") && e.back)')).catch(
    async error => {
      console.error(await shell('androidQAEvents'));
      throw error;
    }
  );
  if (await shell('(window.__HYPRLAND_KEYBOARD__?.inset || 0) > 0')) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await until(() => shell('(window.__HYPRLAND_KEYBOARD__?.inset || 0) === 0'));
  }
  await command('focus');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await until(() => shell('androidQAEvents.some(e=>e.url?.endsWith("/one") && e.forward)'));
  await command('forward');
  await until(() => page('location.pathname==="/two"'));
  await page('scrollTo(0,100)');
  await until(() =>
    shell('androidQAEvents.filter(e=>"controlsHidden" in e).at(-1)?.controlsHidden===true')
  );
  await page('scrollTo(0,5)');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(
    await shell('androidQAEvents.filter(e=>"controlsHidden" in e).at(-1).controlsHidden'),
    true
  );
  await page('scrollTo(0,0)');
  await until(() =>
    shell('androidQAEvents.filter(e=>"controlsHidden" in e).at(-1)?.controlsHidden===false')
  );
  // Older WebViews report pre-zoom DOM bounds for root zoom. Check rendered pixels
  // instead: both a blue layout box and a red image must scale together.
  const pixels = () => {
    const png = execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p']);
    return JSON.parse(
      execFileSync(
        'python',
        [
          '-c',
          `
import io,json,re,sys
from PIL import Image
im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
result=[]
for color in [(0,0,255),(255,0,0)]:
    pattern=re.compile(b"(?:"+re.escape(bytes(color))+b")+")
    rows=im.tobytes()
    stride=im.width*3
    best=max((len(match.group())//3 for y in range(im.height)
              for match in pattern.finditer(rows[y*stride:(y+1)*stride])
              if match.start()%3==0),default=0)
    result.append(best)
print(json.dumps(result))
`,
        ],
        { input: png, encoding: 'utf8' }
      )
    );
  };
  // Remove the rounded viewport clip while measuring very small boxes at 25%.
  await command('layout', { visible: true, rect: [12, 70, 388, 750], viewport: 412, radius: 0 });
  const baseline = pixels();
  assert.ok(baseline.every(width => width > 10));
  const verifyScale = factor =>
    until(async () =>
      pixels().every((width, i) => Math.abs(width - baseline[i] * factor) <= factor + 1)
    ).catch(error => {
      console.error({ factor, baseline, pixels: pixels() });
      throw error;
    });
  for (const factor of [0.25, 0.5, 1.5, 5, 1]) {
    await command('zoom', { value: factor });
    await verifyScale(factor);
  }
  // Preserve authored root zoom, including its priority, after repeated changes/reset.
  await page("document.documentElement.style.setProperty('zoom','1.2','important')");
  await command('zoom', { value: 1.5 });
  await verifyScale(1.8);
  await command('zoom', { value: 1 });
  await until(() =>
    page(
      "document.documentElement.style.zoom==='1.2' && document.documentElement.style.getPropertyPriority('zoom')==='important'"
    )
  );
  await verifyScale(1.2);
  await page("document.documentElement.style.removeProperty('zoom')");
  await command('zoom', { value: 1.5 });
  await verifyScale(1.5);
  await page('window.zoomQABeforeReload=true');
  await command('reload');
  await until(() =>
    page(
      "!window.zoomQABeforeReload && document.readyState==='complete' && !!document.querySelector('#zoom-box')"
    )
  );
  await verifyScale(1.5);
  await command('zoom', { value: 1 });
  await verifyScale(1);
  await command('dark', { enabled: true });
  await until(() => page('!!document.querySelector("style.darkreader")'));
  await command('dark', { enabled: false });
  await until(() => page('!document.querySelector("style.darkreader")'));
  await shell(`window.androidQAOriginalKey=HyprlandDesk.nativeKey;window.androidQAKeys=[];
    HyprlandDesk.nativeKey=key=>{androidQAKeys.push(key);if(key.code==='KeyF')window.webkit.messageHandlers.browserDevice.postMessage({action:'findOpen',appID:'android-browser-qa'});return true};
    window.webkit.messageHandlers.shellKeyboard.postMessage({commands:[
      {code:'KeyF',label:'QA Find',owner:'browser',ctrl:true,meta:false},
      {code:'KeyL',label:'QA Address',owner:'browser',meta:true},
      {code:'KeyY',label:'QA window action',owner:'shell',group:'Windows',meta:true}
    ]})`);
  await command('focus');
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_L');
  await until(() => shell('androidQAKeys.some(key=>key.code==="KeyL" && key.meta)'));
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_F');
  await until(
    () =>
      adb('shell', 'uiautomator', 'dump', '/sdcard/browser-qa.xml') &&
      adb('shell', 'cat', '/sdcard/browser-qa.xml').includes('Find in page')
  );
  adb('shell', 'input', 'text', 'needle');
  await until(
    () =>
      adb('shell', 'uiautomator', 'dump', '/sdcard/browser-qa.xml') &&
      adb('shell', 'cat', '/sdcard/browser-qa.xml').includes('1 of 2')
  );
  await command('findNext');
  await until(
    () =>
      adb('shell', 'uiautomator', 'dump', '/sdcard/browser-qa.xml') &&
      adb('shell', 'cat', '/sdcard/browser-qa.xml').includes('2 of 2')
  );
  assert.equal((await command('findClose')).closed, true);
  assert.equal((await command('findClose')).closed, false);
  await command('focus', { active: false });
  await shell(
    'window.androidQAInput=document.createElement("input");androidQAInput.style.cssText="position:fixed;top:80px;left:20px;z-index:99999";document.body.append(androidQAInput);androidQAInput.focus()'
  );
  adb('shell', 'input', 'text', 'shellfocus');
  assert.equal(await shell('androidQAInput.value'), 'shellfocus');
  await command('focus');
  await page('document.querySelector("input").focus()');
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_ALT_LEFT', 'KEYCODE_Y');
  adb('shell', 'input', 'text', 'pagefocus');
  assert.equal(await page('document.querySelector("input").value'), 'pagefocus');
  await page(
    'window.qaCopied=false;document.addEventListener("copy",()=>window.qaCopied=true,{once:true})'
  );
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
  await until(() =>
    page(
      'document.querySelector("input").selectionStart===0 && document.querySelector("input").selectionEnd===9'
    )
  );
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_C');
  await until(() => page('window.qaCopied'));
  await page('document.querySelector("input").setSelectionRange(9,9)');
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_V');
  await until(() => page('document.querySelector("input").value==="pagefocuspagefocus"'));
  assert.equal(await shell('androidQAKeys.length'), 3);
  // The shell publishes active-window focus in layout; no separate focus command
  // or tap is sent during these transitions.
  await page('document.querySelector("input").setSelectionRange(18,18)');
  const layout = { visible: true, rect: [12, 70, 388, 750], viewport: 412, radius: 16 };
  await command('layout', { ...layout, focused: false });
  await shell('androidQAInput.focus()');
  adb('shell', 'input', 'text', 'layoutshell');
  await until(() => shell('androidQAInput.value === "shellfocuslayoutshell"'));
  await command('layout', { ...layout, focused: true });
  adb('shell', 'input', 'text', 'layoutpage');
  await until(() =>
    page('document.querySelector("input").value === "pagefocuspagefocuslayoutpage"')
  ).catch(async error => {
    console.error({
      page: await page(
        '({value:document.querySelector("input").value,active:document.activeElement.tagName,focus:document.hasFocus()})'
      ),
      shell: await shell('({value:androidQAInput.value,focus:document.hasFocus()})'),
    });
    throw error;
  });
  const width = await page('innerWidth');
  await command('layout', { ...layout, focused: true, rect: [-160, 70, 388, 750] });
  assert.equal(
    await page('innerWidth'),
    width,
    'Sliding partially offscreen preserves the page viewport'
  );
  await command('layout', { ...layout, focused: true });
  await command('layout', { visible: false });
  await shell('androidQAInput.focus()');
  adb('shell', 'input', 'text', 'hiddenpage');
  await until(() => shell('androidQAInput.value === "shellfocuslayoutshellhiddenpage"')).catch(
    async error => {
      console.error('hidden', await shell('androidQAInput.value'));
      throw error;
    }
  );
  await command('layout', { ...layout, focused: true });
  adb('shell', 'input', 'text', 'restoredpage');
  await until(() =>
    page('document.querySelector("input").value.endsWith("layoutpagerestoredpage")')
  ).catch(async error => {
    console.error('restored', await page('document.querySelector("input").value'));
    throw error;
  });

  console.log(
    'PASS: isolated website, SPA history, back/forward, top-only toolbar reveal, full-page zoom and reload/reset, dark mode, find matches, shell/page keyboard focus, native shortcuts and clipboard'
  );
} finally {
  await shell(
    `if(window.androidQAOriginalKey){HyprlandDesk.nativeKey=androidQAOriginalKey;delete window.androidQAOriginalKey;delete window.androidQAKeys};window.webkit.messageHandlers.shellKeyboard.postMessage({commands:HyprlandDesk.actions().filter(a=>a.code)})`
  ).catch(() => {});
  await command('close').catch(() => {});
  await shell(
    'window.androidQAInput?.remove();window.removeEventListener("host-browser-state",window.androidQAListener);delete window.androidQAEvents;delete window.androidQAListener'
  ).catch(() => {});
  for (const socket of connections) socket.close();
  adb('reverse', '--remove', `tcp:${port}`);
  server.close();
}
