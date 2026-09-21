import { test, expect } from './fixtures.mjs';

for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
]) {
  test(`Builds launches with setup and changes to published builds at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    let catalog = [];
    await page.route('**/builds/catalog.json', route => route.fulfill({ json: catalog }));
    await page.goto('/');
    await page.keyboard.press('Meta+k');
    await page.getByRole('searchbox', { name: 'Search apps, panes and files' }).fill('Builds');
    await page.getByRole('button', { name: /Builds.*build dashboard/ }).click();
    const app = page.locator('#remote-builds-app');
    await expect(app.getByRole('heading', { name: 'A home for your builds.' })).toBeVisible();
    await expect(app.getByRole('link', { name: 'Get the agent skill' })).toHaveAttribute(
      'href',
      '/builds/SKILL.md'
    );
    expect(await app.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect
      .poll(() => app.evaluate(el => Math.abs(el.getBoundingClientRect().left)))
      .toBeLessThan(50);
    await page.screenshot({ path: `artifacts/browser/builds-app-setup-${viewport.width}.png` });
    catalog = [
      {
        id: 'a'.repeat(64),
        sha256: 'a'.repeat(64),
        build: '42',
        version: '1.0',
        notes: 'A new update',
        published: '2026-09-21',
        expires: '2027-08-17',
        commit: 'abc123',
        bytes: 1024,
      },
    ];
    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(app.getByRole('heading', { name: 'Build 42' })).toBeVisible();
    await expect(app.getByText('A new update')).toBeVisible();
    await expect(app.getByRole('heading', { name: 'A home for your builds.' })).toHaveCount(0);
    await expect(app.getByRole('button', { name: 'Copy dashboard link' })).toBeVisible();
    await page.screenshot({ path: `artifacts/browser/builds-app-published-${viewport.width}.png` });
  });
}
