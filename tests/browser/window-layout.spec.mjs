import { test, expect } from './fixtures.mjs';
test.use({ viewport: { width: 1194, height: 834 }, isMobile: false, hasTouch: false });
const frame = (p, key) => p.locator(`[data-workspace="${key}"]`).last();
const rect = async (p, key) => {
  await p.waitForTimeout(400);
  return frame(p, key).boundingBox();
};
const boot = async p => {
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await p.keyboard.press('Meta+Enter');
  await p.keyboard.press('Meta+Shift+Enter');
  await expect(p.locator('.desk-divider')).toHaveCount(1);
};
async function drag(p, x, y, dx, dy, button = 'left', modifier = false) {
  if (modifier) await p.keyboard.down('Meta');
  await p.mouse.move(x, y);
  await p.mouse.down({ button });
  await p.mouse.move(x + dx, y + dy, { steps: 8 });
  await p.mouse.up({ button });
  if (modifier) await p.keyboard.up('Meta');
}
test('divider resize persists, modifier resize works, and modifier move swaps tiles', async ({
  page: p,
}) => {
  await boot(p);
  const original = await rect(p, 'terminal');
  const divider = await p.locator('.desk-divider').boundingBox();
  await drag(p, divider.x + divider.width / 2, divider.y + 60, 140, 0);
  expect((await rect(p, 'terminal')).width).toBeGreaterThan(original.width + 120);
  await p.reload();
  const resized = await rect(p, 'terminal');
  expect(resized.width).toBeGreaterThan(original.width + 120);
  await drag(p, resized.x + resized.width - 70, resized.y + 100, -80, 0, 'right', true);
  expect((await rect(p, 'terminal')).width).toBeLessThan(resized.width - 60);
  const a = await rect(p, 'terminal'),
    b = await rect(p, 'browser');
  await drag(p, a.x + 50, a.y + 100, b.x - a.x + 30, 0, 'left', true);
  expect((await rect(p, 'terminal')).x).toBeGreaterThan((await rect(p, 'browser')).x);
  await expect(p.locator('.desk-dragging')).toHaveCount(0);
  await p.screenshot({ path: 'artifacts/browser/window-layout.png' });
});
test('layout selection and split direction survive reload; fullscreen hides handles', async ({
  page: p,
}) => {
  await boot(p);
  await p.keyboard.press('Meta+Comma');
  const option = p.getByRole('combobox', { name: 'Window layout' });
  await expect(option).toHaveValue('dwindle');
  await option.selectOption('master');
  await p.reload();
  await expect(option).toHaveValue('master');
  await option.selectOption('dwindle');
  await p.getByRole('button', { name: 'Toggle active split direction', exact: true }).click();
  const first = await rect(p, 'browser'),
    settings = await rect(p, 'settings');
  expect(settings.x).toBeGreaterThan(first.x);
  await p.reload();
  expect((await rect(p, 'settings')).x).toBeGreaterThan((await rect(p, 'browser')).x);
  await p.keyboard.press('Meta+f');
  await expect(p.locator('.desk-divider')).toHaveCount(0);
});
test('native drag bridge follows same resizing and cancellation path', async ({ page: p }) => {
  await boot(p);
  const before = await rect(p, 'browser');
  await p.evaluate(({ x, y }) => {
    HyprlandDesk.nativePointer({ phase: 'begin', x: x + 30, y: y + 80, button: 2 });
    HyprlandDesk.nativePointer({ phase: 'move', x: x + 120, y: y + 80, button: 2 });
    HyprlandDesk.nativePointer({ phase: 'end', x: x + 120, y: y + 80, button: 2 });
  }, before);
  expect((await rect(p, 'browser')).width).toBeLessThan(before.width - 70);
  await expect(p.locator('.desk-dragging')).toHaveCount(0);
});
