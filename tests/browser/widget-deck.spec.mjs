import { test, expect } from './fixtures.mjs';
const snapshot = {
  metrics: { error: 'Test metrics' },
  tailscale: { state: 'Running', peers: [] },
  codexbar: {
    providers: [
      {
        id: 'codex',
        windows: [{ label: 'Weekly', used_percent: 63, resets_at: '2026-09-17T03:53:30Z' }],
        updated_at: '2026-09-11T01:00:00Z',
      },
      {
        id: 'claude',
        windows: [{ label: 'Session', used_percent: 50 }],
        updated_at: '2026-09-11T01:00:00Z',
      },
    ],
  },
};
const center = async el => {
  const r = await el.boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
const order = p => p.evaluate(() => JSON.parse(localStorage.getItem('omarchy-widgets')));
test('CodexBar usage, long-press overview, reordering, removal, adding and persistence', async ({
  page: p,
}) => {
  await p.route('**/api/widgets', r => r.fulfill({ json: snapshot }));
  await p.goto('/native/');
  await p.getByRole('button', { name: 'Show CodexBar', exact: true }).click();
  await expect(p.locator('#widget-codexbar')).toContainText('63% used');
  await p.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(p.locator('#widget-codexbar')).toContainText('50% used');
  const a = await center(p.locator('#widget-codexbar'));
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  await p.waitForTimeout(500);
  await p.mouse.up();
  await expect(p.getByRole('dialog', { name: 'Manage widgets' })).toBeVisible();
  await p.waitForTimeout(650);
  const card = k => p.locator(`[data-widget-key="${k}"]`);
  const from = await center(card('codexbar')),
    to = await center(card('weather'));
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.waitForTimeout(400);
  await p.mouse.move(to.x, to.y, { steps: 10 });
  await p.mouse.up();
  await expect
    .poll(() => order(p))
    .toEqual(['codexbar', 'weather', 'metrics', 'tailscale', 'herdr']);
  await p.waitForTimeout(550);
  await p.getByRole('button', { name: 'Remove CodexBar', exact: true }).click();
  await expect(card('codexbar')).toHaveCount(0);
  await p.getByRole('button', { name: '+ CodexBar', exact: true }).click();
  await expect(card('codexbar')).toHaveCount(1);
  const b = await center(card('metrics'));
  await p.mouse.move(b.x, b.y);
  await p.mouse.down();
  await p.mouse.move(b.x, b.y - 100, { steps: 8 });
  await p.mouse.up();
  await expect(card('metrics')).toHaveCount(0);
  await p.screenshot({ path: 'artifacts/browser/widget-overview.png' });
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  await p.reload();
  await expect(p.getByRole('button', { name: 'Show Host metrics', exact: true })).toHaveCount(0);
  await p.getByRole('button', { name: 'Manage widgets', exact: true }).click();
  for (const label of ['Weather', 'Tailscale', 'CodexBar', 'herdr'])
    await p.getByRole('button', { name: 'Remove ' + label, exact: true }).click();
  await p.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(p.getByRole('button', { name: '+ Widgets', exact: true })).toBeVisible();
  await p.reload();
  await p.getByRole('button', { name: '+ Widgets', exact: true }).click();
  await p.getByRole('button', { name: '+ Weather', exact: true }).click();
  await expect.poll(() => order(p)).toEqual(['weather']);
});
