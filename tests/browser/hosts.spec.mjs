import { test, expect } from './fixtures.mjs';

test('host picker saves, renames, rejects unsafe addresses, and removes hosts', async ({
  page,
}) => {
  await page.goto('/hosts.html');
  await page.getByLabel('Name', { exact: true }).fill('Second machine');
  await page.getByLabel('Address', { exact: true }).fill('https://second.example');
  await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await expect(page.locator('.host-connect')).toHaveText('1Second machinesecond.example');
  await page.reload();
  await expect(page.locator('.host-connect')).toContainText('Second machine');
  await page.getByLabel('Name', { exact: true }).fill('Renamed');
  await page.getByLabel('Address', { exact: true }).fill('https://second.example/native/');
  await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await expect(page.locator('.host-connect')).toHaveCount(1);
  await expect(page.locator('.host-connect')).toContainText('Renamed');
  await page.getByLabel('Address', { exact: true }).fill('https://user:password@secret.example');
  await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('without credentials');
  await expect(page.locator('.host-connect')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove Renamed', exact: true }).click();
  await expect(page.locator('.host-connect')).toHaveCount(0);
});

test('PWA disconnect stops the shell and can reconnect without losing preferences', async ({
  page,
}) => {
  await page.route('**/api/**', r => r.abort());
  await page.goto('/native/');
  await page.evaluate(() => {
    HyprlandUtil.storage.set('omarchy-test-draft', 'Keep my draft');
    HyprlandHosts.disconnect();
  });
  await expect(page).toHaveURL(/\/hosts.html$/);
  await expect(page.locator('#touch-shell')).toHaveCount(0);
  await expect(page.locator('.host-connect')).toHaveCount(1);
  await expect(page.locator('#host-back')).toBeHidden();
  // An installed PWA relaunches its start URL, not necessarily the last document.
  await page.goto('/');
  await expect(page).toHaveURL(/\/hosts.html$/);
  await expect(page.locator('#touch-shell')).toHaveCount(0);
  await page.locator('.host-connect').click();
  await expect(page.locator('#touch-shell')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('omarchy-test-draft'))).toBe(
    'Keep my draft'
  );
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('PWA carries its directory to another origin without carrying host preferences', async ({
  page,
  context,
}) => {
  await context.route('**/api/**', r => r.abort());
  await page.goto('/native/');
  await page.evaluate(() => {
    localStorage.setItem('omarchy-test-draft', 'Only first host');
    HyprlandHosts.manage();
  });
  await expect(page).toHaveURL(/hosts.html$/);
  await page.getByLabel('Name', { exact: true }).fill('Other origin');
  await page.getByLabel('Address', { exact: true }).fill('http://localhost:4187');
  await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await page.locator('.host-connect').filter({ hasText: 'Other origin' }).click();
  await expect(page).toHaveURL('http://localhost:4187/');
  await expect(page.locator('#touch-shell')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('omarchy-test-draft'))).toBeNull();
  await page.evaluate(() => HyprlandHosts.manage());
  await expect(page.locator('.host-connect')).toHaveCount(2);
});

test('native offline storage replaces stale host state, even when the next snapshot is empty', async ({
  page,
}) => {
  await page.goto('/hosts.html');
  await page.evaluate(() => {
    localStorage.setItem('hyper-storage-scope', 'https://first.example/native/');
    localStorage.setItem('omarchy-test-draft', 'Private to first');
    localStorage.setItem('omarchy-local-modified', '9999999999999');
    window.__OMARCHY_DEVICE__ = { scope: 'https://second.example/native/', snapshot: {} };
  });
  await page.addScriptTag({ url: '/util.js' });
  expect(await page.evaluate(() => localStorage.getItem('omarchy-test-draft'))).toBeNull();
  await page.evaluate(() => {
    window.__OMARCHY_DEVICE__ = {
      scope: 'https://first.example/native/',
      snapshot: {
        'omarchy-test-draft': 'Private to first',
        'omarchy-local-modified': '5',
      },
    };
  });
  await page.addScriptTag({ url: '/util.js' });
  expect(await page.evaluate(() => localStorage.getItem('omarchy-test-draft'))).toBe(
    'Private to first'
  );
});

test.describe('iPad host shortcuts', () => {
  test.use({ viewport: { width: 1194, height: 834 }, isMobile: false, hasTouch: false });
  test('launcher exposes hosts and Cmd Control numbers do not change workspaces', async ({
    page,
  }) => {
    await page.route('**/api/**', r => r.abort());
    await page.goto('/native/');
    await expect(page.locator('html')).toHaveClass(/desk-mode/);
    await page.evaluate(() => {
      window.hostSelections = [];
      HyprlandHosts.switchIndex = index => window.hostSelections.push(index);
    });
    await page.keyboard.press('Meta+Control+Digit2');
    await page.keyboard.press('Meta+Control+Digit0');
    expect(await page.evaluate(() => window.hostSelections)).toEqual([1, 9]);
    await expect(page.locator('.desk-ws-label:visible')).toHaveText('home');
    await page.keyboard.press('Meta+k');
    await page.getByRole('searchbox').fill('hosts');
    await expect(
      page.locator('.launcher-result').filter({ hasText: 'Manage hosts' })
    ).toBeVisible();
    await page.screenshot({ path: 'artifacts/browser/host-launcher-ipad.png' });
  });
});

test('storage mirrors keep old native builds compatible and scope new native builds', async ({
  page,
}) => {
  await page.goto('/hosts.html');
  await page.evaluate(() => {
    window.mirrors = [];
    window.webkit = {
      messageHandlers: { shellStorage: { postMessage: value => window.mirrors.push(value) } },
    };
    window.__OMARCHY_DEVICE__ = { snapshot: {} };
  });
  await page.addScriptTag({ url: '/util.js' });
  await page.evaluate(() => HyprlandUtil.storage.set('omarchy-test-draft', 'Older build'));
  expect(await page.evaluate(() => window.mirrors.at(-1)['omarchy-test-draft'])).toBe(
    'Older build'
  );
  await page.evaluate(() => {
    window.__OMARCHY_DEVICE__.scope = 'https://second.example/native/';
    HyprlandUtil.storage.set('omarchy-test-draft', 'Scoped build');
  });
  expect(await page.evaluate(() => window.mirrors.at(-1))).toMatchObject({
    scope: 'https://second.example/native/',
    values: { 'omarchy-test-draft': 'Scoped build' },
  });
});

test('native picker delegates text entry to the system dialog and renders its saved host', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const first = 'https://first.example/native/';
    window.__OMARCHY_DEVICE__ = {
      scope: first,
      hosts: {
        selected: first,
        hosts: [{ id: first, url: first, name: 'First' }],
      },
    };
    window.hostRequests = [];
    window.webkit = {
      messageHandlers: {
        shellKeyboard: { postMessage() {} },
        shellHosts: {
          async postMessage(body) {
            window.hostRequests.push(body);
            return {
              selected: first,
              hosts: [
                { id: first, url: first, name: 'First' },
                {
                  id: 'https://second.example/native/',
                  url: 'https://second.example/native/',
                  name: 'Second',
                },
              ],
            };
          },
        },
      },
    };
  });
  await page.goto('/hosts.html');
  await expect(page.locator('#host-form')).toBeHidden();
  await page.getByRole('button', { name: 'Add a host', exact: true }).click();
  await expect(page.locator('.host-connect')).toHaveCount(2);
  expect(await page.evaluate(() => window.hostRequests)).toEqual([
    { action: 'prompt', scope: 'https://first.example/native/', values: null },
  ]);
});

