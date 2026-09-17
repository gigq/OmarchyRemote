import { test, expect } from './fixtures.mjs';
for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
])
  test(`theme backgrounds persist and focused windows remain translucent at ${viewport.width}px`, async ({
    page: p,
  }) => {
    await p.setViewportSize(viewport);
    await p.route('**/api/**', r => r.abort());
    await p.goto('/native/');
    await p.getByText('settings', { exact: true }).first().click();
    await p.getByRole('button', { name: 'Tokyo Night', exact: true }).click();
    const choices = p.locator('.background-choice');
    expect(await choices.count()).toBeGreaterThan(2);
    const chosen = await choices.nth(2).getAttribute('data-background-choice');
    await choices.nth(2).click();
    await expect(p.locator('html')).toHaveAttribute('data-background', chosen);
    const background = await p
      .locator('#touch-shell')
      .evaluate(e => getComputedStyle(e).backgroundImage);
    expect(background).toContain(chosen + '.webp');
    const request = await p.request.get('/backgrounds/' + chosen + '.webp');
    expect(request.ok()).toBe(true);
    expect(request.headers()['content-type']).toContain('image/webp');
    await p.getByRole('button', { name: 'Catppuccin', exact: true }).click();
    await p.getByRole('button', { name: 'Solid color', exact: true }).click();
    await p.getByRole('button', { name: 'Tokyo Night', exact: true }).click();
    await expect(p.locator('html')).toHaveAttribute('data-background', chosen);
    await p.reload();
    await expect(p.locator('html')).toHaveAttribute('data-background', chosen);
    await p.keyboard.press('Meta+Digit1');
    await expect(p.locator('[data-workspace="home"]').last()).toHaveCSS('opacity', '0.95');
    await p.keyboard.press('Meta+Enter');
    await expect(p.locator('[data-workspace="home"]').last()).toHaveCSS('opacity', '0.92');
    await expect(p.locator('[data-workspace="terminal"]').last()).toHaveCSS('opacity', '0.95');
    if (viewport.width > 600) {
      await p.keyboard.press('Meta+Shift+A');
      await expect(p.locator('[data-workspace="terminal"]').last()).toHaveCSS('opacity', '0.92');
      await p.keyboard.press('Meta+ArrowLeft');
      await expect(p.locator('[data-workspace="terminal"]').last()).toHaveCSS('opacity', '0.95');
    }
    await p.screenshot({ path: `artifacts/browser/background-windows-${viewport.width}.png` });
  });
