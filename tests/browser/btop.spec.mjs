import { test, expect } from './fixtures.mjs';
import { captureTerminals } from './terminal-helper.mjs';
test.beforeEach(async ({ page }) => captureTerminals(page));
test('btop has a dedicated monitor session, touch controls and survives reload', async ({
  page: p,
}) => {
  let id;
  try {
    await p.goto('/native/');
    await expect(p.getByText('herdr', { exact: true }).first()).toBeVisible();
    await p.getByText('btop', { exact: true }).first().click();
    const app = p.locator('#remote-btop-app');
    await expect(app).toContainText('· connected');
    id = await p.evaluate(() => localStorage.getItem('omarchy-btop-id'));
    expect(id).toBeTruthy();
    expect(await p.evaluate(() => localStorage.getItem('omarchy-terminal-id'))).toBeNull();
    await expect(app.locator('.native-terminal-content')).toContainText(/cpu|CPU/);
    await app.getByRole('button', { name: 'Larger', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Fit', exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect(
      app.locator('.native-terminal-row span').filter({ hasText: '─' }).first()
    ).toHaveCSS(
      'color',
      await p.evaluate(() => {
        const el = document.createElement('span');
        el.style.color = 'var(--theme-accent)';
        document.body.append(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      })
    );
    const solidBlack = () =>
      app
        .locator('.native-terminal-row span')
        .evaluateAll(nodes =>
          nodes.some(n => getComputedStyle(n).backgroundColor === 'rgb(0, 0, 0)')
        );
    expect(await solidBlack()).toBe(false);
    await p.screenshot({ path: 'artifacts/browser/btop.png' });
    await p.evaluate(() => {
      const light = HyprlandThemes.catalog.find(t => t.colors.mode === 'light');
      if (!light) throw Error('Missing light theme');
      HyprlandThemes.apply(light.id, false);
    });
    expect(await solidBlack()).toBe(false);
    await p.screenshot({ path: 'artifacts/browser/btop-light.png' });
    await p.evaluate(() => HyprlandThemes.apply('prototype', false));
    await p.reload();
    await p.getByText('btop', { exact: true }).first().click();
    await expect(app).toContainText('· connected');
    expect(await p.evaluate(() => localStorage.getItem('omarchy-btop-id'))).toBe(id);
    // Reconnect must restore the alternate buffer, so resize cannot reflow a TUI
    // snapshot into ordinary shell history. No manual panel/size toggle is used.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect.poll(() => p.evaluate(() => qaTerms[0].buffer.active.type)).toBe('alternate');
      await p.waitForTimeout(2200);
      await expect.poll(() => p.evaluate(() => qaTerms[0].buffer.active.baseY)).toBe(0);
      await expect(app.locator('.native-terminal-content')).toContainText(/cpu|CPU/);
      await p.screenshot({ path: `artifacts/browser/btop-reconnect-${attempt}.png` });
      if (attempt < 2) {
        await p.reload();
        await p.getByText('btop', { exact: true }).first().click();
        await expect(app).toContainText('· connected');
      }
    }
  } finally {
    if (id)
      await p.request.post(`/api/terminal/${id}/close`, {
        headers: { 'X-Hyprland-Client': '1' },
        data: {},
      });
  }
});
