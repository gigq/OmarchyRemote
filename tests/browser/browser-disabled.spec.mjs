import { test, expect } from './fixtures.mjs';
// The Browser app is switched off while it is reworked; its code stays behind a local setting.
test('Browser is hidden by default and returns with the experimental setting', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 1194, height: 834 });
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  const home = p.locator('.home-app-grid').last();
  await expect(home.getByText('files', { exact: true })).toBeVisible();
  await expect(home.getByText('browser', { exact: true })).toHaveCount(0);
  expect(await p.evaluate(() => HyprlandApps.get('browser'))).toBeNull();
  // Its shortcut does nothing and the launcher does not offer it.
  await p.keyboard.press('Meta+Shift+B');
  await expect(p.locator('.browser-app')).toHaveCount(0);
  await p.keyboard.press('Meta+k');
  const search = p.getByRole('searchbox', { name: 'Search apps, panes and files' });
  await search.fill('browser');
  await expect(p.locator('#dashboard-launcher').getByText('desktop browser tabs')).toHaveCount(0);

  await p.evaluate(() => localStorage.setItem('omarchy-experimental-browser', '1'));
  await p.reload();
  await expect(
    p.locator('.home-app-grid').last().getByText('browser', { exact: true })
  ).toBeVisible();
  expect(await p.evaluate(() => HyprlandApps.get('browser')?.provider != null)).toBe(true);
});
