import { test, expect } from './fixtures.mjs';
for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
]) {
  test(`Android native keyboard insets keep the composer visible at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      window.__OMARCHY_PLATFORM__ = 'android';
      window.__HYPRLAND_NATIVE__ = true;
      window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
      document.addEventListener('DOMContentLoaded', () =>
        document.documentElement.classList.add('android-shell')
      );
    });
    await page.route('**/api/**', route => route.abort());
    await page.routeWebSocket('**/api/herdr/ws', socket => {
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          snapshot: {
            workspaces: [{ workspace_id: 'android-qa', label: 'Android QA' }],
            tabs: [{ tab_id: 'tab', label: 'Keyboard QA' }],
            panes: [{ pane_id: 'android-input-qa', tab_id: 'tab', workspace_id: 'android-qa' }],
          },
        })
      );
      socket.onMessage(raw => {
        if (JSON.parse(raw).type === 'select')
          socket.send(
            JSON.stringify({
              type: 'pane',
              pane_id: 'android-input-qa',
              read: { pane_id: 'android-input-qa', text: 'Isolated keyboard fixture' },
            })
          );
      });
    });
    await page.goto('/native/');
    await page.keyboard.press('Control+Alt+Shift+A');
    await page.locator('.herdr-pane').click();
    await page.locator('.herdr-output').click();
    const field = page.getByRole('textbox', { name: 'Message to host' });
    await expect(field).toBeVisible();
    await field.fill('Keep this composer above the keyboard');
    await page.evaluate(() => {
      document.querySelector('.herdr-back').click();
      document.querySelector('.herdr-pane').click();
    });
    const originalHeight = await page.evaluate(() => visualViewport.height);
    const inset = 320;
    await page.evaluate(inset => {
      window.__HYPRLAND_KEYBOARD__ = { inset, height: innerHeight };
      window.dispatchEvent(new Event('hyprland-keyboard'));
    }, inset);
    await expect
      .poll(async () => (await field.boundingBox()).y + (await field.boundingBox()).height)
      .toBeLessThanOrEqual(viewport.height - inset);
    expect(await page.evaluate(() => visualViewport.height)).toBe(originalHeight);
    await expect(field).toHaveValue('Keep this composer above the keyboard');
    await page.evaluate(() => {
      window.__HYPRLAND_KEYBOARD__ = { inset: 0, height: innerHeight };
      window.dispatchEvent(new Event('hyprland-keyboard'));
    });
    await expect
      .poll(async () => (await field.boundingBox()).y)
      .toBeGreaterThan(viewport.height - inset);
  });
}
