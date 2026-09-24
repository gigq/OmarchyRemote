import { test, expect } from './fixtures.mjs';
// Herdr reports no cursor, so one is drawn only at a shell prompt: after what was typed, before any
// grey autosuggestion. Full-screen programs such as Vim get none rather than a misplaced one.
test('the Herdr cursor follows a shell prompt and is hidden in full-screen programs', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Cursor QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: [
      { pane_id: 'qa:p1', tab_id: 'qa:t1', workspace_id: 'qa', terminal_title_stripped: 'shell' },
    ],
  };
  let stream;
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    stream = ws;
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
  });
  const show = (text, foreground) =>
    stream.send(
      JSON.stringify({
        type: 'pane',
        pane_id: 'qa:p1',
        read: { pane_id: 'qa:p1', text, foreground },
      })
    );
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').click();
  const cursor = p.locator('#remote-herdr-app .native-terminal-row span[style*="box-shadow"]');
  const before = () => cursor.evaluate(c => c.previousElementSibling?.textContent ?? '');
  // fish: typed "echo hi", suggestion "er.sh" in bright black (palette 8).
  show(
    '~/project\n\x1b[38;2;253;104;131m❯\x1b[0m echo \x1b[4m\x1b[38;5;6mhi\x1b[0m\x1b[38;5;8mer.sh \x1b[0m',
    ['fish']
  );
  await expect(cursor).toHaveText('e');
  expect(await before()).toMatch(/hi$/);
  // No suggestion: the cursor sits after the typed text.
  show('~/project\n❯ ls -la', ['zsh']);
  await expect(p.locator('#remote-herdr-app .native-terminal-row').nth(1)).toContainText('ls -la');
  await expect(cursor).toHaveCount(1);
  expect(await before()).toMatch(/la$/);
  // A full-screen program: no cursor at all.
  show('  1 hello\n~\n~\n NORMAL  notes.txt', ['nvim']);
  await expect(p.locator('#remote-herdr-app .native-terminal-row').first()).toContainText('hello');
  await expect(cursor).toHaveCount(0);
});
