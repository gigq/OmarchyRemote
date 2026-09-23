import { test, expect } from './fixtures.mjs';
const snapshot = {
  workspaces: [{ workspace_id: 'qa', label: 'Solo QA' }],
  tabs: [{ tab_id: 'qa:t1', label: '1' }],
  panes: [
    {
      pane_id: 'qa:p1',
      tab_id: 'qa:t1',
      workspace_id: 'qa',
      agent: 'codex',
      terminal_title_stripped: 'Solo agent',
    },
  ],
};
const savedLayout = JSON.stringify({ open: ['home', 'files'], tiles: { files: 1 }, ws: 1 });

for (const viewport of [
  { width: 900, height: 800 },
  { width: 420, height: 760 },
]) {
  test(`?app= shows one app without shell chrome at ${viewport.width}px`, async ({ page: p }) => {
    await p.setViewportSize(viewport);
    await p.route('**/api/**', r => r.abort());
    await p.routeWebSocket('**/api/herdr/ws', ws =>
      ws.send(JSON.stringify({ type: 'snapshot', snapshot }))
    );
    await p.addInitScript(layout => {
      if (!sessionStorage.getItem('qa-seeded')) {
        localStorage.setItem('omarchy-layout-desk', layout);
        localStorage.setItem('omarchy-layout-phone', layout);
        sessionStorage.setItem('qa-seeded', '1');
      }
      window.qaOpened = [];
      window.open = url => window.qaOpened.push(url);
    }, savedLayout);
    await p.goto('/native/?app=herdr');
    await expect(p).toHaveTitle('herdr');
    const herdr = p.locator('#remote-herdr-app');
    await expect(herdr.locator('.herdr-pane')).toHaveCount(1);
    // Even a phone-width window uses the 1:1 desk layout, and the app fills it.
    await expect(p.locator('html')).toHaveClass(/solo-mode.*desk-mode|desk-mode.*solo-mode/);
    const card = await p.locator('[data-workspace="herdr"]').boundingBox();
    expect(card).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    for (const chrome of ['.shell-topbar', '[data-workspace="home"]', '.expo-swipe-hint'])
      await expect(p.locator(chrome)).toBeHidden();
    await expect(p.locator('[data-workspace="files"]')).toBeHidden();

    // Shell shortcuts do nothing; the app stays in front and Expo never opens.
    await p.keyboard.press('Control+Alt+E');
    await p.keyboard.press('Control+Alt+1');
    await p.keyboard.press('Meta+Shift+F');
    await expect(herdr.locator('.herdr-pane')).toBeVisible();
    await expect(p.locator('#touch-shell')).not.toHaveClass(/expo-mode/);

    // Opening another app goes to its own window instead of replacing this one.
    await p.evaluate(() => window.HyprlandSolo.open('files'));
    expect(await p.evaluate(() => window.qaOpened.at(-1))).toMatch(/\/native\/\?app=files$/);

    // The saved shell layout is neither restored nor overwritten.
    await p.waitForTimeout(500);
    expect(await p.evaluate(() => localStorage.getItem('omarchy-layout-desk'))).toBe(savedLayout);
    expect(await p.evaluate(() => localStorage.getItem('omarchy-layout-phone'))).toBe(savedLayout);
  });
}

test('an unknown ?app= says so instead of showing the shell', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 800 });
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/?app=nope');
  await expect(p.getByRole('alert')).toHaveText('This host has no app called “nope”.');
  await expect(p.locator('.shell-topbar')).toBeHidden();
  await expect(p.locator('[data-workspace="home"]')).toBeHidden();
});

test('the full shell is unchanged without ?app=', async ({ page: p }) => {
  await p.setViewportSize({ width: 900, height: 800 });
  await p.route('**/api/**', r => r.abort());
  await p.goto('/native/');
  await expect(p.locator('html')).not.toHaveClass(/solo-mode/);
  await expect(p.locator('.shell-topbar')).toBeVisible();
  await expect(p.locator('[data-workspace="home"]')).toBeVisible();
  // Browsers have no desktop window bridge, so Settings has no app-window section.
  await p.keyboard.press('Meta+Comma');
  await expect(p.locator('.theme-settings')).toBeVisible();
  await expect(p.locator('.solo-settings')).toHaveCount(0);
});
