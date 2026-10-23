import { test, expect } from './fixtures.mjs';
// On a computer (a mouse or trackpad, no touch), typing comes from real keys: Terminal takes it
// directly, as a desktop terminal would, and Herdr keeps its message box but not the touch key row.
test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 800 } });

async function terminal(p) {
  const inputs = [];
  await p.route('**/api/terminal/session', r => r.fulfill({ json: { id: 'qa-desktop' } }));
  await p.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: [36, 32] }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'input') inputs.push(m.data);
    });
  });
  return inputs;
}

test('a computer types straight into Terminal, with no message box or key row', async ({
  page: p,
}) => {
  const inputs = await terminal(p);
  await p.goto('/native/');
  await p.keyboard.press('Meta+Enter');
  const root = p.locator('#remote-terminal-app');
  await expect(root.locator('.remote-status')).toBeHidden();
  await expect(root.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(root.locator('.native-input-panel')).toBeHidden();
  await expect(root.getByRole('button', { name: 'Esc', exact: true })).toBeHidden();
  await p.keyboard.type('ls');
  // Keys a touch panel could not send reach the shell as a terminal sends them.
  for (const key of ['Home', 'Delete', 'Control+c', 'Alt+b', 'F5', 'Enter'])
    await p.keyboard.press(key);
  await expect
    .poll(() => inputs.join(''))
    .toBe('ls' + '\x1b[H' + '\x1b[3~' + '\x03' + '\x1bb' + '\x1b[15~' + '\r');
  // A click on the output keeps typing in the terminal.
  await root.locator('.native-terminal-scroll').click();
  await expect(root.locator('.xterm-helper-textarea')).toBeFocused();
  await p.screenshot({ path: 'artifacts/browser/desktop-terminal.png' });
});

test('a computer keeps Herdr’s message box but leaves out the touch key row', async ({
  page: p,
}) => {
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Desktop QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [
      { pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', terminal_title_stripped: 'claude' },
    ],
  };
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'select' && m.pane_id)
        ws.send(
          JSON.stringify({
            type: 'pane',
            pane_id: m.pane_id,
            read: { pane_id: m.pane_id, text: '>' },
          })
        );
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  const app = p.locator('#remote-herdr-app');
  await app.locator('.herdr-pane').click();
  await app.locator('.herdr-output').click();
  await expect(p.getByRole('textbox', { name: 'Message to host' })).toBeVisible();
  await app.locator('[title="Message mode · switch to keys"]').first().click();
  await expect(p.getByRole('textbox', { name: 'Direct terminal keys' })).toBeVisible();
  await expect(app.locator('.native-input-tools')).toBeHidden();
  await expect(app.getByRole('button', { name: 'Ctrl', exact: true })).toBeHidden();
  await p.screenshot({ path: 'artifacts/browser/desktop-herdr.png' });
});

test.describe('on a phone', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 402, height: 874 } });
  test('Terminal keeps its typing panel and key row', async ({ page: p }) => {
    await terminal(p);
    await p.goto('/native/');
    await p.keyboard.press('Meta+Enter');
    const root = p.locator('#remote-terminal-app');
    await root.locator('.native-terminal-scroll').click();
    await expect(root.locator('textarea.native-input')).toBeVisible();
    await expect(root.getByRole('button', { name: 'Esc', exact: true })).toBeVisible();
  });
});
