import { test, expect } from './fixtures.mjs';
for (const viewport of [
  { width: 1194, height: 834 },
  { width: 402, height: 874 },
]) {
  test(`Herd pane tabs follow the tile width at ${viewport.width}px`, async ({ page: p }) => {
    await p.setViewportSize(viewport);
    await p.route('**/api/**', r => r.abort());
    let stream;
    const snapshot = {
      workspaces: [{ workspace_id: 'qa', label: 'Tabs QA' }],
      tabs: ['one', 'two', 'three'].map(id => ({ tab_id: id, label: 'Herd ' + id })),
      panes: ['one', 'two', 'three', 'four'].map(pane_id => ({
        pane_id,
        tab_id: pane_id,
        workspace_id: 'qa',
        agent: 'codex',
        terminal_title_stripped: 'Agent ' + pane_id,
      })),
    };
    await p.routeWebSocket('**/api/herdr/ws', ws => {
      stream = ws;
      ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
      ws.onMessage(raw => {
        const m = JSON.parse(raw);
        if (m.type === 'select' && m.pane_id)
          ws.send(
            JSON.stringify({
              type: 'pane',
              pane_id: m.pane_id,
              read: { pane_id: m.pane_id, text: 'Output for ' + m.pane_id },
            })
          );
      });
    });
    await p.goto('/native/');
    await p.keyboard.press('Meta+Shift+A');
    const wide = viewport.width > 600;
    if (wide) await expect(p.locator('.herdr-placeholder')).toBeVisible();
    await p.locator('.herdr-pane').filter({ hasText: 'Herd one' }).click();
    const output = await p.locator('.herdr-output').boundingBox(),
      fit = await p.getByRole('button', { name: 'Fit to Phone', exact: true }).boundingBox();
    // Fit floats inside the output panel rather than crowding the tab row.
    expect(fit.y).toBeGreaterThan(output.y);
    expect(fit.y + fit.height).toBeLessThanOrEqual(output.y + output.height);
    const tabs = p.locator(wide ? '.herdr-list' : '.herdr-pane-tabs:visible');
    const tab = name =>
      wide
        ? tabs.locator('.herdr-pane').filter({ hasText: name })
        : tabs.getByRole('button', { name, exact: true });
    const current = wide ? 'aria-current' : 'aria-pressed';
    await expect(tabs).toBeVisible();
    if (wide) {
      // A full-width tile keeps the whole list as a sidebar and drops the tab row and back key.
      await expect(p.locator('.herdr-placeholder')).toBeHidden();
      await expect(p.locator('.herdr-pane-tabs')).toBeHidden();
      await expect(p.getByRole('button', { name: 'All panes', exact: true })).toBeHidden();
      await expect(p.locator('.herdr-detail-bar')).toBeHidden();
      const bar = await p.locator('.herdr-output').boundingBox(),
        search = await p.locator('.herdr-search-field').boundingBox();
      expect(Math.abs(bar.y - search.y)).toBeLessThan(2);
      await expect(p.locator('.herdr-search')).toBeVisible();
      const list = await tabs.boundingBox(),
        detail = await p.locator('.herdr-detail').boundingBox();
      expect(list.x + list.width).toBeLessThanOrEqual(detail.x);
      expect(detail.x + detail.width).toBeGreaterThan(list.x + list.width + 600);
      await expect(tab('Herd one')).toHaveAttribute('aria-current', 'true');
    } else {
      await expect(tabs.locator('.herdr-project-label')).toBeHidden();
      const row = await tabs.boundingBox(),
        bar = await p.locator('.herdr-detail-bar').boundingBox(),
        back = await p.getByRole('button', { name: 'All panes', exact: true }).boundingBox();
      expect(row.x).toBeGreaterThanOrEqual(back.x + back.width);
      expect(row.x + row.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      expect(Math.abs(row.y + row.height / 2 - (back.y + back.height / 2))).toBeLessThan(2);
    }
    await tab('Herd two').click();
    await expect(tab('Herd two')).toHaveAttribute(current, 'true');
    await expect(tab('Herd one')).toHaveAttribute(current, 'false');
    await expect(p.locator('.herdr-output')).toContainText('Output for two');
    await expect(tab('Agent four')).toBeVisible();
    snapshot.tabs[1].label = 'Renamed in Herd';
    stream.send(JSON.stringify({ type: 'snapshot', snapshot }));
    await expect(tab('Renamed in Herd')).toHaveAttribute(current, 'true');
    await p.locator('.herdr-output').click();
    const composer = p.locator('.herdr-composer');
    await expect(composer).toBeVisible();
    const field = composer.locator('textarea');
    await field.fill('A draft ready for the next step.');
    await expect(
      composer.getByRole('button', { name: 'Send', exact: true }).locator('svg')
    ).toHaveCount(1);
    if (viewport.width > 600) {
      const box = await field.boundingBox();
      for (const name of ['Switch typing mode', 'Send', 'Hide keyboard']) {
        const b = await composer.getByRole('button', { name, exact: true }).boundingBox();
        expect(Math.abs(b.y + b.height / 2 - box.y - box.height / 2)).toBeLessThan(2);
      }
    }
    if (viewport.width > 600) {
      await p.evaluate(() => document.documentElement.classList.add('hardware-keyboard'));
      await expect(
        composer.getByRole('button', { name: 'Hide keyboard', exact: true })
      ).toBeHidden();
    }
    await p.screenshot({ path: `artifacts/browser/herdr-tabs-${viewport.width}.png` });
    if (viewport.width < 600) {
      await composer.getByRole('button', { name: 'Switch typing mode' }).click();
      await expect(composer.getByRole('button', { name: 'Tab', exact: true })).toBeHidden();
      await expect(composer.getByRole('button', { name: 'Ctrl', exact: true })).toBeHidden();
      const mode = await composer.getByRole('button', { name: 'Switch typing mode' }).boundingBox(),
        hide = await composer.getByRole('button', { name: 'Hide keyboard' }).boundingBox();
      for (const name of ['Esc', '←', '↑', '↓', '→']) {
        const b = await composer.getByRole('button', { name, exact: true }).boundingBox();
        expect(b.x).toBeGreaterThanOrEqual(mode.x + mode.width);
        expect(b.x + b.width).toBeLessThanOrEqual(hide.x);
        expect(Math.abs(b.y - mode.y)).toBeLessThan(2);
      }
      await p.screenshot({ path: 'artifacts/browser/herdr-phone-keys.png' });
      await composer.getByRole('button', { name: 'Switch typing mode' }).click();
      await expect(field).toHaveValue('A draft ready for the next step.');
    }
  });
}

test('last tab from another project is separated and swaps when used', async ({ page: p }) => {
  // A half-width tile keeps the tab row; a full-width tile lists every pane instead.
  await p.setViewportSize({ width: 660, height: 900 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [
      { workspace_id: 'a', label: 'Project A' },
      { workspace_id: 'b', label: 'Project B' },
    ],
    tabs: [
      { tab_id: 'a1', label: 'Alpha' },
      { tab_id: 'a2', label: 'Review' },
      { tab_id: 'b1', label: 'Beta' },
    ],
    panes: [
      { pane_id: 'a1', tab_id: 'a1', workspace_id: 'a' },
      { pane_id: 'a2', tab_id: 'a2', workspace_id: 'a' },
      { pane_id: 'b1', tab_id: 'b1', workspace_id: 'b' },
    ],
  };
  let stream;
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'select' && m.pane_id)
        ws.send(
          JSON.stringify({
            type: 'pane',
            pane_id: m.pane_id,
            read: { pane_id: m.pane_id, text: 'Output for ' + m.pane_id },
          })
        );
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').filter({ hasText: 'Alpha' }).click();
  await expect(p.locator('.herdr-project-divider')).toHaveCount(0);
  await p.getByRole('button', { name: 'All panes', exact: true }).click();
  await p.locator('.herdr-pane').filter({ hasText: 'Beta' }).click();
  const tabs = p.locator('.herdr-pane-tabs:visible');
  await expect(tabs.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Return to Project A · Alpha', exact: true }).click();
  await expect(tabs.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Review', exact: true }).click();
  await tabs.getByRole('button', { name: 'Return to Project B · Beta', exact: true }).click();
  await expect(
    tabs.getByRole('button', { name: 'Return to Project A · Review', exact: true })
  ).toBeVisible();
  await expect(tabs.locator('.herdr-project-divider')).toBeVisible();
  await expect(tabs.locator('.herdr-project-label')).toHaveText(['Project B', 'Project A']);
  await p.screenshot({ path: 'artifacts/browser/herdr-recent-project.png' });
  snapshot.panes = snapshot.panes.filter(x => x.pane_id !== 'a2');
  stream.send(JSON.stringify({ type: 'snapshot', snapshot }));
  await expect(
    tabs.getByRole('button', { name: 'Return to Project A · Alpha', exact: true })
  ).toBeVisible();
});
