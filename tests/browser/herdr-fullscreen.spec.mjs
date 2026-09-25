import { test, expect } from './fixtures.mjs';
// Vim and other full-screen programs are shown at their own size, never wrapped by Fit.
test('a full-screen Herdr program keeps its layout and Fit returns afterwards', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Screen QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [
      { pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', terminal_title_stripped: 'vim' },
    ],
  };
  const wide = 'status ' + 'x'.repeat(140) + ' END';
  const screen = (marker, fullscreen) => ({
    type: 'pane',
    pane_id: 'qa:p1',
    read: { pane_id: 'qa:p1', text: `${marker}\n${wide}`, fullscreen, foreground: ['nvim'] },
  });
  let stream;
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'select' && m.pane_id) ws.send(JSON.stringify(screen('shell', false)));
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').click();
  const rows = p.locator('#remote-herdr-app .native-terminal-row');
  const fit = p.getByRole('button', { name: 'Fit to Phone', exact: true });
  const scroller = p.locator('#remote-herdr-app .native-terminal-scroll');
  const wraps = () => scroller.evaluate(s => s.scrollWidth <= s.clientWidth);
  await expect(rows.filter({ hasText: 'shell' })).toHaveCount(1);
  await expect(fit).toHaveText('Fit');
  await expect(fit).toBeEnabled();
  expect(await wraps()).toBe(true);
  expect(await rows.filter({ hasText: 'END' }).count()).toBe(1);
  expect(await rows.count()).toBeGreaterThan(2);

  stream.send(JSON.stringify(screen('vim', true)));
  await expect(rows.filter({ hasText: 'vim' })).toHaveCount(1);
  await expect(fit).toBeDisabled();
  await expect.poll(wraps).toBe(false);
  await expect(rows.filter({ hasText: 'END' })).toContainText('status');
  // The saved preference is untouched, so leaving Vim wraps again.
  expect(await p.evaluate(() => localStorage.getItem('omarchy-herdr-fit'))).not.toBe('false');

  stream.send(JSON.stringify(screen('back', false)));
  await expect(rows.filter({ hasText: 'back' })).toHaveCount(1);
  await expect(fit).toBeEnabled();
  await expect.poll(wraps).toBe(true);
});

test('a full-screen agent keeps Fit so its replies still wrap', async ({ page: p }) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Agent QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [{ pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', agent: 'claude' }],
  };
  const text = 'reply\n' + 'word '.repeat(40) + 'END';
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'select' && m.pane_id)
        ws.send(
          JSON.stringify({
            type: 'pane',
            pane_id: 'qa:p1',
            read: { pane_id: 'qa:p1', text, fullscreen: true, foreground: ['claude'] },
          })
        );
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').click();
  const rows = p.locator('#remote-herdr-app .native-terminal-row');
  await expect(rows.filter({ hasText: 'reply' })).toHaveCount(1);
  await expect(p.getByRole('button', { name: 'Fit to Phone', exact: true })).toBeEnabled();
  expect(
    await p
      .locator('#remote-herdr-app .native-terminal-scroll')
      .evaluate(s => s.scrollWidth <= s.clientWidth)
  ).toBe(true);
  await expect(rows.filter({ hasText: 'END' })).not.toContainText('reply');
});
