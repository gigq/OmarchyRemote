import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, expect, launch, test } from './fixtures.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const titles = app =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map(w => [w.getTitle(), w.webContents.getURL()])
      .sort()
  );

test('--app opens one app in its own window, and launching again adds windows', async ({
  profile,
}) => {
  const env = { OMARCHY_REMOTE_URL: HOST };
  const { app, window } = await launch(profile, env, ['--app=codexbar']);
  try {
    await expect(window).toHaveURL(HOST + '/native/?app=codexbar');
    await expect.poll(() => titles(app)).toEqual([['CodexBar', HOST + '/native/?app=codexbar']]);
    await expect
      .poll(() => window.evaluate(() => document.documentElement.classList.contains('solo-mode')))
      .toBe(true);

    // A second launch, as from a launcher entry, hands its window to the running client.
    const second = spawn(
      process.env.OMARCHY_DESKTOP_EXECUTABLE || createRequire(import.meta.url)('electron'),
      [
        ...(process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
        ...(process.env.OMARCHY_DESKTOP_EXECUTABLE ? [] : [desktop]),
        '--app=herdr',
      ],
      { env: { ...process.env, OMARCHY_USER_DATA: profile, ...env }, stdio: 'ignore' }
    );
    await new Promise(resolve => second.on('exit', resolve));
    await expect
      .poll(() => titles(app))
      .toEqual([
        ['CodexBar', HOST + '/native/?app=codexbar'],
        [process.platform === 'darwin' ? 'Herdr' : 'herdr', HOST + '/native/?app=herdr'],
      ]);

    // The same app is focused rather than duplicated; the shell bridge opens the full shell too.
    await window.evaluate(() =>
      window.webkit.messageHandlers.shellWindows.postMessage({ action: 'open', app: 'herdr' })
    );
    await expect.poll(async () => (await titles(app)).length).toBe(2);
    expect(
      await window.evaluate(() =>
        window.webkit.messageHandlers.shellWindows
          .postMessage({ action: 'open', app: '../x' })
          .catch(e => e.message)
      )
    ).toBe('Unsupported app');
  } finally {
    await app.close();
  }
  // Window sizes are remembered per app.
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'device.json'), 'utf8'));
  expect(Object.keys(saved.bounds).sort()).toEqual(['codexbar', 'herdr']);
});

test('Settings adds and removes Linux launcher entries for an app', async ({ profile }) => {
  test.skip(process.platform !== 'linux', 'Launcher entries are Linux desktop files');
  const data = path.join(profile, 'data');
  const { app, window } = await launch(profile, { OMARCHY_REMOTE_URL: HOST, XDG_DATA_HOME: data });
  const file = path.join(data, 'applications/omarchy-remote-herdr.desktop');
  try {
    await expect(window).toHaveURL(HOST + '/native/');
    await window.waitForFunction(() => window.HyprlandDesk);
    await window.keyboard.press('Control+Alt+Comma');
    const settings = window.locator('.solo-settings');
    await expect(settings).toBeVisible();
    const add = settings.getByRole('button', { name: 'Add herdr to the app launcher' });
    await add.click();
    await expect(
      settings.getByRole('button', { name: 'Remove herdr from the app launcher' })
    ).toHaveAttribute('aria-pressed', 'true');
    const entry = fs.readFileSync(file, 'utf8');
    expect(entry).toContain('Name=herdr\n');
    expect(entry).toMatch(/^Exec=.* --app=herdr$/m);
    expect(entry).toContain('Comment=herdr on 127.0.0.1, through Omarchy Remote');
    await settings.getByRole('button', { name: 'Remove herdr from the app launcher' }).click();
    await expect(add).toHaveAttribute('aria-pressed', 'false');
    expect(fs.existsSync(file)).toBe(false);

    await settings.getByRole('button', { name: 'Open herdr in its own window' }).click();
    await expect
      .poll(async () => (await titles(app)).map(([title]) => title))
      .toContain(process.platform === 'darwin' ? 'Herdr' : 'herdr');
  } finally {
    await app.close();
  }
});

