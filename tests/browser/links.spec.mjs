import { test, expect } from './fixtures.mjs';

// A native app's web view, as the iOS, Android and desktop apps offer it, recording each command.
async function nativeWebView(page) {
  await page.addInitScript(() => {
    window.webCommands = [];
    window.webkit = {
      messageHandlers: {
        browserDevice: {
          postMessage: async message => {
            webCommands.push(message);
            return message.action === 'capabilities' ? { embedded: true, webApps: true } : {};
          },
        },
      },
    };
  });
}
const opened = page =>
  page.evaluate(() =>
    webCommands.filter(c => c.action === 'open' && c.appID === 'webapp-link').map(c => c.url)
  );

test('web addresses in terminal output are found whole, however they were wrapped', async ({
  page,
}) => {
  await page.goto('/native/');
  const found = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:400px;height:300px';
    document.body.append(host);
    const term = new Terminal({ cols: 40, rows: 12 });
    term.open(host);
    const view = new NativeTerminalView(
      host,
      term,
      () => {},
      () => {}
    );
    // An agent breaks a long address at its width and indents the rest.
    const lines = [
      '',
      '  443/curiosity/play/ and more',
      'plain (see https://example.com/b).',
      'two https://a.example/x and http://b.example/y',
      // The terminal itself wraps an address longer than a line.
      'x https://example.com/' + 'a'.repeat(50),
    ];
    // The first line fills the width exactly, as the agent's wrapping does.
    lines[0] = '  live: https://tars.example.net:' + '6'.repeat(40 - 33);
    await new Promise(r => term.write(lines.join('\r\n'), r));
    const links = view.links(0, 12);
    const urls = new Set();
    for (const parts of links.values()) for (const part of parts) urls.add(part.link.url);
    const underlined = [...links.get(1)].map(p => [p.start, p.end]);
    view.dispose();
    term.dispose();
    host.remove();
    return { urls: [...urls], underlined };
  });
  expect(found.urls).toEqual([
    'https://tars.example.net:6666666443/curiosity/play/',
    'https://example.com/b',
    'https://a.example/x',
    'http://b.example/y',
    'https://example.com/' + 'a'.repeat(50),
  ]);
  // The rest of a broken address is underlined from its indent, not the words after it.
  expect(found.underlined).toEqual([[2, 21]]);
});

test('a tapped address in Terminal opens in the browser window, straight to the page', async ({
  page,
}) => {
  await nativeWebView(page);
  await page.route('**/api/terminal/session', r => r.fulfill({ json: { id: 'qa-links' } }));
  const text = 'docs at https://example.com/docs.\r\n$ ';
  await page.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(
      JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: Array.from(Buffer.from(text)) })
    );
    ws.onMessage(() => {});
  });
  await page.goto('/native/');
  await page.getByText('terminal', { exact: true }).first().click();
  const link = page
    .locator('#remote-terminal-app .native-terminal-row span')
    .filter({ hasText: 'example.com' })
    .first();
  await expect(link).toHaveCSS('text-decoration-line', 'underline');
  await link.click();
  await expect.poll(() => opened(page)).toEqual(['https://example.com/docs']);
  const web = page.locator('#remote-web-app');
  await expect(web).toBeVisible();
  await expect(web.locator('.web-address')).toHaveText('example.com/docs');
  // The page goes under the bar, in the native view.
  await expect
    .poll(() =>
      page.evaluate(() =>
        webCommands.some(c => c.action === 'layout' && c.appID === 'webapp-link' && c.visible)
      )
    )
    .toBe(true);
  await page.screenshot({ path: 'artifacts/browser/links-web.png' });
  // The browser window is not offered among the apps.
  await page.evaluate(() => HyprlandApps.logic.set({ launch: true }));
  await expect(page.getByRole('button', { name: /links opened from apps/ })).toHaveCount(0);
});

test('a link in a Chat reply opens in the browser window', async ({ page }) => {
  await nativeWebView(page);
  const ID = '1b8ab544-8cc5-430e-8a40-0aec58bc3b10';
  await page.route('**/api/**', r => r.abort());
  await page.route('**/api/chat', r =>
    r.fulfill({
      json: {
        folder: '~/Chats',
        available: true,
        agents: [{ id: 'claude', label: 'Claude', models: [], efforts: [], defaults: {} }],
        chats: [{ id: ID, title: 'Docs', preview: 'See', updated: new Date().toISOString() }],
      },
    })
  );
  await page.route(/\/api\/chat\/[0-9a-f-]{36}$/, r =>
    r.fulfill({
      json: {
        id: ID,
        title: 'Docs',
        entries: [
          { role: 'user', text: 'Where are the docs?', time: '2026-10-28T10:00:00Z' },
          {
            role: 'assistant',
            text: 'See [the docs](https://example.com/guide) or https://example.org/faq.',
            time: '2026-10-28T10:00:01Z',
          },
        ],
        busy: false,
        partial: '',
        seq: 0,
        n: 0,
      },
    })
  );
  await page.routeWebSocket('**/api/chat/ws', () => {});
  await page.goto('/native/');
  await page.getByText('chat', { exact: true }).first().click();
  await page.locator('.chat-row').click();
  await page.getByRole('link', { name: 'the docs' }).click();
  await expect.poll(() => opened(page)).toEqual(['https://example.com/guide']);
  await expect(page.locator('#remote-web-app')).toBeVisible();
  // A second link reuses the window.
  await page.evaluate(() => HyprlandApps.logic.openApp('chat'));
  await page.getByRole('link', { name: 'https://example.org/faq' }).click();
  await expect
    .poll(() => opened(page))
    .toEqual(['https://example.com/guide', 'https://example.org/faq']);
  await expect(page.locator('#remote-web-app .web-address')).toHaveText('example.org/faq');
});

test('without a native web view, a link opens in a new browser tab', async ({ page }) => {
  await page.addInitScript(() => {
    window.openedTabs = [];
    window.open = url => {
      openedTabs.push(url);
      return null;
    };
  });
  await page.goto('/native/');
  await page.evaluate(() => HyprlandLinks.open('https://example.com/tab'));
  expect(await page.evaluate(() => openedTabs)).toEqual(['https://example.com/tab']);
  expect(await page.evaluate(() => HyprlandApps.logic.state.open.includes('web'))).toBe(false);
  // Only web addresses open.
  expect(await page.evaluate(() => HyprlandLinks.open('javascript:alert(1)'))).toBe(false);
});
