import { test, expect } from './fixtures.mjs';
// With a hardware keyboard the composer reclaims focus after every tap; selecting output must not.
test('Herdr output text can be selected without the composer taking it back', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 1194, height: 834 });
  await p.addInitScript(() => {
    window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
  });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Select QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [{ pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', agent: 'claude' }],
  };
  const read = text =>
    JSON.stringify({ type: 'pane', pane_id: 'qa:p1', read: { pane_id: 'qa:p1', text } });
  const reply = marker =>
    Array.from({ length: 30 }, (_, i) => `${marker} reply line ${i + 1} with words to select`).join(
      '\n'
    );
  let stream;
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      if (JSON.parse(raw).type === 'select') ws.send(read(reply('first')));
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').click();
  const app = p.locator('#remote-herdr-app');
  const composer = app.locator('textarea.native-input');
  const rows = app.locator('.native-terminal-row');
  await expect(rows.filter({ hasText: 'first reply line 30' })).toHaveCount(1);
  await expect(composer).toBeFocused();

  const selected = () => p.evaluate(() => getSelection().toString());
  // An iOS long press blurs the composer first and selects while the finger is still down.
  const row = rows.filter({ hasText: 'first reply line 10 ' });
  await row.evaluate(row => {
    const touch = new Touch({ identifier: 1, target: row, clientX: 200, clientY: 10 });
    row.dispatchEvent(
      new TouchEvent('touchstart', { touches: [touch], changedTouches: [touch], bubbles: true })
    );
    document.activeElement.blur();
  });
  await p.waitForTimeout(300);
  await row.evaluate(row => {
    getSelection().selectAllChildren(row);
    const touch = new Touch({ identifier: 1, target: row, clientX: 200, clientY: 10 });
    row.dispatchEvent(
      new TouchEvent('touchend', { touches: [], changedTouches: [touch], bubbles: true })
    );
  });
  await p.waitForTimeout(300);
  expect(await selected()).toContain('first reply line 10');
  await expect(composer).not.toBeFocused();
  await p.evaluate(() => getSelection().removeAllRanges());
  await expect(composer).toBeFocused();

  // Drag across two lines, as with an iPad trackpad.
  const from = await rows.filter({ hasText: 'first reply line 20 ' }).boundingBox();
  const to = await rows.filter({ hasText: 'first reply line 22 ' }).boundingBox();
  await p.mouse.move(from.x + 60, from.y + from.height / 2);
  await p.mouse.down();
  await p.mouse.move(to.x + 120, to.y + to.height / 2, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  expect(await selected()).toContain('reply line 21');
  await expect(composer).not.toBeFocused();

  // New output waits while the selection is up, so it is not wiped.
  stream.send(read(reply('second')));
  await p.waitForTimeout(300);
  expect(await selected()).toContain('first reply line 21');
  await expect(rows.filter({ hasText: 'second reply' })).toHaveCount(0);

  // Clearing the selection shows the new output and returns focus to the composer.
  await p.evaluate(() => getSelection().removeAllRanges());
  await expect(rows.filter({ hasText: 'second reply line 30' })).toHaveCount(1);
  await expect(composer).toBeFocused();
});
