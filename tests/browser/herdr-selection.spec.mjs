import { test, expect } from './fixtures.mjs';
test('Herd selection survives output refresh and does not trigger tap-to-type', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  let stream;
  const pane = 'selection-qa';
  const read = text => ({ type: 'pane', pane_id: pane, read: { pane_id: pane, text } });
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          workspaces: [{ workspace_id: 'qa', label: 'Selection QA' }],
          tabs: [{ tab_id: 'tab', label: 'Copy test' }],
          panes: [{ pane_id: pane, tab_id: 'tab', workspace_id: 'qa' }],
        },
      })
    );
    ws.onMessage(raw => {
      if (JSON.parse(raw).type === 'select') ws.send(JSON.stringify(read('Copy this sample text')));
    });
  });
  await p.goto('/native/');
  // This verifies touch-only selection; a hardware launch intentionally enables input.
  await p.getByText('herdr', { exact: true }).first().click();
  await p.locator('.herdr-pane').click();
  const output = p.locator('.herdr-output .native-terminal-content');
  await expect(output).toContainText('Copy this sample text');
  await expect(output).toHaveCSS('user-select', 'text');
  await output.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el.querySelector('.native-terminal-row'));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  });
  const selected = await p.evaluate(() => getSelection().toString());
  expect(selected).toContain('Copy this sample text');
  await output.dispatchEvent('click', { bubbles: true });
  await expect(p.locator('.native-input:visible')).toHaveCount(0);
  stream.send(JSON.stringify(read('New host output')));
  await p.waitForTimeout(400);
  expect(await p.evaluate(() => getSelection().toString())).toBe(selected);
  await p.evaluate(() => getSelection().removeAllRanges());
  await expect(output).toContainText('New host output');
  await output.click();
  await expect(p.getByRole('textbox', { name: 'Message to host' })).toBeFocused();
});
