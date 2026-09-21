// Called only by the isolated Vivaldi integration test. Never uses the user's desktop profile.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import WebSocket from 'ws';
const run = promisify(execFile);
export async function verifyAndroidBrowser({ backendPort, token, api, instance }) {
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
      if (await check()) return;
      await new Promise(r => setTimeout(r, 150));
    }
    throw Error('Android desktop Browser integration timed out');
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
  for (const url of [
    'http://insecure.example/',
    'https://user:pass@host.example/',
    'https://host.example/custom',
    'https://host.example/?secret=1',
  ]) {
    const rejected = await shell(
      `window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'save', name: 'Invalid QA', url })}).then(()=>false,()=>true)`
    );
    assert.equal(rejected, true, 'Native host validation rejects unsafe addresses');
  }
  assert.equal(
    (await shell('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})')).hosts
      .length,
    original.hosts.length
  );

  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/__dev/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url.startsWith('/qa/')) {
        const second = req.url.startsWith('/qa/two');
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html><meta name="viewport" content="width=device-width"><title>Android desktop QA ${second ? 'two' : 'one'}</title><h1>Android desktop QA</h1><a id="next" href="/qa/two">Next page</a><input aria-label="Fixture input">`
        );
        return;
      }
      if (req.url.startsWith('/api/') && !req.url.startsWith('/api/browser/')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Isolated browser fixture' }));
        return;
      }
      const browser = req.url.startsWith('/api/browser/');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch(`http://127.0.0.1:${browser ? backendPort : 4187}${req.url}`, {
        method: req.method,
        headers: browser
          ? {
              'X-Omarchy-Proxy': token,
              'X-Hyprland-Client': '1',
              'Content-Type': 'application/json',
            }
          : {},
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502);
      res.end('Fixture unavailable');
    }
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  const host = `http://127.0.0.1:${port}/native/`;
  const site = `http://127.0.0.1:${port}/qa/one`;
  let pageSocket;
  try {
    assert.equal(
      (
        await api('action', {
          instance_id: instance,
          action: 'create',
          url: site,
          new_window: true,
        })
      ).status,
      200
    );
    let tab;
    await until(async () => {
      const snapshot = (await api('snapshot')).body;
      tab = snapshot.instances
        .find(i => i.id === instance)
        ?.windows.flatMap(w => w.tabs)
        .find(t => t.url === site);
      return tab;
    });
    await shell(
      `window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'save', name: 'Android isolated browser QA', url: host })})`
    );
    await shell(
      `void window.webkit.messageHandlers.shellHosts.postMessage(${JSON.stringify({ action: 'connect', id: host })})`
    );
    await until(() => shell(`location.href===${JSON.stringify(host)} && !!window.HyprlandDesk`));
    adb(
      'shell',
      'input',
      'keycombination',
      'KEYCODE_CTRL_LEFT',
      'KEYCODE_ALT_LEFT',
      'KEYCODE_SHIFT_LEFT',
      'KEYCODE_B'
    );
    const selector = `#remote-browser-app [data-tab="${tab.id}"] .browser-open`;
    await until(() => shell(`!!document.querySelector(${JSON.stringify(selector)})`));
    await shell(`document.querySelector(${JSON.stringify(selector)}).click();true`);
    let target;
    await until(async () => {
      target = (await (await fetch('http://127.0.0.1:9225/json/list')).json()).find(
        t => t.url === site
      );
      return target;
    });
    pageSocket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      pageSocket.once('open', r);
      pageSocket.once('error', j);
    });
    let sequence = 0;
    const page = expression =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pageSocket.off('message', receive);
          reject(Error('Native page timeout'));
        }, 10000);
        const receive = data => {
          const reply = JSON.parse(data);
          if (reply.id !== id) return;
          pageSocket.off('message', receive);
          clearTimeout(timer);
          if (reply.error || reply.result?.exceptionDetails) reject(Error(JSON.stringify(reply)));
          else resolve(reply.result.result.value);
        };
        pageSocket.on('message', receive);
        pageSocket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, userGesture: true },
          })
        );
      });
    await until(() => page('document.readyState==="complete"'));
    assert.equal(await page('typeof AndroidShell'), 'undefined');
    await page('document.querySelector("#next").click()');
    await until(
      async () =>
        (await api('snapshot')).body.instances
          .find(i => i.id === instance)
          .windows.flatMap(w => w.tabs)
          .find(t => t.id === tab.id)?.url === site.replace('/one', '/two')
    );
    assert.equal(await page('location.pathname'), '/qa/two');
    // This is the real native shortcut and shared Browser adapter, not an API close.
    adb(
      'shell',
      'input',
      'keycombination',
      'KEYCODE_CTRL_LEFT',
      'KEYCODE_ALT_LEFT',
      'KEYCODE_SHIFT_LEFT',
      'KEYCODE_W'
    );
    await until(
      async () =>
        !(await api('snapshot')).body.instances
          .find(i => i.id === instance)
          .windows.flatMap(w => w.tabs)
          .some(t => t.id === tab.id)
    );
    assert.equal(
      await shell('!!document.querySelector("#remote-browser-app .browser-manager")'),
      true,
      'Closing a tab leaves the app window open'
    );
    await shell(
      "HyprlandUtil.storage.set('omarchy-android-host-qa','isolated');void HyprlandHosts.disconnect()"
    );
    await until(() =>
      shell(
        'location.pathname.endsWith("/hosts.html") && !!document.querySelector(".host-connect")'
      )
    );
    assert.equal(
      (await shell('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})'))
        .disconnected,
      true
    );
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
        return await shell(
          'location.pathname.endsWith("/hosts.html") && !!document.querySelector(".host-connect")'
        );
      } catch {
        return false;
      }
    }).catch(async error => {
      console.error(
        await shell(
          '({url:location.href,ready:document.readyState,body:document.body?.innerText.slice(0,300),directory:window.__OMARCHY_DEVICE__?.hosts?.disconnected})'
        )
      );
      throw error;
    });
    assert.equal(
      (await shell('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})'))
        .disconnected,
      true,
      'Restarting must preserve explicit disconnection'
    );

    await shell(
      `([...document.querySelectorAll('.host-connect')].find(b=>b.textContent.includes('Android isolated browser QA'))).click();true`
    );
    await until(() => shell(`location.href===${JSON.stringify(host)} && !!window.HyprlandDesk`));
    assert.equal(await shell("localStorage.getItem('omarchy-android-host-qa')"), 'isolated');
    console.log(
      'Android: real isolated Vivaldi tab list, embedded navigation sync, native close shortcut, host validation and disconnected restart/reconnect passed'
    );
  } finally {
    pageSocket?.close();
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
      assert.equal(
        (await shell('window.webkit.messageHandlers.shellHosts.postMessage({action:"list"})'))
          .selected,
        original.selected
      );
      assert.equal(
        await shell("localStorage.getItem('omarchy-android-host-qa')"),
        null,
        'Fixture preferences must not leak into the original host'
      );
    } finally {
      adb('reverse', '--remove', `tcp:${port}`);
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  }
}
