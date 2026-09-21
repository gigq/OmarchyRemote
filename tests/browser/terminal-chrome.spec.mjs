import { test, expect } from './fixtures.mjs';
test('hardware keyboard terminal uses keyboard tabs and keeps its prompt at the top', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 1194, height: 834 });
  let id = 0;
  await p.route('**/api/terminal/session', r => r.fulfill({ json: { id: 'qa-' + ++id } }));
  await p.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(
      JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: Array.from(Buffer.from('$ ')) })
    );
    ws.onMessage(() => {});
  });
  await p.goto('/native/');
  await p.evaluate(() => {
    window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
    dispatchEvent(new Event('hyprland-hardware-keyboard'));
  });
  await p.keyboard.press('Meta+Enter');
  const root = p.locator('#remote-terminal-app');
  await expect(root.locator('.remote-status')).toBeHidden();
  await expect(root.getByRole('button', { name: 'New terminal tab' })).toBeHidden();
  await expect(root.locator('.terminal-tabs')).toBeHidden();
  const prompt = await root.locator('.remote-terminal').boundingBox(),
    frame = await root.boundingBox();
  expect(prompt.y - frame.y).toBeLessThan(1);
  await expect(root.locator('textarea.native-input')).toBeFocused();
  await expect(root.locator('.native-input-tools')).toBeHidden();
  await p.keyboard.press('Meta+t');
  await expect(root.locator('.terminal-tabs')).toBeVisible();
  await expect(root.getByRole('button', { name: '2 shell', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await p.evaluate(() => {
    window.__HYPRLAND_HARDWARE_KEYBOARD__ = false;
    dispatchEvent(new Event('hyprland-hardware-keyboard'));
  });
  await p.setViewportSize({ width: 834, height: 1194 });
  await expect(root.getByRole('button', { name: 'New terminal tab' })).toBeVisible();
  await p.setViewportSize({ width: 402, height: 874 });
  await expect(root.getByRole('button', { name: 'New terminal tab' })).toBeVisible();
});

test('Command Return focuses input without a click and preserves typing during initial connection', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 1194, height: 834 });
  let release;
  const input = [];
  await p.route('**/api/terminal/session', r => r.fulfill({ json: { id: 'qa-startup' } }));
  await p.routeWebSocket('**/api/terminal/*/ws', ws => {
    release = () => ws.send(JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: [36, 32] }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'input') input.push(m.data);
    });
  });
  await p.goto('/native/');
  await p.evaluate(() => {
    window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
    dispatchEvent(new Event('hyprland-hardware-keyboard'));
  });
  await p.keyboard.press('Meta+Enter');
  await expect(p.locator('#remote-terminal-app textarea.native-input')).toBeFocused();
  await p.keyboard.type('echo startup');
  expect(input).toEqual([]);
  await expect.poll(() => typeof release).toBe('function');
  release();
  await expect.poll(() => input.join('')).toBe('echo startup');
  await p.keyboard.type(' ready');
  await expect.poll(() => input.join('')).toBe('echo startup ready');
  await p.keyboard.press('Meta+BracketLeft');
  await p.keyboard.press('Meta+Enter');
  await expect(p.locator('#remote-terminal-app textarea.native-input')).toBeFocused();
});
