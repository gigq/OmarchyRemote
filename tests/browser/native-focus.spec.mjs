import { test, expect } from './fixtures.mjs';

test('native focus follows active apps, survives closing Terminal and rejects stale requests', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.addInitScript(() => {
    window.__HYPRLAND_NATIVE_FOCUS__ = true;
    window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
    window.focusRequests = [];
    window.webkit = {
      messageHandlers: {
        shellKeyboard: {
          postMessage: message => {
            if (message.focusRequest) focusRequests.push(message.focusRequest);
          },
        },
      },
    };
    localStorage.setItem('omarchy-herdr-pane', 'qa-focus');
  });
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Focus QA' }],
    tabs: [{ tab_id: 'qa', label: 'Focus thread' }],
    panes: [
      {
        pane_id: 'qa-focus',
        tab_id: 'qa',
        workspace_id: 'qa',
        agent: 'codex',
        agent_status: 'working',
      },
    ],
  };
  await page.route('**/api/herdr/snapshot', route => route.fulfill({ json: snapshot }));
  await page.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(() => {});
  });
  await page.route('**/api/terminal/session', route =>
    route.fulfill({ json: { id: 'qa-focus-terminal' } })
  );
  await page.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: [36, 32] }));
    ws.onMessage(() => {});
  });
  await page.goto('/native/');
  const latest = () => page.evaluate(() => focusRequests.at(-1));
  const deliver = token =>
    page.evaluate(token => {
      if (!HyprlandRemote.focusFromNative(token, false)) return false;
      return HyprlandRemote.focusFromNative(token, true);
    }, token);
  await page.keyboard.press('Meta+Shift+A');
  const composer = page.locator('#remote-herdr-app textarea.native-input');
  await expect(composer).toBeVisible();
  await page.waitForTimeout(400);
  const herdRequest = await latest();
  expect(
    await page.evaluate(token => {
      const before = document.activeElement;
      return HyprlandRemote.focusFromNative(token, false) && document.activeElement === before;
    }, herdRequest)
  ).toBe(true);
  expect(await deliver(herdRequest)).toBe(true);
  await expect(composer).toBeFocused();
  await page.keyboard.type('unsent draft');
  await page.keyboard.press('Meta+Enter');
  const terminal = page.locator('#remote-terminal-app textarea.native-input');
  await expect.poll(latest).not.toBe(herdRequest);
  expect(await deliver(herdRequest)).toBe(false);
  await page.waitForTimeout(400);
  expect(await deliver(await latest())).toBe(true);
  await expect(terminal).toBeFocused();
  const terminalRequest = await latest();
  await page.keyboard.press('Meta+w');
  await expect.poll(latest).not.toBe(terminalRequest);
  await expect(composer).toBeVisible();
  await page.waitForTimeout(400);
  expect(await deliver(await latest())).toBe(true);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('unsent draft');
  // A queued request must not take the keyboard away from a newly opened launcher.
  const previous = await latest();
  await page.keyboard.press('Meta+k');
  expect(await deliver(previous)).toBe(false);
  await expect(page.getByRole('searchbox', { name: 'Search apps, panes and files' })).toBeFocused();
});
