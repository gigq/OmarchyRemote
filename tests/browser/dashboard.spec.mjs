import { test, expect } from './fixtures.mjs';
import { captureTerminals } from './terminal-helper.mjs';
async function launcher(page) {
  const center = page.viewportSize().width / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: center, y: 30 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: center, y: 180 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(page.getByRole('searchbox', { name: 'Search apps, panes and files' })).toBeFocused();
}
test('native launcher opens an app and a pane from Home', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/native/');
  await launcher(page);
  const input = page.getByRole('searchbox', { name: 'Search apps, panes and files' });
  await input.fill('files');
  await page
    .locator('.launcher-result')
    .filter({ has: page.getByText('files', { exact: true }) })
    .first()
    .click();
  await expect(page.locator('#remote-files-app .files-path')).toBeVisible();
  await launcher(page);
  await input.fill('@');
  await expect(page.locator('.launcher-result').first()).toBeVisible();
  await page.locator('.launcher-result').first().click();
  await expect(page.locator('.herdr-detail')).toBeVisible();
  expect(errors).toEqual([]);
});
test('terminal tabs isolate sessions and close the selected shell', async ({ page }) => {
  await captureTerminals(page);
  await page.goto('/native/');
  await page.getByText('terminal', { exact: true }).first().click();
  await expect(page.locator('.terminal-tab:visible')).toContainText('· connected');
  const first = await page.evaluate(() => localStorage.getItem('omarchy-terminal-id'));
  await page.getByRole('button', { name: 'New terminal tab' }).click();
  await expect(page.locator('.terminal-tab:visible')).toContainText('· connected');
  const second = await page.evaluate(() =>
    localStorage.getItem(localStorage.getItem('omarchy-terminal-active'))
  );
  expect(first).not.toBe(second);
  await page.getByRole('button', { name: '1 shell', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('omarchy-terminal-active'))).toBe(
    'omarchy-terminal-id'
  );
  await page.getByRole('button', { name: '2 shell', exact: true }).click();
  await page.getByRole('button', { name: 'Close terminal tab' }).click();
  await page.getByRole('button', { name: 'Close shell', exact: true }).click();
  await expect(page.locator('.terminal-tab')).toHaveCount(1);
  const response = await page.request.post('/api/terminal/' + first + '/close', {
    headers: { 'X-Hyprland-Client': '1' },
    data: {},
  });
  expect(response.ok()).toBeTruthy();
});
test('snippet is a reviewable draft and does not execute', async ({ page }) => {
  await captureTerminals(page);
  await page.goto('/native/');
  await launcher(page);
  await page.getByRole('searchbox', { name: 'Search apps, panes and files' }).fill('>uptime');
  await page.getByRole('button', { name: 'uptime Review and send' }).click();
  await expect(page.getByRole('textbox', { name: 'Message to host' })).toHaveValue('uptime');
  await expect(page.locator('.terminal-tab:visible')).toContainText('· connected');
});
test('Herd search sits first and narrows the pane list', async ({ page }) => {
  await page.goto('/native/');
  await page.getByText('herdr', { exact: true }).first().click();
  await expect(page.locator('.herdr-pane').first()).toBeVisible();
  await expect(page.locator('.herdr-filters')).toHaveCount(0);
  const first = await page
    .locator('#remote-herdr-app > *:visible')
    .evaluateAll(ns => ns.map(n => n.className).filter(c => !c.includes('herdr-connection'))[0]);
  expect(first).toContain('herdr-search-field');
  await page.getByRole('searchbox', { name: 'Search panes' }).fill('no-such-pane-8811');
  await expect(page.locator('.herdr-list')).toContainText('No matching panes.');
});
test('Home pins persist without removing apps from the launcher', async ({ page }) => {
  await page.goto('/native/');
  await page.getByRole('button', { name: 'Manage pinned apps' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pinned apps' });
  await dialog.getByRole('button', { name: 'lnav', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.home-app-grid').getByText('lnav', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.home-app-grid').getByText('lnav', { exact: true })).toHaveCount(0);
  await launcher(page);
  await page.getByRole('searchbox', { name: 'Search apps, panes and files' }).fill('lnav');
  await expect(page.locator('.launcher-result').getByText('lnav', { exact: true })).toBeVisible();
});
for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
]) {
  test(`top corners have no shell panes at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/**', route => route.abort());
    await page.goto('/native/');
    await expect(page.locator('#touch-shell')).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    for (const x of [40, viewport.width - 40]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: 30 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: 180 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.locator('.shell-shade, #dashboard-notifications')).toHaveCount(0);
      await expect(
        page.getByRole('searchbox', { name: 'Search apps, panes and files' })
      ).not.toBeVisible();
    }
    await cdp.detach();
    await launcher(page);
    await expect(page.getByRole('searchbox')).toBeFocused();
  });
}
