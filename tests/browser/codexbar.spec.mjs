import { test, expect } from './fixtures.mjs';
const data = {
  checked_at: 2000000000,
  providers: [
    {
      id: 'codex',
      updated_at: '2030-01-01T00:00:00Z',
      windows: [{ label: 'Weekly', used_percent: 63, resets_at: '2030-01-08T00:00:00Z' }],
      details: {
        source: 'cli',
        version: '0.58.0',
        usage: {
          codexResetCredits: {
            availableCount: 2,
            updatedAt: '2030-01-01T00:00:00Z',
            credits: [
              {
                status: 'available',
                title: 'Weekly reset',
                granted_at: '2030-01-01T00:00:00Z',
                expires_at: '2030-02-01T00:00:00Z',
              },
              { status: 'redeemed', title: 'Used reset', redeemed_at: '2026-01-01T00:00:00Z' },
            ],
          },
          providerCost: { used: 12, limit: 50, currencyCode: 'USD' },
        },
        credits: { remaining: 0, balanceReadSucceeded: true },
        status: { indicator: 'none', description: 'Operational' },
      },
    },
    {
      id: 'claude',
      windows: [{ label: 'Session', used_percent: null }],
      details: { usage: { dataConfidence: 'partial' } },
    },
  ],
  costs: [
    {
      provider: 'codex',
      sessionTokens: 1234,
      last30DaysCostUSD: 12.5,
      daily: [{ date: '2026-09-20', totalTokens: 1234, totalCost: 12.5 }],
      totals: { cacheReadTokens: 1000 },
    },
  ],
};
async function boot(page) {
  await page.route('**/api/widgets', r =>
    r.fulfill({ json: { metrics: {}, tailscale: {}, codexbar: data } })
  );
  await page.route('**/api/codexbar', r => r.fulfill({ json: data }));
  await page.goto('/native/');
  if (page.viewportSize().width < 600)
    await page.getByRole('button', { name: 'Show CodexBar', exact: true }).click();
  await expect(page.locator('#widget-codexbar')).toContainText('63% used');
}
for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
]) {
  test(`CodexBar widget opens its owner with complete telemetry at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await boot(page);
    await page.locator('#widget-codexbar').getByText('63% used', { exact: true }).click();
    const app = page.locator('#remote-codexbar-app');
    await expect(app).toBeVisible();
    await expect(app).toContainText('2 reported available');
    await expect(app).toContainText('Expires in');
    await expect(app).toContainText('0 remaining');
    await expect(app).toContainText('Operational');
    await expect(app).toContainText('1,234');
    expect(await app.evaluate(n => n.scrollWidth <= n.clientWidth)).toBeTruthy();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `artifacts/browser/codexbar-${viewport.width}.png` });
    await app.getByLabel('Usage provider').selectOption('claude');
    await expect(app).toContainText('Unavailable');
    await expect(app).not.toContainText('0% used');
    await expect(app).toContainText('Banked resets not reported');
    await page.route('**/api/codexbar', r => r.fulfill({ status: 503, json: {} }));
    await app.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(app.getByRole('status')).toContainText('Host unavailable');
    await expect(app).toContainText('Session');
  });
}

test('widget controls and long press do not launch app; keyboard activation does', async ({
  page,
}) => {
  await boot(page);
  const widget = page.locator('#widget-codexbar');
  await widget.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(widget).toContainText('Session');
  await expect(page.locator('#remote-codexbar-app .usage-toolbar')).toHaveCount(0);
  const box = await widget.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'Manage widgets' })).toBeVisible();
  await expect(page.locator('#remote-codexbar-app .usage-toolbar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await widget.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#remote-codexbar-app')).toBeVisible();
  await expect(page.getByLabel('Usage provider')).toHaveValue('claude');
});
