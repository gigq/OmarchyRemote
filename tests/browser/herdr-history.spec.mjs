import { test, expect } from './fixtures.mjs';
// Herdr sends the last 300 lines while following and up to 1000 while reading back.
test('scrolling back loads deeper Herdr history without moving the reader', async ({ page: p }) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'History QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [
      {
        pane_id: 'qa:p1',
        tab_id: 'qa:t1',
        workspace_id: 'qa',
        agent: 'claude',
        terminal_title_stripped: 'agent',
      },
    ],
  };
  const lines = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => `response line ${from + i}`).join('\n');
  const history = [];
  let stream;
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      const send = text =>
        ws.send(
          JSON.stringify({ type: 'pane', pane_id: 'qa:p1', read: { pane_id: 'qa:p1', text } })
        );
      if (m.type === 'select' && m.pane_id) send(lines(1701, 2000));
      if (m.type === 'history') {
        history.push(m.deep);
        send(m.deep ? lines(1001, 2000) : lines(1701, 2000));
      }
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').click();
  const rows = p.locator('#remote-herdr-app .native-terminal-row');
  await expect(rows.filter({ hasText: 'response line 2000' })).toHaveCount(1);
  // Scroll to the top of what was loaded: line 1701.
  await p.locator('#remote-herdr-app .native-terminal-scroll').evaluate(s => {
    s.scrollTop = 0;
    s.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => history).toEqual([true]);
  // The deeper read arrives; the reader stays on line 1701 and can scroll further up.
  await expect(rows.filter({ hasText: /^response line 1701\s*$/ })).toBeVisible();
  const scroller = p.locator('#remote-herdr-app .native-terminal-scroll');
  expect(await scroller.evaluate(s => s.scrollTop)).toBeGreaterThan(0);
  await scroller.evaluate(s => {
    s.scrollTop = 0;
    s.dispatchEvent(new Event('scroll'));
  });
  await expect(rows.filter({ hasText: /^response line 1001\s*$/ })).toBeVisible();
  // Back to the latest output: the normal depth again.
  await p.getByRole('button', { name: '↓ Latest' }).click();
  await expect.poll(() => history).toEqual([true, false]);
  await expect(rows.filter({ hasText: 'response line 2000' })).toBeVisible();
});

// Agent replies are full of blank lines and repeated rules, so a single line cannot anchor the view.
for (const rowsUp of [1, 2, 3, 4, 5, 6, 7, 8, 9])
  test(`scrolling up ${rowsUp} rows keeps the same lines in view when history loads`, async ({
    page: p,
  }) => {
    await p.setViewportSize({ width: 402, height: 874 });
    await p.route('**/api/**', r => r.abort());
    const snapshot = {
      workspaces: [{ workspace_id: 'qa', label: 'History QA' }],
      tabs: [{ tab_id: 'qa:t1', label: '1' }],
      panes: [{ pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', agent: 'claude' }],
    };
    const lines = (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => {
        const n = from + i;
        return n % 10 === 0 ? `paragraph ${n}` : n % 10 === 5 ? '────────' : '';
      }).join('\n');
    const history = [];
    let release;
    const held = new Promise(r => (release = r));
    await p.routeWebSocket('**/api/herdr/ws', ws => {
      ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
      ws.onMessage(async raw => {
        const m = JSON.parse(raw);
        const send = text =>
          ws.send(
            JSON.stringify({ type: 'pane', pane_id: 'qa:p1', read: { pane_id: 'qa:p1', text } })
          );
        if (m.type === 'select' && m.pane_id) send(lines(1701, 2000));
        if (m.type === 'history') {
          history.push(m.deep);
          if (m.deep) await held;
          send(m.deep ? lines(1001, 2000) : lines(1701, 2000));
        }
      });
    });
    await p.goto('/native/');
    await p.keyboard.press('Meta+Shift+A');
    await p.locator('.herdr-pane').click();
    const scroller = p.locator('#remote-herdr-app .native-terminal-scroll');
    await expect(
      p.locator('#remote-herdr-app .native-terminal-row', { hasText: 'paragraph 2000' })
    ).toHaveCount(1);
    const inView = () =>
      scroller.evaluate(s => {
        const box = s.getBoundingClientRect();
        return [...s.querySelectorAll('.native-terminal-row')]
          .filter(r => {
            const b = r.getBoundingClientRect();
            return (
              b.top >= box.top && b.bottom <= box.bottom && r.textContent.includes('paragraph')
            );
          })
          .map(r => r.textContent.trim());
      });
    // A short upward scroll, landing on blank lines between paragraphs.
    await scroller.evaluate((s, rowsUp) => {
      const row = s.querySelector('.native-terminal-row').getBoundingClientRect().height;
      s.scrollTop = s.scrollHeight - s.clientHeight - row * rowsUp;
      s.dispatchEvent(new Event('scroll'));
    }, rowsUp);
    await expect.poll(() => history).toEqual([true]);
    const before = await inView();
    expect(before.length).toBeGreaterThan(2);
    const height = await scroller.evaluate(s => s.scrollHeight);
    release();
    await expect.poll(() => scroller.evaluate(s => s.scrollHeight)).toBeGreaterThan(height * 2);
    await expect.poll(inView).toEqual(before);
  });
