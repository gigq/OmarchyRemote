import { test, expect } from './fixtures.mjs';
test('phone wallpaper moves subtly over ten fixed workspace positions and returns with a swipe', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  const shell = p.locator('#touch-shell');
  await expect(shell).toHaveCSS('background-position-x', '50%');
  // Install no fixtures into host apps: opening their shells only uses mocked requests.
  for (const key of [
    'terminal',
    'files',
    'browser',
    'herdr',
    'btop',
    'services',
    'lazydocker',
    'dua',
    'lnav',
  ]) {
    await p.keyboard.press('Meta+Digit1');
    await p.getByText(key, { exact: true }).first().click();
  }
  await expect(shell).toHaveCSS('background-position-x', '68%');
  await p.keyboard.press('Meta+Digit1');
  await expect(shell).toHaveCSS('background-position-x', '50%');
  await p.mouse.move(400, 400);
  await p.mouse.down();
  await p.mouse.move(320, 400, { steps: 8 });
  await p.mouse.up();
  await expect(shell).toHaveCSS('background-position-x', '52%');
  await p.mouse.move(2, 400);
  await p.mouse.down();
  await p.mouse.move(85, 400, { steps: 8 });
  await p.mouse.up();
  await expect(shell).toHaveCSS('background-position-x', '50%');
  await p.setViewportSize({ width: 1194, height: 834 });
  await p.keyboard.press('Meta+Digit2');
  await expect(shell).toHaveCSS('background-position-x', '50%');
  await p.setViewportSize({ width: 402, height: 874 });
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await expect(shell).toHaveCSS('transition-duration', '0s');
});
