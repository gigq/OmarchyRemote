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
    '<!doctype html><meta name="viewport" content="width=device-width"><title>Android browser QA</title><style>body{height:4000px;background:white;color:black}</style><h1>Needle one</h1><p>Needle two</p><input aria-label="QA page input"><a href="/next" target="_blank">New window link</a>'
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
  await command('back');
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
  await command('dark', { enabled: true });
  await until(() => page('!!document.querySelector("style.darkreader")'));
  await command('dark', { enabled: false });
  await until(() => page('!document.querySelector("style.darkreader")'));
  await command('findOpen');
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
  adb('shell', 'input', 'text', 'pagefocus');
  assert.equal(await page('document.querySelector("input").value'), 'pagefocus');
  console.log(
    'PASS: isolated website, SPA history, back/forward, top-only toolbar reveal, dark mode, find matches, shell/page keyboard focus'
  );
} finally {
  await command('close').catch(() => {});
  await shell(
    'window.androidQAInput?.remove();window.removeEventListener("host-browser-state",window.androidQAListener);delete window.androidQAEvents;delete window.androidQAListener'
  ).catch(() => {});
  for (const socket of connections) socket.close();
  adb('reverse', '--remove', `tcp:${port}`);
  server.close();
}
