import { test, expect } from './fixtures.mjs';
// Herdr pastes plain input, so Keys mode must mark its keystrokes as typed or editors such as Vim
// insert them literally; a composed message stays a paste.
test('Keys mode types keystrokes while Message mode pastes', async ({ page: p }) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Keys QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [
      { pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', terminal_title_stripped: 'vim' },
    ],
  };
  const inputs = [];
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'select' && m.pane_id)
        ws.send(
          JSON.stringify({
            type: 'pane',
            pane_id: m.pane_id,
            read: { pane_id: m.pane_id, text: '~' },
          })
        );
      if (m.type !== 'input') return;
      inputs.push({ text: m.text, keys: m.keys, typed: m.typed === true });
      ws.send(JSON.stringify({ type: 'ack', id: m.id }));
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  const app = p.locator('#remote-herdr-app');
  await app.locator('.herdr-pane').click();
  await app.locator('.herdr-output').click();
  const message = p.getByRole('textbox', { name: 'Message to host' });
  await message.fill('a composed message');
  await p.keyboard.press('Enter');
  await expect.poll(() => inputs.length).toBe(1);
  // Sending closes the composer; tap the output to reopen it.
  await app.locator('.herdr-output').click();
  await app.locator('[title="Message mode · switch to keys"]').first().click();
  const keys = p.getByRole('textbox', { name: 'Direct terminal keys' });
  await keys.pressSequentially('i');
  await p.keyboard.press('Escape');
  await app.getByRole('button', { name: 'Esc', exact: true }).click();
  await keys.pressSequentially(':');
  await p.keyboard.press('Enter');
  await expect.poll(() => inputs.length).toBe(6);
  expect(inputs).toEqual([
    { text: 'a composed message', keys: ['Enter'], typed: false },
    { text: 'i', keys: [], typed: true },
    { text: '', keys: ['Escape'], typed: true },
    { text: '', keys: ['Escape'], typed: true },
    { text: ':', keys: [], typed: true },
    { text: '', keys: ['Enter'], typed: true },
  ]);
});
