import { test, expect } from './fixtures.mjs';
const home = '/home/qa';
const listing = path => ({
  path,
  root: home,
  parent: path === home ? null : path.slice(0, path.lastIndexOf('/')),
  entries:
    path === home
      ? [
          { name: 'project', path: home + '/project', directory: true, size: 0, count: 2 },
          { name: 'notes.txt', path: home + '/notes.txt', directory: false, size: 12 },
        ]
      : [],
});
const pane = (pane_id, workspace_id, label) => ({
  pane_id,
  tab_id: workspace_id + ':t1',
  workspace_id,
  agent: 'codex',
  terminal_title_stripped: label,
});
for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
]) {
  test(`a new Herdr pane starts in a folder chosen with Files at ${viewport.width}px`, async ({
    page: p,
  }) => {
    await p.setViewportSize(viewport);
    await p.route('**/api/**', r => r.abort());
    await p.route(
      url => url.pathname === '/api/files',
      r =>
        r.fulfill({
          json: listing(new URL(r.request().url()).searchParams.get('path') || home),
        })
    );
    const created = [];
    const snapshot = {
      workspaces: [{ workspace_id: 'qa', label: 'Existing QA' }],
      tabs: [{ tab_id: 'qa:t1', label: '1' }],
      panes: [pane('qa:p1', 'qa', 'Existing agent')],
    };
    await p.route('**/api/herdr/workspaces', r => {
      created.push(r.request().postDataJSON());
      r.fulfill({
        json: {
          pane: pane('new:p1', 'new', 'project shell'),
          snapshot: {
            workspaces: [...snapshot.workspaces, { workspace_id: 'new', label: 'project' }],
            tabs: [...snapshot.tabs, { tab_id: 'new:t1', label: '1' }],
            panes: [...snapshot.panes, pane('new:p1', 'new', 'project shell')],
          },
        },
      });
    });
    const selected = [];
    await p.routeWebSocket('**/api/herdr/ws', ws => {
      ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
      ws.onMessage(raw => {
        const m = JSON.parse(raw);
        if (m.type === 'select') selected.push(m.pane_id);
      });
    });
    await p.goto('/native/');
    await p.keyboard.press('Meta+Shift+A');
    const herdr = p.locator('#remote-herdr-app');
    await expect(herdr.locator('.herdr-pane')).toHaveCount(1);
    const add = p.getByRole('button', { name: 'New pane in a folder', exact: true });

    // Cancel leaves the list as it was.
    await add.click();
    const picker = herdr.locator('.herdr-folder-picker');
    await expect(picker.getByRole('heading', { name: 'New pane' })).toBeVisible();
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(picker).toHaveCount(0);

    await add.click();
    // The chooser covers the whole tile and lists folders only.
    const tile = await herdr.boundingBox(),
      cover = await picker.boundingBox();
    expect(cover).toEqual(tile);
    await expect(picker.locator('.files-entry')).toHaveCount(1);
    await expect(picker.getByRole('button', { name: 'notes.txt', exact: true })).toHaveCount(0);
    await expect(picker.getByRole('button', { name: 'Select files' })).toHaveCount(0);
    await expect(picker.getByRole('button', { name: 'Upload files' })).toHaveCount(0);
    await picker.getByRole('button', { name: 'project folder', exact: true }).click();
    await expect(picker.locator('.files-path')).toHaveAttribute('data-path', home + '/project');
    await picker.getByRole('button', { name: 'start here in ~/project', exact: true }).click();

    await expect(picker).toHaveCount(0);
    expect(created).toEqual([{ cwd: home + '/project' }]);
    await expect(herdr.locator('.herdr-detail')).toBeVisible();
    await expect.poll(() => selected.at(-1)).toBe('new:p1');
    await expect(herdr.locator('.herdr-pane[data-pane="new:p1"]')).toHaveAttribute(
      'aria-current',
      'true'
    );
    // Picking a folder leaves the Files app's own mode and recents alone.
    const stored = await p.evaluate(() => [
      localStorage.getItem('omarchy-files-mode'),
      localStorage.getItem('omarchy-files-recents'),
    ]);
    expect(stored).toEqual([null, null]);
  });
}

test('a failed start keeps the chooser open with the host error', async ({ page: p }) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  await p.route(
    url => url.pathname === '/api/files',
    r => r.fulfill({ json: listing(home) })
  );
  await p.route('**/api/herdr/workspaces', r =>
    r.fulfill({ status: 502, json: { error: 'Herdr: socket unavailable' } })
  );
  await p.routeWebSocket('**/api/herdr/ws', ws =>
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: { workspaces: [], tabs: [], panes: [] },
      })
    )
  );
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.getByRole('button', { name: 'New pane in a folder', exact: true }).click();
  const picker = p.locator('.herdr-folder-picker');
  await picker.getByRole('button', { name: 'start here in ~', exact: true }).click();
  await expect(picker.locator('.files-status')).toHaveText('Herdr: socket unavailable');
  await expect(picker.getByRole('button', { name: 'start here in ~', exact: true })).toBeEnabled();
});
