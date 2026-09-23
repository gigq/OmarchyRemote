import { test, expect } from './fixtures.mjs';
// Each refresh rebuilds the pane from a snapshot; the output must never paint blank or half-written
// frames in between, which flashed the text on slower Chromium renderers (Android, Electron).
test('Herdr output refreshes without blank frames on a slow renderer', async ({ page: p }) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Refresh QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [
      {
        pane_id: 'qa:p1',
        tab_id: 'qa:t1',
        workspace_id: 'qa',
        agent: 'codex',
        terminal_title_stripped: 'Refresh agent',
      },
    ],
  };
  const output = n =>
    Array.from(
      { length: 300 },
      (_, i) =>
        `\x1b[3${i % 7}mline ${i} of update ${n}\x1b[0m ${'lorem ipsum dolor sit amet '.repeat(3)}`
    ).join('\n');
  let stream;
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
  });
  const send = n =>
    stream.send(
      JSON.stringify({
        type: 'pane',
        pane_id: 'qa:p1',
        read: { pane_id: 'qa:p1', text: output(n) },
      })
    );
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').click();
  send(0);
  const rows = p.locator('#remote-herdr-app .native-terminal-row');
  await expect(rows.filter({ hasText: 'line 299 of update 0' })).toHaveCount(1);
  // Record the visible text on every frame while slowed down like an older phone.
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });
  await p.evaluate(() => {
    window.qaFrames = [];
    const view = document.querySelector('#remote-herdr-app .native-terminal-content');
    const tick = () => {
      window.qaFrames.push(
        [...view.querySelectorAll('.native-terminal-row')].filter(r => r.textContent.trim()).length
      );
      if (window.qaFrames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let n = 1; n <= 4; n++) {
    send(n);
    await expect(rows.filter({ hasText: `line 299 of update ${n}` })).toHaveCount(1, {
      timeout: 15000,
    });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const frames = await p.evaluate(() => window.qaFrames);
  const full = Math.max(...frames);
  expect(full).toBeGreaterThan(10);
  // Every frame shows a full screen of text; none is blank or partly written.
  expect(frames.filter(count => count < full)).toEqual([]);
});
