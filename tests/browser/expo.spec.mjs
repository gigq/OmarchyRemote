import { test, expect } from './fixtures.mjs';
const card = (p, k) => p.locator(`[data-workspace="${k}"]`).last();
async function expo(p) {
  await p.locator('#touch-shell > div').first().locator('[data-dc-tpl="10"]').last().click();
  await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);
  await p.waitForTimeout(500);
}
async function drag(p, from, to, hold = 0) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  if (hold) await p.waitForTimeout(hold);
  await p.mouse.move(to.x, to.y, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(550);
}
const center = async el => {
  const r = await el.boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
const frame = async el => {
  const r = await el.boundingBox();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};
const area = r => r.width * r.height;
const bottomCenter = async p => {
  const r = await p.locator('#touch-shell').boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height - 4 };
};

test('bottom-center Expo entry follows a held finger and settles at the overview endpoint', async ({
  page: p,
}) => {
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await p.getByText('settings', { exact: true }).first().click();
  await p.waitForTimeout(600);
  const shell = p.locator('#touch-shell');
  const settings = card(p, 'settings');
  const start = await frame(settings);
  const point = await bottomCenter(p);
  await p.mouse.move(point.x, point.y);
  await p.mouse.down();
  await p.waitForTimeout(180);
  const held = await frame(settings);
  expect(held.x).toBeCloseTo(start.x, 0);
  expect(held.y).toBeCloseTo(start.y, 0);
  expect(held.width).toBeCloseTo(start.width, 0);
  expect(held.height).toBeCloseTo(start.height, 0);

  await p.mouse.move(point.x, point.y - 70, { steps: 3 });
  await expect(shell).toHaveClass(/expo-tracking/);
  await expect(shell).toHaveClass(/expo-mode/);
  await p.waitForTimeout(70);
  const middle = await frame(settings);
  expect(area(middle)).toBeLessThan(area(start) * 0.95);
  await expect(settings.locator(':scope > .workspace-label')).toHaveCSS('opacity', '0');
  await p.screenshot({ path: 'artifacts/browser/expo-finger-phone-intermediate.png' });
  await p.waitForTimeout(180);
  const stationary = await frame(settings);
  expect(stationary.x).toBeCloseTo(middle.x, 0);
  expect(stationary.y).toBeCloseTo(middle.y, 0);
  expect(stationary.width).toBeCloseTo(middle.width, 0);
  expect(stationary.height).toBeCloseTo(middle.height, 0);

  await p.mouse.move(point.x, point.y - 190, { steps: 5 });
  await p.waitForTimeout(70);
  const further = await frame(settings);
  expect(area(further)).toBeLessThan(area(middle) * 0.85);
  const lateFrame = await settings.evaluate(card => {
    const label = card.querySelector(':scope > .workspace-label');
    const labelStyle = getComputedStyle(label);
    const frameStyle = getComputedStyle(card, '::after');
    return {
      labelOpacity: Number(labelStyle.opacity),
      labelTop: parseFloat(labelStyle.top),
      labelLeft: parseFloat(labelStyle.left),
      labelRight: parseFloat(labelStyle.right),
      frameTop: parseFloat(frameStyle.top),
      frameLeft: parseFloat(frameStyle.left),
      frameRight: parseFloat(frameStyle.right),
    };
  });
  expect(lateFrame.labelOpacity).toBeGreaterThan(0);
  expect(lateFrame.labelTop).toBeGreaterThan(lateFrame.frameTop);
  expect(lateFrame.labelLeft).toBeGreaterThan(lateFrame.frameLeft);
  expect(lateFrame.labelRight).toBeGreaterThan(lateFrame.frameRight);
  await p.mouse.move(point.x, point.y - 70, { steps: 5 });
  await p.waitForTimeout(70);
  const retreat = await frame(settings);
  expect(area(retreat)).toBeGreaterThan(area(further) * 1.1);
  await p.mouse.move(point.x, point.y - 210, { steps: 5 });
  await p.mouse.up();
  await expect(shell).toHaveClass(/expo-mode/);
  await expect(shell).not.toHaveClass(/expo-tracking/);
  const endpoint = await frame(settings);
  expect(area(endpoint)).toBeLessThan(area(further));
  await p.screenshot({ path: 'artifacts/browser/expo-finger-phone-endpoint.png' });
});

test('short bottom-center release and pointer cancellation restore the workspace endpoint', async ({
  page: p,
}) => {
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await p.getByText('settings', { exact: true }).first().click();
  await p.waitForTimeout(600);
  const shell = p.locator('#touch-shell');
  const settings = card(p, 'settings');
  const expected = await frame(settings);
  const point = await bottomCenter(p);

  await p.mouse.move(point.x, point.y);
  await p.mouse.down();
  await p.mouse.move(point.x, point.y - 70, { steps: 3 });
  await expect(shell).toHaveClass(/expo-tracking/);
  await p.waitForTimeout(140);
  await p.mouse.up();
  await expect(shell).not.toHaveClass(/expo-tracking/);
  await expect(shell).not.toHaveClass(/expo-mode/);
  const released = await frame(settings);
  expect(released.x).toBeCloseTo(expected.x, 0);
  expect(released.y).toBeCloseTo(expected.y, 0);
  expect(released.width).toBeCloseTo(expected.width, 0);
  expect(released.height).toBeCloseTo(expected.height, 0);
  await p.waitForTimeout(100);
  const settled = await frame(settings);
  expect(settled.x).toBeCloseTo(expected.x, 0);
  expect(settled.y).toBeCloseTo(expected.y, 0);
  expect(settled.width).toBeCloseTo(expected.width, 0);
  expect(settled.height).toBeCloseTo(expected.height, 0);

  await p.mouse.move(point.x, point.y);
  await p.mouse.down();
  await p.mouse.move(point.x, point.y - 100, { steps: 3 });
  await expect(shell).toHaveClass(/expo-tracking/);
  await shell.dispatchEvent('pointercancel');
  await expect(shell).not.toHaveClass(/expo-tracking/);
  await expect(shell).not.toHaveClass(/expo-mode/);
  const cancelled = await frame(settings);
  expect(cancelled.x).toBeCloseTo(expected.x, 0);
  expect(cancelled.y).toBeCloseTo(expected.y, 0);
  expect(cancelled.width).toBeCloseTo(expected.width, 0);
  expect(cancelled.height).toBeCloseTo(expected.height, 0);
  await p.mouse.up();
});