test('a theme chosen in the Settings window repaints the other app windows', async ({
  profile,
}) => {
  const { app, window: settings } = await launch(profile, { OMARCHY_REMOTE_URL: HOST }, [
    '--app=settings',
  ]);
  try {
    await expect(settings).toHaveURL(HOST + '/native/?app=settings');
    await settings.evaluate(() =>
      window.webkit.messageHandlers.shellWindows.postMessage({ action: 'open', app: 'codexbar' })
    );
    await expect.poll(() => app.windows().length).toBe(2);
    const codexbar = app.windows().find(w => w !== settings);
    await expect(codexbar).toHaveURL(HOST + '/native/?app=codexbar');
    const theme = page => page.evaluate(() => document.documentElement.dataset.theme);
    const current = await theme(codexbar);
    const next = await settings
      .locator(`[data-theme-choice]:not([data-theme-choice="${current}"])`)
      .first()
      .getAttribute('data-theme-choice');
    await settings.locator(`[data-theme-choice="${next}"]`).click();
    await expect.poll(() => theme(codexbar)).toBe(next);
  } finally {
    await app.close();
  }
});

test('macOS single-app windows close with Command-W before the shell consumes it', async ({
  profile,
}) => {
  test.skip(process.platform !== 'darwin', 'macOS window shortcut');
  const { app, window } = await launch(profile, { OMARCHY_REMOTE_URL: HOST }, ['--app=codexbar']);
  try {
    await expect(window).toHaveURL(HOST + '/native/?app=codexbar');
    await expect(window.locator('html')).toHaveClass(/solo-mode/);
    const closed = app.waitForEvent('close');
    // Native menu accelerators and before-input-event use Electron input, not CDP input.
    await app
      .evaluate(({ BrowserWindow }) => {
        const native = BrowserWindow.getAllWindows()[0];
        native.show();
        native.focus();
        native.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
      })
      .catch(error => {
        if (!/closed|destroyed/.test(error.message)) throw error;
      });
    await closed;
  } finally {
    await app.close().catch(() => {});
  }
});

test('the Mac drag strip overlays 25 pixels while leaving controls clickable', async ({
  profile,
}) => {
  test.skip(process.platform !== 'darwin', 'macOS titlebar dragging');
  const { app, window } = await launch(profile, { OMARCHY_REMOTE_URL: HOST }, ['--app=codexbar']);
  try {
    await expect(window.locator('html')).toHaveClass(/solo-mode/);
    await window.waitForFunction(
      () => document.querySelector('#touch-shell')?.getBoundingClientRect().width > 0
    );
    await expect
      .poll(() =>
        window.evaluate(() => getComputedStyle(document.documentElement, '::before').height)
      )
      .toBe('25px');
    const geometry = await window.evaluate(() => {
      const shell = document.querySelector('#touch-shell').getBoundingClientRect();
      const layer = getComputedStyle(document.documentElement, '::before');
      const button = document.createElement('button');
      button.textContent = 'Drag QA';
      button.style.cssText = 'position:fixed;top:5px;left:5px;width:80px;height:30px;z-index:1';
      button.onclick = () => {
        document.documentElement.dataset.dragQaClicked = 'yes';
      };
      document.body.append(button);
      const control = getComputedStyle(button);
      const bounds = button.getBoundingClientRect();
      return {
        shellTop: shell.top,
        stripHeight: layer.height,
        pointerEvents: layer.pointerEvents,
        drag: layer.webkitAppRegion,
        controlDrag: control.webkitAppRegion,
        controlTop: bounds.top,
        hit: document.elementFromPoint(20, 15) === button,
      };
    });
    expect(geometry).toEqual({
      shellTop: 0,
      stripHeight: '25px',
      pointerEvents: 'none',
      drag: 'drag',
      controlDrag: 'no-drag',
      controlTop: 5,
      hit: true,
    });
    await window.getByRole('button', { name: 'Drag QA', exact: true }).click();
    await expect(window.locator('html')).toHaveAttribute('data-drag-qa-clicked', 'yes');
  } finally {
    await app.close();
  }
});
