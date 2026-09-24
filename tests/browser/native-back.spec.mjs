import { test, expect } from './fixtures.mjs';
// Android Back and the right-edge swipe reach the shell as HyprlandDesk.nativeBack()/nativeNext().
const snapshot = {
  workspaces: [{ workspace_id: 'qa', label: 'Back QA' }],
  tabs: [{ tab_id: 'qa:t1', label: '1' }],
  panes: [
    {
      pane_id: 'qa:p1',
      tab_id: 'qa:t1',
      workspace_id: 'qa',
      agent: 'codex',
      terminal_title_stripped: 'Back agent',
    },
  ],
};
const home = '/home/qa';
const listing = path => ({
  path,
  root: home,
  parent: path === home ? null : path.slice(0, path.lastIndexOf('/')),
  entries:
    path === home ? [{ name: 'project', path: home + '/project', directory: true, size: 0 }] : [],
});

test('Back steps back inside apps, then to Home, then leaves; the right edge goes forward', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  await p.route(
    url => url.pathname === '/api/files',
    r => r.fulfill({ json: listing(new URL(r.request().url()).searchParams.get('path') || home) })
  );
  await p.routeWebSocket('**/api/herdr/ws', ws =>
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }))
  );
  await p.goto('/native/');
  const back = () => p.evaluate(() => window.HyprlandDesk.nativeBack());
  const next = () => p.evaluate(() => window.HyprlandDesk.nativeNext());
  const current = () =>
    p.evaluate(
      () => document.querySelector('[data-workspace][data-active="true"]')?.dataset.workspace
    );

  // Herdr: an open thread goes back to the pane list, then Back returns Home.
  await p.getByText('herdr', { exact: true }).first().click();
  await p.locator('.herdr-pane').click();
  await expect(p.locator('#remote-herdr-app .herdr-detail')).toBeVisible();
  expect(await back()).toBe(true);
  await expect(p.locator('#remote-herdr-app .herdr-detail')).toBeHidden();
  await expect(p.locator('#remote-herdr-app .herdr-pane')).toBeVisible();
  expect(await back()).toBe(true);
  await expect.poll(current).toBe('home');

  // Files: Back goes up a folder before leaving the app.
  await p.getByText('files', { exact: true }).first().click();
  await p.locator('.files-app').getByRole('button', { name: 'project folder' }).click();
  await expect(p.locator('.files-path')).toHaveAttribute('data-path', home + '/project');
  expect(await back()).toBe(true);
  await expect(p.locator('.files-path')).toHaveAttribute('data-path', home);
  expect(await back()).toBe(true);
  await expect.poll(current).toBe('home');

  // The right edge moves to the next workspace; Back on Home is left to Android (leave the app).
  expect(await next()).toBe(true);
  await expect.poll(current).toBe('herdr');
  expect(await next()).toBe(true);
  await expect.poll(current).toBe('files');
  expect(await back()).toBe(true);
  await expect.poll(current).toBe('home');
  expect(await back()).toBe(false);
});

for (const platform of ['android', 'ios']) {
  test(`edge swipes on ${platform}: left is ${platform === 'android' ? 'Back' : 'the previous workspace'}`, async ({
    page: p,
  }) => {
    await p.setViewportSize({ width: 402, height: 874 });
    if (platform === 'android')
      await p.addInitScript(() => (window.__OMARCHY_PLATFORM__ = 'android'));
    await p.route('**/api/**', r => r.abort());
    await p.routeWebSocket('**/api/herdr/ws', ws =>
      ws.send(JSON.stringify({ type: 'snapshot', snapshot }))
    );
    await p.goto('/native/');
    const current = () =>
      p.evaluate(
        () => document.querySelector('[data-workspace][data-active="true"]')?.dataset.workspace
      );
    const swipe = async (fromX, toX) => {
      await p.mouse.move(fromX, 150);
      await p.mouse.down();
      await p.mouse.move(toX, 150, { steps: 8 });
      await p.mouse.up();
      await p.waitForTimeout(600);
    };
    await p.getByText('settings', { exact: true }).first().click();
    await expect.poll(current).toBe('settings');
    await p.evaluate(() => window.HyprlandDesk.nativeBack());
    await expect.poll(current).toBe('home');
    await p.getByText('herdr', { exact: true }).first().click();
    await p.locator('.herdr-pane').click();
    await expect(p.locator('#remote-herdr-app .herdr-detail')).toBeVisible();
    await swipe(3, 250);
    if (platform === 'android') {
      // Back leaves the thread for the pane list and stays in Herdr.
      await expect(p.locator('#remote-herdr-app .herdr-detail')).toBeHidden();
      await expect.poll(current).toBe('herdr');
    } else await expect.poll(current).toBe('settings');
    // The right edge moves to the next workspace on both.
    await p.evaluate(() => window.HyprlandDesk.nativeBack());
    await p.evaluate(() => window.HyprlandDesk.nativeBack());
    await expect.poll(current).toBe('home');
    // Let the slide back to Home finish so the swipe starts on Home, not the departing card.
    await p.waitForTimeout(600);
    await swipe(399, 150);
    await expect.poll(current).toBe('settings');
  });
}