test('bottom corners remain outside the Expo entry gesture', async ({ page: p }) => {
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await p.getByText('settings', { exact: true }).first().click();
  await p.waitForTimeout(600);
  const shell = p.locator('#touch-shell');
  const box = await shell.boundingBox();
  for (const x of [box.x + 12, box.x + box.width - 12]) {
    const y = box.y + box.height - 4;
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x, y - 210, { steps: 5 });
    await p.waitForTimeout(80);
    await expect(shell).not.toHaveClass(/expo-tracking/);
    await expect(shell).not.toHaveClass(/expo-mode/);
    await p.mouse.up();
  }
});

test('bottom-center Expo entry scrubs correctly on a tablet desk', async ({ page: p }) => {
  await p.setViewportSize({ width: 1194, height: 834 });
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await expect(p.locator('html')).toHaveClass(/desk-mode/);
  const shell = p.locator('#touch-shell');
  const home = card(p, 'home');
  const start = await frame(home);
  const point = await bottomCenter(p);
  await p.mouse.move(point.x, point.y);
  await p.mouse.down();
  await p.mouse.move(point.x, point.y - 110, { steps: 4 });
  await expect(shell).toHaveClass(/expo-tracking/);
  await expect(shell).toHaveClass(/expo-mode/);
  await p.waitForTimeout(70);
  const middle = await frame(home);
  expect(area(middle)).toBeLessThan(area(start) * 0.95);
  await p.screenshot({ path: 'artifacts/browser/expo-finger-tablet-intermediate.png' });
  await p.mouse.move(point.x, point.y - 220, { steps: 5 });
  await p.mouse.up();
  await expect(shell).toHaveClass(/expo-mode/);
  await expect(shell).not.toHaveClass(/expo-tracking/);
  const endpoint = await frame(home);
  expect(area(endpoint)).toBeLessThan(area(middle));
});

test('Home-only startup, toss dismissal, long press reorder and protected Home', async ({
  page: p,
}) => {
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await expect(card(p, 'terminal')).toHaveCSS('opacity', '0');
  await expect(card(p, 'firefox')).toHaveCount(0);
  await expect(card(p, 'phone')).toHaveCount(0);
  await p.getByText('settings', { exact: true }).first().click();
  await expo(p);
  let a = await center(card(p, 'settings'));
  await drag(p, a, { x: a.x, y: a.y - 30 });
  await expect(card(p, 'settings')).toHaveCSS('opacity', '0.95');
  await drag(p, a, { x: a.x, y: a.y - 115 });
  await expect(card(p, 'settings')).toHaveCSS('opacity', '0');
  await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);
  a = await center(card(p, 'home'));
  await drag(p, a, { x: a.x, y: a.y - 115 });
  await expect(card(p, 'home')).toHaveCSS('opacity', '0.95');
  await card(p, 'home').click();
  await p.getByText('files', { exact: true }).first().click();
  await expo(p);
  await card(p, 'home').click();
  await p.getByText('settings', { exact: true }).first().click();
  await expo(p);
  const files = await center(card(p, 'files')),
    settings = await center(card(p, 'settings'));
  await p.mouse.move(settings.x, settings.y);
  await p.mouse.down();
  await p.waitForTimeout(500);
  await p.mouse.move(files.x, files.y, { steps: 10 });
  await p.locator('#touch-shell').dispatchEvent('pointercancel');
  await p.mouse.up();
  await p.waitForTimeout(550);
  await expect
    .poll(async () => Math.round((await center(card(p, 'settings'))).y))
    .toBe(Math.round(settings.y));
  await drag(p, settings, files, 500);
  await expect
    .poll(async () => Math.round((await card(p, 'settings').boundingBox()).x))
    .toBe(Math.round(files.x - (await card(p, 'settings').boundingBox()).width / 2));
  await card(p, 'settings').click();
  await expect(p.locator('#touch-shell')).not.toHaveClass(/expo-mode/);
  await expect(p.locator('.theme-settings')).toBeVisible();
});
test('dismissing Terminal closes its session and reopening starts a fresh shell', async ({
  page: p,
}) => {
  await p.goto('/native/');
  await p.getByText('terminal', { exact: true }).first().click();
  await expect(p.locator('#remote-terminal-app')).toContainText('· connected');
  const first = await p.evaluate(() => localStorage.getItem('omarchy-terminal-id'));
  await expo(p);
  const a = await center(card(p, 'terminal'));
  await drag(p, a, { x: a.x, y: a.y - 120 });
  await expect(card(p, 'terminal')).toHaveCSS('opacity', '0');
  await expect.poll(() => p.evaluate(() => localStorage.getItem('omarchy-terminal-id'))).toBeNull();
  await card(p, 'home').click();
  await p.getByText('terminal', { exact: true }).first().click();
  await expect(p.locator('#remote-terminal-app')).toContainText('· connected');
  expect(await p.evaluate(() => localStorage.getItem('omarchy-terminal-id'))).not.toBe(first);
});
