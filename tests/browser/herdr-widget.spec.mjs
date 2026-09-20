import { test, expect } from './fixtures.mjs';
const fixture = () => ({
  workspaces: [{ workspace_id: 'qa', label: 'Widget project' }],
  tabs: [
    { tab_id: 'one', label: 'Fix scrolling' },
    { tab_id: 'two', label: 'Build settings' },
    { tab_id: 'three', label: 'Quiet thread' },
  ],
  panes: [
    {
      pane_id: 'one',
      tab_id: 'one',
      workspace_id: 'qa',
      agent: 'codex',
      agent_status: 'blocked',
      attention_kind: 'approval',
      terminal_title_stripped: 'wrong pathname',
    },
    { pane_id: 'two', tab_id: 'two', workspace_id: 'qa', agent: 'claude', agent_status: 'working' },
    {
      pane_id: 'three',
      tab_id: 'three',
      workspace_id: 'qa',
      agent: 'codex',
      agent_status: 'blocked',
      attention_kind: 'chat',
    },
  ],
});
for (const width of [402, 1194]) {
  test(`Herd widget prioritizes attention then working threads and opens the selected pane at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 874 });
    const snapshot = fixture();
    let offline = false;
    await page.route('**/api/herdr/snapshot', r =>
      offline ? r.fulfill({ status: 503 }) : r.fulfill({ json: snapshot })
    );
    const selections = [];
    await page.routeWebSocket('**/api/herdr/ws', ws => {
      ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
      ws.onMessage(raw => {
        const m = JSON.parse(raw);
        if (m.type === 'select') selections.push(m.pane_id);
      });
    });
    await page.goto('/native/');
    if (width < 600) await page.getByRole('button', { name: 'Show herdr', exact: true }).click();
    const widget = page.locator('#widget-herdr');
    await expect(widget).toContainText('1 need attention');
    await expect(widget).toContainText('Fix scrolling');
    await expect(widget).toContainText('Widget project');
    await expect(widget).toContainText('approval');
    await expect(widget).not.toContainText('Build settings');
    await expect(widget).not.toContainText('wrong pathname');
    snapshot.panes[0].agent_status = 'idle';
    await expect(widget).toContainText('1 working');
    await expect(widget).toContainText('Build settings');
    await expect(widget).not.toContainText('Quiet thread');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `artifacts/browser/herdr-widget-${width}.png` });
    expect(await widget.evaluate(n => n.scrollWidth <= n.clientWidth)).toBeTruthy();
    snapshot.panes[1].agent_status = 'idle';
    await expect(widget).toContainText('No threads working or waiting for you.');
    offline = true;
    await expect(widget).toContainText('Host unavailable');
    offline = false;
    snapshot.panes[1].agent_status = 'working';
    await expect(widget).toContainText('Build settings');
    await widget
      .getByRole('button', { name: 'Open Widget project · Build settings', exact: true })
      .click();
    await expect.poll(() => selections.includes('two')).toBeTruthy();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('omarchy-herdr-pane')))
      .toBe('two');
  });
}
test('Herd migrates into an existing widget layout once and respects removal', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('qa-initialized')) {
      localStorage.setItem('omarchy-widgets', JSON.stringify(['weather']));
      localStorage.setItem('qa-initialized', 'yes');
    }
  });
  await page.route('**/api/herdr/snapshot', r =>
    r.fulfill({ json: { tabs: [], panes: [], workspaces: [] } })
  );
  await page.goto('/native/');
  const order = () => page.evaluate(() => JSON.parse(localStorage.getItem('omarchy-widgets')));
  await expect.poll(order).toEqual(['weather', 'herdr']);
  await page.reload();
  await expect.poll(order).toEqual(['weather', 'herdr']);
  await page.getByRole('button', { name: 'Show herdr', exact: true }).click();
  await expect(page.locator('#widget-herdr')).toContainText('No threads open.');
  await page.getByRole('button', { name: 'Manage widgets', exact: true }).click();
  await page.getByRole('button', { name: 'Remove herdr', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect.poll(order).toEqual(['weather']);
  await expect(page.getByRole('button', { name: 'Show herdr', exact: true })).toHaveCount(0);
});
