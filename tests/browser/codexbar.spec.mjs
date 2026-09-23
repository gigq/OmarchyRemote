import { test, expect } from './fixtures.mjs';
const data = {
  checked_at: 2000000000,
  providers: [
    {
      id: 'codex',
      updated_at: '2030-01-01T00:00:00Z',
      windows: [
        { label: 'Weekly', used_percent: 63, resets_at: '2030-01-08T00:00:00Z' },
        { label: 'Fable only', used_percent: 4, resets_at: '2030-01-08T00:00:00Z', extra: true },
      ],
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
async function boot(page, snapshot = data) {
  await page.route('**/api/widgets', r =>
    r.fulfill({ json: { metrics: {}, tailscale: {}, codexbar: snapshot } })
  );
  await page.route('**/api/codexbar', r => r.fulfill({ json: snapshot }));
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
    await expect(page.locator('#widget-codexbar')).toContainText('+1 more in app');
    await expect(page.locator('#widget-codexbar')).not.toContainText('Fable only');
    await page.locator('#widget-codexbar').getByText('63% used', { exact: true }).click();
    const app = page.locator('#remote-codexbar-app');
    await expect(app).toBeVisible();
    await expect(app.locator('.usage-extra')).toContainText('More limits · 1');
    await expect(app.locator('.usage-extra')).toContainText('Fable only');
    await expect(app.locator('.usage-extra .usage-limit')).toBeVisible();
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

test('many extra windows collapse below the main limits', async ({ page }) => {
  const extra = ['a', 'b', 'c', 'd'].map(name => ({
    label: name + ' · Weekly',
    used_percent: 10,
    resets_at: '2030-01-08T00:00:00Z',
    extra: true,
  }));
  const codex = { ...data.providers[0], windows: [data.providers[0].windows[0], ...extra] };
  await boot(page, { ...data, providers: [codex, data.providers[1]] });
  await expect(page.locator('#widget-codexbar')).toContainText('+4 more in app');
  await page.locator('#widget-codexbar').getByText('63% used', { exact: true }).click();
  const more = page.locator('#remote-codexbar-app .usage-extra');
  await expect(more).toContainText('More limits · 4');
  await expect(more.locator('.usage-limit').first()).toBeHidden();
  await more.getByText('More limits · 4', { exact: true }).click();
  await expect(more.locator('.usage-limit')).toHaveCount(4);
  await expect(more.locator('.usage-limit').first()).toBeVisible();
  await expect(more).toContainText('Resets in');
});

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

for (const width of [402, 1194]) {
  test(`Reset watch displays sourced forecasts, posts and history at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 874 });
    const checked = Math.floor(Date.now() / 1000);
    const news = {
      forecast: {
        checked_at: checked,
        data: {
          prob_24: 41,
          prob_48: 65,
          confidence: 'low',
          computed_at: new Date().toISOString(),
          last_reset_at: '2026-09-12T08:09:17Z',
          last_reset_url: 'https://x.com/thsottiaux/status/1',
          promise: {
            active: true,
            quote: 'A reset is planned tonight.',
            url: 'https://x.com/thsottiaux/status/2',
          },
        },
      },
      feed: {
        checked_at: checked,
        data: {
          items: [
            {
              kind: 'banked',
              text: '<script>plain text only</script>',
              at: '2026-09-19T16:48:38Z',
              url: 'javascript:alert(1)',
            },
          ],
        },
      },
      timeline: {
        checked_at: checked,
        data: {
          items: [
            {
              kind: 'reset_preview',
              preview: true,
              summary: 'Upcoming reset preview',
              announced_at: '2026-09-19T16:48:38Z',
              source_url: 'https://x.com/thsottiaux/status/3',
            },
          ],
        },
      },
    };
    await boot(page, { ...data, reset_news: news });
    await page.locator('#widget-codexbar').getByText('63% used', { exact: true }).click();
    const card = page.locator('.reset-news');
    await expect(card).toContainText('41%');
    await expect(card).toContainText('65%');
    await expect(card).toContainText('Reset planned');
    await expect(card).toContainText('Last reset:');
    await card.getByText('Reset-related posts', { exact: true }).click();
    await expect(card).toContainText('<script>plain text only</script>');
    await expect(card.locator('a[href^="javascript:"]')).toHaveCount(0);
    await card.getByText('Reset history', { exact: true }).click();
    await expect(card).toContainText('Preview');
    expect(await card.evaluate(n => n.scrollWidth <= n.clientWidth)).toBeTruthy();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `artifacts/browser/reset-watch-${width}.png` });
    news.forecast.data.computed_at = '2000-01-01T00:00:00Z';
    news.forecast.data.prob_24 = null;
    await page.route('**/api/codexbar', r => r.fulfill({ json: { ...data, reset_news: news } }));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(card).toContainText('Forecast may be outdated');
    await expect(card).toContainText('Previously reported plan');
    await expect(card).not.toContainText('41%');
    await expect(card).not.toContainText('0%');
    await expect(card.locator('details').first()).toHaveAttribute('open', '');
    await page.getByLabel('Usage provider').selectOption('claude');
    await expect(card).toHaveCount(0);
  });
}
