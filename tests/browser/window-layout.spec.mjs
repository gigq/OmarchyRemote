import { test, expect } from './fixtures.mjs';
test.use({ viewport: { width: 1194, height: 834 }, isMobile: false, hasTouch: false });
const frame = (p, key) => p.locator(`[data-workspace="${key}"]`).last();
const rect = async (p, key) => {
  await p.waitForTimeout(650);
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
test('previous workspace follows actual navigation and silent moves keep the source focused', async ({
  page: p,
}) => {
  await boot(p);
  await p.keyboard.press('Meta+Shift+Digit3');
  await p.keyboard.press('Meta+Digit2');
  await p.keyboard.press('Meta+Shift+KeyP');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('browser');
  await p.keyboard.press('Meta+Shift+KeyP');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
  await p.keyboard.press('Meta+Shift+KeyX');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('home');
  await p.keyboard.press('Meta+Digit2');
  await expect(p.locator('.desk-divider')).toHaveCount(1);
});
test('action palette filters and executes without losing window focus; registry has no conflicts', async ({
  page: p,
}) => {
  await boot(p);
  await p.keyboard.press('Meta+Shift+K');
  const search = p.getByRole('searchbox', { name: 'Search actions', exact: true });
  await expect(search).toBeFocused();
  await p.screenshot({ path: 'artifacts/browser/action-palette.png' });
  await p.keyboard.type('toggle split');
  await expect(p.locator('.desk-action-row')).toHaveCount(1);
  await search.press('Enter');
  await expect(p.getByRole('dialog', { name: 'Actions', exact: true })).toHaveCount(0);
  const a = await rect(p, 'terminal'),
    b = await rect(p, 'browser');
  expect(a.y + a.height).toBeLessThan(b.y);
  const duplicates = await p.evaluate(() => {
    const keys = HyprlandDesk.actions()
      .filter(a => a.code)
      .map(a => JSON.stringify([a.code, a.meta, a.ctrl, a.alt, a.shift]));
    return keys.length - new Set(keys).size;
  });
  expect(duplicates).toBe(0);
  await p.keyboard.press('Meta+Shift+K');
  await search.fill('workspace 3 without following');
  await search.press('Enter');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
});
test('scratchpad hides without closing, follows workspace, and returns to tiling', async ({
  page: p,
}) => {
  await boot(p);
  await p.keyboard.press('Meta+Shift+S');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
  await expect(frame(p, 'browser')).toHaveCSS('opacity', '0');
  await p.keyboard.press('Meta+Digit1');
  await p.keyboard.press('Meta+S');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('browser');
  const floating = await rect(p, 'browser');
  expect(floating.width).toBeLessThan(1100);
  expect(floating.x).toBeGreaterThan(50);
  await drag(p, floating.x + 50, floating.y + 100, 30, 25, 'left', true);
  expect((await rect(p, 'browser')).x).toBeCloseTo(floating.x + 30, 0);
  await p.keyboard.press('Meta+S');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('home');
  await p.reload();
  await p.keyboard.press('Meta+S');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('browser');
  await p.keyboard.press('Meta+Shift+S');
  await expect(frame(p, 'browser')).not.toHaveClass(/desk-scratchpad/);
  expect((await rect(p, 'browser')).width).toBeGreaterThan(1100);
});
async function action(p, label) {
  await p.keyboard.press('Meta+Shift+K');
  const search = p.getByRole('searchbox', { name: 'Search actions', exact: true });
  await search.fill(label);
  await p.getByRole('button', { name: label, exact: true }).click();
}
test('independent terminal windows survive reload and closing one does not close another session', async ({
  page: p,
}) => {
  const sessions = [],
    closed = [];
  await p.route('**/api/**', async r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/terminal/session') {
      const data = r.request().postDataJSON();
      const id = data.id || 'test-' + (sessions.length + 1);
      sessions.push(id);
      await r.fulfill({ json: { id } });
    } else if (url.pathname.endsWith('/close')) {
      closed.push(url.pathname);
      await r.fulfill({ json: { ok: true } });
    } else await r.abort();
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Enter');
  await action(p, 'New terminal window');
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('omarchy-layout-desk')));
  const key = Object.keys(stored.instances)[0];
  expect(key).toMatch(/^window-/);
  await expect.poll(() => sessions.length).toBe(2);
  expect(new Set(sessions).size).toBe(2);
  const cloneTabs = await p.evaluate(
    k => JSON.parse(localStorage.getItem('omarchy-' + k + '-tabs')),
    key
  );
  const originalTabs = await p.evaluate(() =>
    JSON.parse(localStorage.getItem('omarchy-terminal-tabs'))
  );
  expect(cloneTabs[0]).not.toBe(originalTabs[0]);
  await p.reload();
  await expect.poll(() => sessions.length).toBe(4);
  expect(new Set(sessions).size).toBe(2);
  await p.keyboard.press('Meta+W');
  await expect.poll(() => closed.length).toBe(1);
  expect(closed[0]).toContain('test-2');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
});
test('group tabs select independent windows, persist, and can be separated', async ({
  page: p,
}) => {
  await boot(p);
  await action(p, 'Group window with next tile');
  const bar = frame(p, 'browser').locator('.desk-window-tabs');
  await expect(bar).toBeVisible();
  await p.waitForTimeout(650);
  const barBox = await bar.boundingBox();
  const contentBox = await frame(p, 'browser').locator('.browser-app').boundingBox();
  expect(contentBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height + 5);
  await p.screenshot({ path: 'artifacts/browser/window-group.png' });
  await expect(p.locator('.desk-divider')).toHaveCount(0);
  await bar.getByRole('button', { name: 'terminal', exact: true }).click();
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
  await p.reload();
  await expect(frame(p, 'terminal').locator('.desk-window-tabs')).toBeVisible();
  await expect(frame(p, 'browser')).toHaveCSS('opacity', '0');
  await frame(p, 'terminal')
    .locator('.desk-window-tabs')
    .getByRole('button', { name: 'browser', exact: true })
    .click();
  await p.keyboard.press('Meta+Digit1');
  await p.keyboard.press('Meta+Digit2');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('browser');
  await expect(frame(p, 'browser')).toHaveAttribute('data-active', 'true');
  await action(p, 'Remove window from group');
  await expect(p.locator('.desk-divider')).toHaveCount(1);
  await expect(frame(p, 'terminal').locator('.desk-window-tabs')).toHaveCount(0);
});
test('Files instances keep independent folders and restore them', async ({ page: p }) => {
  await p.route('**/api/**', r => {
    const url = new URL(r.request().url());
    if (url.pathname === '/api/files') {
      const path = url.searchParams.get('path') || '/home/test';
      return r.fulfill({
        json: {
          path,
          root: '/home/test',
          parent: path === '/home/test' ? '/home' : '/home/test',
          entries:
            path === '/home/test'
              ? [{ name: 'Documents', path: '/home/test/Documents', directory: true, size: 0 }]
              : [],
        },
      });
    }
    return r.abort();
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+F');
  await expect(frame(p, 'files').locator('.files-path')).toHaveAttribute('data-path', '/home/test');
  await action(p, 'New files window');
  const key = await p.evaluate(
    () => Object.keys(JSON.parse(localStorage.getItem('omarchy-layout-desk')).instances)[0]
  );
  await frame(p, key)
    .getByRole('button', { name: /Documents/ })
    .click();
  await expect(frame(p, key).locator('.files-path')).toHaveAttribute(
    'data-path',
    '/home/test/Documents'
  );
  await expect(frame(p, 'files').locator('.files-path')).toHaveAttribute('data-path', '/home/test');
  await p.reload();
  await expect(frame(p, key).locator('.files-path')).toHaveAttribute(
    'data-path',
    '/home/test/Documents'
  );
});
test('scrolling layout reveals focused columns without squeezing them and saves widths', async ({
  page: p,
}) => {
  await boot(p);
  await p.keyboard.press('Meta+Comma');
  await p.getByRole('combobox', { name: 'Window layout' }).selectOption('scrolling');
  await expect(p.locator('.desk-column-scroll')).toBeVisible();
  const settings = await rect(p, 'settings'),
    browser = await rect(p, 'browser');
  expect(settings.width).toBeGreaterThan(550);
  expect(settings.x + settings.width).toBeLessThanOrEqual(1185);
  expect(Math.abs(settings.width - browser.width)).toBeLessThan(2);
  await p.keyboard.press('Meta+ArrowLeft');
  await p.keyboard.press('Meta+ArrowLeft');
  const terminal = await rect(p, 'terminal');
  expect(terminal.x).toBeGreaterThanOrEqual(9);
  const divider = p.locator('.desk-divider').first();
  const d = await divider.boundingBox();
  await drag(p, d.x + d.width / 2, d.y + 70, 70, 0);
  const widened = await rect(p, 'terminal');
  expect(widened.width).toBeGreaterThan(terminal.width + 50);
  await p.reload();
  expect((await rect(p, 'terminal')).width).toBeCloseTo(widened.width, 0);
  await p.locator('.desk-column-scroll').evaluate(el => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(async () => (await frame(p, 'terminal').boundingBox()).x).toBeLessThan(0);
  await p.keyboard.press('Meta+Digit1');
  await expect(p.locator('.desk-column-scroll')).toBeHidden();
  await expect(frame(p, 'settings')).toHaveCSS('visibility', 'hidden');
  await p.keyboard.press('Meta+Digit2');
  await p.waitForTimeout(650);
  await p.screenshot({ path: 'artifacts/browser/scrolling-layout.png' });
  await p.keyboard.press('Meta+E');
  await expect(p.locator('.desk-column-scroll')).toBeHidden();
  await p.waitForTimeout(650);
  await p.screenshot({ path: 'artifacts/browser/scrolling-expo.png' });
});

test('floating windows leave tiling, move and resize independently, and restore', async ({
  page: p,
}) => {
  await boot(p);
  await p.keyboard.press('Meta+Shift+O');
  const floating = await rect(p, 'browser');
  const tile = await rect(p, 'terminal');
  expect(tile.width).toBeGreaterThan(1100);
  expect(floating.width).toBeLessThan(tile.width);
  await drag(p, floating.x + 30, floating.y + 80, 50, 30, 'left', true);
  const moved = await rect(p, 'browser');
  expect(moved.x).toBeGreaterThan(floating.x + 40);
  await drag(p, moved.x + 30, moved.y + 80, -80, -50, 'right', true);
  const resized = await rect(p, 'browser');
  expect(resized.width).toBeLessThan(moved.width - 60);
  await p.reload();
  expect((await rect(p, 'browser')).width).toBeCloseTo(resized.width, 0);
  await p.keyboard.press('Meta+Shift+O');
  await expect(p.locator('.desk-divider')).toHaveCount(1);
  expect((await rect(p, 'terminal')).width).toBeLessThan(tile.width - 200);
});
