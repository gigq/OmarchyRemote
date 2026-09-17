import { test, expect } from './fixtures.mjs';
test('phone wallpaper moves subtly over ten fixed workspace positions and returns with a swipe', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  const shell = p.locator('#touch-shell');
  // The wallpaper is a wider ::before layer slid by a transform: (50% - x) / 2 of its own width.
  const shift = () =>
    shell.evaluate(e => {
      const w = e.clientWidth * 1.24,
        m = new DOMMatrixReadOnly(getComputedStyle(e, '::before').transform);
      return Math.round((50 - (m.m41 / w) * 200) * 10) / 10;
    });
  await expect.poll(shift).toBe(50);
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
  await expect.poll(shift).toBe(68);
  await p.keyboard.press('Meta+Digit1');
  await expect.poll(shift).toBe(50);
  await p.mouse.move(400, 400);
  await p.mouse.down();
  await p.mouse.move(320, 400, { steps: 8 });
  await p.mouse.up();
  await expect.poll(shift).toBe(52);
  await p.mouse.move(2, 400);
  await p.mouse.down();
  await p.mouse.move(85, 400, { steps: 8 });
  await p.mouse.up();
  await expect.poll(shift).toBe(50);
  await p.setViewportSize({ width: 1194, height: 834 });
  await p.keyboard.press('Meta+Digit2');
  await expect.poll(shift).toBe(50);
  await p.setViewportSize({ width: 402, height: 874 });
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() => shell.evaluate(e => getComputedStyle(e, '::before').transitionDuration))
    .toBe('0s');
});