test('Android host and action hints distinguish Meta combinations from Ctrl+Alt aliases', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux armv8l' });
    Object.defineProperty(navigator, 'userAgent', { value: 'Android WebView' });
    window.__OMARCHY_PLATFORM__ = 'android';
  });
  await page.route('**/api/**', route => route.abort());
  await page.goto('/hosts.html');
  await expect(page.locator('footer')).toContainText('Meta+Ctrl+1–0');
  await page.getByLabel('Name', { exact: true }).fill('Shortcut fixture');
  await page.getByLabel('Address', { exact: true }).fill('https://shortcut.example');
  await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await expect(page.locator('.host-connect')).toHaveCount(1);
  expect(await page.evaluate(() => HyprlandHosts.launcherItems('shortcut fixture')[0].key)).toBe(
    'Meta+Ctrl+1'
  );
  await page.goto('/native/');
  const keys = await page.evaluate(() => {
    const format = HyprlandDesk.actionKeys;
    return [
      format({ owner: 'shell', code: 'Digit2', meta: true, ctrl: true }),
      format({ owner: 'shell', code: 'ArrowLeft', meta: true, alt: true, shift: true }),
      format({ owner: 'browser', code: 'KeyL', meta: true }),
      format({ owner: 'shell', code: 'KeyK', meta: true }),
    ];
  });
  expect(keys).toEqual(['Meta+Ctrl+2', 'Meta+Alt+Shift+←', 'Ctrl+Alt+L', 'Ctrl+Alt+K']);
  await page.keyboard.press('Control+Alt+Slash');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('physical Meta key');
  await expect(sheet).not.toContainText('iPadOS');
  await expect(sheet).not.toContainText('Ctrl+Alt Ctrl+');
  await page.screenshot({ path: 'artifacts/browser/android-shortcut-help.png' });
});
