import { test, expect } from './fixtures.mjs';
test.use({ viewport: { width: 1194, height: 834 }, isMobile: false, hasTouch: false });
test('focus preference defaults off and survives reload', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.goto('/native/');
  await page.keyboard.press('Meta+Comma');
  const option = page.getByRole('checkbox', { name: 'Focus follows pointer' });
  await expect(option).not.toBeChecked();
  await option.check();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('omarchy-focus-follows-pointer')))
    .toBe('true');
  await page.reload();
  await expect(option).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => HyprlandPreferences.keys.includes('omarchy-focus-follows-pointer'))
    )
    .toBe(true);
});
