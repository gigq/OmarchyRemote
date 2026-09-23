import fs from 'node:fs';
import path from 'node:path';
import { HOST, expect, launch, test } from './fixtures.mjs';

test('a fresh install adds a host in the picker and connects to its shell', async ({ profile }) => {
  const { app, window } = await launch(profile);
  try {
    await expect(window).toHaveURL('omarchy-app://bundle/hosts.html');
    // The desktop keeps the inline form; the phone apps use a system dialog instead.
    await window.getByLabel('Name').fill('Loopback QA');
    await window.getByLabel('Address').fill(HOST);
    await window.getByRole('button', { name: 'Save host' }).click();
    await window.getByRole('button', { name: 'Loopback QA 127.0.0.1:4187' }).click();
    await expect(window).toHaveURL(HOST + '/native/');
    await expect.poll(() => window.evaluate(() => window.__OMARCHY_PLATFORM__)).toBe('desktop');
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'device.json'), 'utf8'));
    expect(saved.directory).toEqual({
      hosts: [{ id: HOST + '/native/', url: HOST + '/native/', name: 'Loopback QA' }],
      selected: HOST + '/native/',
      disconnected: false,
    });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].title)).toBe(
      'Omarchy Remote · Loopback QA'
    );
  } finally {
    await app.close();
  }
});

test('an unreachable host returns to the picker with the reason', async ({ profile }) => {
  const { app, window } = await launch(profile, { OMARCHY_REMOTE_URL: 'http://127.0.0.1:9' });
  try {
    await expect(window).toHaveURL('omarchy-app://bundle/hosts.html');
    await expect(window.locator('#host-error')).toContainText('Could not reach 127.0.0.1:9');
  } finally {
    await app.close();
  }
});

test('embedded websites follow their tile, forward shell keys, and find text', async ({
  profile,
  website,
}) => {
  const { app, window } = await launch(profile, { OMARCHY_REMOTE_URL: HOST });
  const views = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.map(v => ({
        url: v.webContents.getURL(),
        visible: v.getVisible(),
        bounds: v.getBounds(),
      }))
    );
  const page = (script, arg) =>
    app.evaluate(
      async ({ BrowserWindow }, [script, arg]) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children[0];
        return new Function('contents', 'arg', script)(view.webContents, arg);
      },
      [script, arg]
    );
  try {
    await expect(window).toHaveURL(HOST + '/native/');
    await window.waitForFunction(() => window.HyprlandDesk);
    await window.evaluate(() => {
      window.qaStates = [];
      window.qaKeys = [];
      addEventListener('host-browser-state', e => window.qaStates.push(e.detail));
      window.HyprlandDesk.nativeKey = key => window.qaKeys.push(key);
    });
    const device = body =>
      window.evaluate(body => window.webkit.messageHandlers.browserDevice.postMessage(body), body);
    await device({ action: 'open', appID: 'webapp-qa', url: website + '/start' });
    // The shell re-sends its layout every frame, so a window the compositor resizes settles.
    const layout = () =>
      window.evaluate(() =>
        window.webkit.messageHandlers.browserDevice.postMessage({
          action: 'layout',
          appID: 'webapp-qa',
          visible: true,
          focused: false,
          rect: [120, 90, 500, 320],
          viewport: innerWidth,
          radius: 10,
        })
      );
    await expect
      .poll(async () => (await layout(), views()))
      .toEqual([
        {
          url: website + '/start',
          visible: true,
          bounds: { x: 120, y: 90, width: 500, height: 320 },
        },
      ]);
    await expect
      .poll(() => window.evaluate(() => window.qaStates.some(s => s.title === 'QA page /start')))
      .toBe(true);
    // Websites never see the host bridges.
    expect(await page('return contents.executeJavaScript("typeof window.webkit")')).toBe(
      'undefined'
    );
    // Target=_blank links stay inside the page.
    await page('return contents.executeJavaScript("document.querySelector(\'a\').click()")');
    await expect.poll(async () => (await views())[0].url).toBe(website + '/next');

    // Shell bindings typed inside a website reach the desk, including Super's Ctrl+Alt spelling.
    await window.evaluate(() =>
      window.webkit.messageHandlers.shellKeyboard.postMessage({
        commands: [
          {
            code: 'Digit2',
            meta: true,
            ctrl: false,
            alt: false,
            shift: false,
            label: 'QA 2',
            focusShell: true,
          },
        ],
      })
    );
    await page('contents.focus()');
    await page(
      "contents.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers: ['control', 'alt'] })"
    );
    await page(
      "contents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['control', 'alt'] })"
    );
    await expect
      .poll(() => window.evaluate(() => window.qaKeys.map(k => k.label)))
      .toEqual(['QA 2']);

    await device({ action: 'findOpen', appID: 'webapp-qa' });
    await expect.poll(async () => (await views()).length).toBe(2);
    await expect.poll(async () => (await views())[1].url).toMatch(/find\.html/);
    expect((await views())[1].bounds.y).toBe(98);
    const findBar = script =>
      app.evaluate(
        ({ BrowserWindow }, script) =>
          BrowserWindow.getAllWindows()[0].contentView.children[1].webContents.executeJavaScript(
            script
          ),
        script
      );
    await expect.poll(() => findBar('!!window.findBar')).toBe(true);
    await findBar(
      "const i = document.querySelector('input'); i.value = 'needle'; i.dispatchEvent(new Event('input'))"
    );
    await expect.poll(() => findBar("document.querySelector('output').textContent")).toBe('1 of 2');
    await findBar("document.querySelector('[data-action=next]').click()");
    await expect.poll(() => findBar("document.querySelector('output').textContent")).toBe('2 of 2');
    expect(await device({ action: 'findClose', appID: 'webapp-qa' })).toEqual({ closed: true });
    await expect.poll(async () => (await views()).length).toBe(1);

    await device({ action: 'snapshot', appID: 'webapp-qa' });
    await expect
      .poll(() =>
        window.evaluate(() => window.qaStates.some(s => s.preview?.startsWith('data:image/jpeg')))
      )
      .toBe(true);
    expect(await device({ action: 'dark', appID: 'webapp-qa', enabled: true })).toEqual({
      dark: true,
    });
    await expect
      .poll(() => page('return contents.executeJavaScript("!!window.DarkReader?.isEnabled()")'))
      .toBe(true);

    await device({ action: 'layout', appID: 'webapp-qa', visible: false });
    expect((await views())[0].visible).toBe(false);
    await device({ action: 'close', appID: 'webapp-qa' });
    await expect.poll(views).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Files saves through a save dialog and the weather widget falls back to a city', async ({
  profile,
}) => {
  const { app, window } = await launch(profile, { OMARCHY_REMOTE_URL: HOST });
  const target = path.join(profile, 'saved.txt');
  try {
    await expect(window).toHaveURL(HOST + '/native/');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    await window.evaluate(() =>
      navigator.share({ files: [new File(['saved from the desktop'], 'notes.txt')] })
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('saved from the desktop');
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    expect(
      await window.evaluate(() =>
        navigator.share({ files: [new File(['x'], 'x.txt')] }).catch(e => e.name)
      )
    ).toBe('AbortError');
    expect(
      await window.evaluate(() =>
        window.webkit.messageHandlers.weatherDevice
          .postMessage({ action: 'location' })
          .catch(e => e.message)
      )
    ).toBe('Location is unavailable on desktop. Choose a city instead.');
  } finally {
    await app.close();
  }
});
