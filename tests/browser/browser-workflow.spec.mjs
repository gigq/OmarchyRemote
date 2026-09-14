import { test, expect } from './fixtures.mjs';
const LAST = 'omarchy-browser-last-tab';
const snapshot = () => ({
  instances: [
    {
      id: 'connection-new',
      profile_id: 'profile-one',
      label: 'Vivaldi',
      workspaces: [],
      windows: [
        {
          id: 1,
          tabs: [
            { id: 10, index: 0, url: 'https://example.com/', title: 'Example' },
            { id: 11, index: 1, url: 'https://example.org/', title: 'Second' },
          ],
        },
      ],
    },
    {
      id: 'connection-two',
      profile_id: 'profile-two',
      label: 'Other profile',
      workspaces: [],
      windows: [
        {
          id: 2,
          tabs: [{ id: 10, index: 0, url: 'https://example.net/', title: 'Other profile tab' }],
        },
      ],
    },
  ],
});
async function setup(p, saved, viewport = { width: 1194, height: 834 }) {
  const state = { data: snapshot(), actions: [] };
  await p.setViewportSize(viewport);
  await p.route('**/api/**', r => r.abort());
  await p.route('**/api/browser/snapshot', r => r.fulfill({ json: state.data }));
  await p.route('**/api/browser/action', r => {
    const q = r.request().postDataJSON();
    state.actions.push(q);
    const i = state.data.instances.find(i => i.id === q.instance_id);
    let result = {};
    if (q.action === 'close')
      for (const w of i.windows) w.tabs = w.tabs.filter(t => t.id !== q.tab_id);
    if (q.action === 'create') {
      const w = i.windows.find(w => w.id === q.window_id) || i.windows[0];
      const id = 20 + state.actions.length;
      w.tabs.push({ id, index: w.tabs.length, url: q.url, title: 'Created' });
      result = { tab_id: id };
    }
    return r.fulfill({ json: { ok: true, result } });
  });
  await p.addInitScript(
    ({ saved, LAST }) => {
      if (saved && !sessionStorage.seeded) {
        localStorage.setItem(LAST, JSON.stringify(saved));
        sessionStorage.seeded = '1';
      }
      window.browserCommands = [];
      window.findVisible = false;
      window.webkit = {
        messageHandlers: {
          browserDevice: {
            postMessage: async q => {
              window.browserCommands.push(q);
              if (q.action === 'findOpen' || q.action === 'findNext') window.findVisible = true;
              if (q.action === 'findClose') {
                const closed = window.findVisible;
                window.findVisible = false;
                return { closed };
              }
              return q.action === 'capabilities'
                ? { embedded: true, shortcuts: true, nativeFind: true }
                : {};
            },
          },
        },
      };
    },
    { saved, LAST }
  );
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+b');
  await expect(p.locator('#remote-browser-app')).toBeVisible();
  return state;
}
const opened = p =>
  p.evaluate(() => window.browserCommands.filter(q => q.action === 'open').map(q => q.url));
const key = (p, code, extra = {}) => p.evaluate(q => HyprlandDesk.nativeKey(q), { code, ...extra });
test('last tab resumes across app reload and bridge reconnect using its stable profile', async ({
  page: p,
}) => {
  await setup(p, { profile_id: 'profile-one', instance_id: 'connection-old', tab_id: 11 });
  await expect.poll(() => opened(p)).toEqual(['https://example.org/']);
  await p.keyboard.press('Meta+Shift+l');
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeFocused();
  await p.getByRole('link', { name: 'Open Example on phone', exact: true }).click();
  await p.reload();
  await p.keyboard.press('Meta+Shift+b');
  await expect.poll(() => opened(p)).toEqual(['https://example.com/']);
});
test('closed and internal saved tabs fall back to manager without opening another profile tab', async ({
  page: p,
}) => {
  const state = await setup(p, { profile_id: 'profile-one', instance_id: 'old', tab_id: 99 });
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeVisible();
  await expect.poll(() => p.evaluate(LAST => localStorage.getItem(LAST), LAST)).toBe(null);
  expect(await opened(p)).toEqual([]);
  state.data.instances[0].windows[0].tabs[0].url = 'vivaldi://settings';
  await p.evaluate(
    LAST => localStorage.setItem(LAST, JSON.stringify({ profile_id: 'profile-one', tab_id: 10 })),
    LAST
  );
  await p.reload();
  await p.keyboard.press('Meta+Shift+b');
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeVisible();
  await expect.poll(() => p.evaluate(LAST => localStorage.getItem(LAST), LAST)).toBe(null);
  expect(await opened(p)).toEqual([]);
});
test('a disconnected saved profile retries but explicit tab manager interaction cancels restoration', async ({
  page: p,
}) => {
  const state = await setup(p, { profile_id: 'late-profile', tab_id: 30 });
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeVisible();
  state.data.instances.push({
    id: 'late',
    profile_id: 'late-profile',
    label: 'Late',
    workspaces: [],
    windows: [
      { id: 3, tabs: [{ id: 30, index: 0, title: 'Late tab', url: 'https://example.edu/' }] },
    ],
  });
  await p.getByRole('button', { name: 'Refresh tabs' }).click();
  await expect.poll(() => opened(p)).toEqual(['https://example.edu/']);
  await p.keyboard.press('Meta+Shift+l');
  await p.waitForTimeout(2200);
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeVisible();
});
test('browser shortcuts route before shell keys, including native page focus and dialogs', async ({
  page: p,
}) => {
  await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  await expect
    .poll(() =>
      p.evaluate(() => window.browserCommands.filter(q => q.action === 'context').at(-1)?.active)
    )
    .toBe(true);
  await key(p, 'KeyL');
  await expect(p.getByRole('textbox', { name: 'Page address' })).toBeFocused();
  await p.getByRole('button', { name: 'Browser options' }).click();
  await key(p, 'KeyF');
  await expect(p.getByRole('dialog', { name: 'Browser options' })).toBeHidden();
  await expect.poll(() => p.evaluate(() => window.findVisible)).toBe(true);
  await key(p, 'KeyG', { shift: true });
  await expect
    .poll(() =>
      p.evaluate(() => window.browserCommands.filter(q => q.action === 'findNext').at(-1))
    )
    .toMatchObject({ backwards: true });
  await key(p, 'Escape', { plain: true });
  await expect.poll(() => p.evaluate(() => window.findVisible)).toBe(false);
  expect(await p.evaluate(() => window.browserCommands.some(q => q.action === 'stop'))).toBe(false);
  for (const [code, extra, action] of [
    ['KeyR', {}, 'reload'],
    ['KeyR', { shift: true }, 'reload'],
    ['BracketLeft', {}, 'back'],
    ['BracketRight', {}, 'forward'],
    ['Equal', {}, 'zoom'],
    ['Minus', {}, 'zoom'],
    ['Digit0', {}, 'zoom'],
    ['F5', { plain: true }, 'reload'],
  ]) {
    await key(p, code, extra);
    await expect
      .poll(() =>
        p.evaluate(action => window.browserCommands.filter(q => q.action === action).length, action)
      )
      .toBeGreaterThan(0);
  }
  expect(
    await p.evaluate(() => window.browserCommands.some(q => q.action === 'reload' && q.bypassCache))
  ).toBe(true);
  await key(p, 'Tab', { ctrl: true });
  await expect.poll(() => opened(p)).toEqual(['https://example.com/', 'https://example.org/']);
  await key(p, 'Digit1');
  await expect.poll(() => opened(p)).toHaveLength(3);
  await key(p, 'KeyT');
  await expect(p.getByRole('dialog', { name: 'New desktop tab' })).toBeVisible();
  await expect
    .poll(() =>
      p.evaluate(() => window.browserCommands.filter(q => q.action === 'layout').at(-1)?.visible)
    )
    .toBe(false);
  await key(p, 'Escape', { plain: true });
  await expect(p.getByRole('dialog', { name: 'New desktop tab' })).toHaveCount(0);
  await key(p, 'KeyL', { shift: true });
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeFocused();
  await key(p, 'KeyW', { shift: true });
  await expect
    .poll(() => p.evaluate(() => window.browserCommands.some(q => q.action === 'close')))
    .toBe(true);
  await p.keyboard.press('Meta+Enter');
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
});
test('close, reopen and new tab shortcuts update the exact desktop tab and open the result', async ({
  page: p,
}) => {
  const state = await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  await key(p, 'KeyW');
  await expect
    .poll(() => state.actions.filter(q => q.action === 'close'))
    .toEqual([{ instance_id: 'connection-new', action: 'close', tab_id: 10 }]);
  await expect.poll(() => opened(p)).toEqual(['https://example.com/', 'https://example.org/']);
  await key(p, 'KeyT', { shift: true });
  await expect
    .poll(() => opened(p))
    .toEqual(['https://example.com/', 'https://example.org/', 'https://example.com/']);
  expect(state.actions.at(-1)).toMatchObject({
    instance_id: 'connection-new',
    action: 'create',
    url: 'https://example.com/',
    window_id: 1,
  });
  await key(p, 'KeyT');
  await p.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.edu/');
  await p.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => opened(p)).toHaveLength(4);
  expect((await opened(p)).at(-1)).toBe('https://example.edu/');
});
test('an open page follows bridge reconnections and falls back when its desktop tab closes', async ({
  page: p,
}) => {
  const state = await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  state.data.instances[0].id = 'reconnected';
  await p.keyboard.press('Meta+Shift+l');
  await p.getByRole('button', { name: 'Refresh tabs' }).click();
  await p.getByRole('button', { name: 'Return to page' }).click();
  await p.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('host-browser-state', {
        detail: { url: 'https://example.com/new', loading: false },
      })
    )
  );
  await expect
    .poll(() => state.actions.at(-1))
    .toMatchObject({ instance_id: 'reconnected', tab_id: 10, action: 'navigate' });
  state.data.instances[0].windows[0].tabs = state.data.instances[0].windows[0].tabs.filter(
    t => t.id !== 10
  );
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeVisible({ timeout: 5000 });
  await expect(p.getByRole('button', { name: 'Return to page' })).toBeHidden();
});
test('closing the last openable tab returns to the manager and keeps new-tab shortcuts available', async ({
  page: p,
}) => {
  const state = await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  state.data.instances = state.data.instances.slice(0, 1);
  state.data.instances[0].windows[0].tabs = state.data.instances[0].windows[0].tabs.slice(0, 1);
  await p.keyboard.press('Meta+Shift+l');
  await p.getByRole('button', { name: 'Refresh tabs' }).click();
  await p.getByRole('button', { name: 'Return to page' }).click();
  await key(p, 'KeyW');
  await expect(p.getByRole('searchbox', { name: 'Find a tab' })).toBeVisible();
  await expect
    .poll(() =>
      p.evaluate(() => window.browserCommands.filter(q => q.action === 'context').at(-1)?.active)
    )
    .toBe(true);
  await key(p, 'KeyT');
  await expect(p.getByRole('dialog', { name: 'New desktop tab' })).toBeVisible();
});

test('phone find delegates to the native navigator without inserting another web toolbar', async ({
  page: p,
}) => {
  await setup(p, { profile_id: 'profile-one', tab_id: 10 }, { width: 402, height: 874 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  await p.waitForTimeout(600);
  const before = await p.locator('.browser-native-slot').boundingBox();
  await key(p, 'KeyF');
  await expect.poll(() => p.evaluate(() => window.findVisible)).toBe(true);
  const after = await p.locator('.browser-native-slot').boundingBox();
  expect(after).toEqual(before);
  await key(p, 'KeyL', { shift: true });
  await expect.poll(() => p.evaluate(() => window.findVisible)).toBe(false);
});
test('new desktop window opens its page after the delayed extension snapshot arrives', async ({
  page: p,
}) => {
  const state = await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  await p.route('**/api/browser/action', r => {
    const q = r.request().postDataJSON();
    state.actions.push(q);
    setTimeout(
      () =>
        state.data.instances[0].windows.push({
          id: 8,
          tabs: [{ id: 88, index: 0, url: q.url, title: 'New window page' }],
        }),
      120
    );
    return r.fulfill({ json: { ok: true, result: { window_id: 8 } } });
  });
  await key(p, 'KeyN');
  await expect(p.getByRole('combobox', { name: 'Window', exact: true })).toHaveValue('-1');
  await p.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.edu/');
  await p.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => opened(p)).toEqual(['https://example.com/', 'https://example.edu/']);
  expect(state.actions[0]).toMatchObject({ action: 'create', new_window: true });
  expect(
    await p.evaluate(() => JSON.parse(localStorage.getItem('omarchy-browser-last-tab')).tab_id)
  ).toBe(88);
});
test('a delayed native focus reply cannot reopen a dismissed field or steal another workspace', async ({
  page: p,
}) => {
  await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  await p.evaluate(() => {
    const bridge = window.webkit.messageHandlers.browserDevice;
    const original = bridge.postMessage;
    bridge.postMessage = async q => {
      if (q.action === 'focus' && q.active === false) await new Promise(r => setTimeout(r, 100));
      return original(q);
    };
  });
  await key(p, 'KeyL');
  await key(p, 'KeyF');
  await p.waitForTimeout(160);
  await expect(p.getByRole('textbox', { name: 'Page address' })).not.toBeFocused();
  await key(p, 'KeyL');
  await key(p, 'Escape', { plain: true });
  await p.waitForTimeout(160);
  await expect(p.getByRole('textbox', { name: 'Page address' })).not.toBeFocused();
  await key(p, 'KeyL');
  await p.keyboard.press('Meta+Enter');
  await p.waitForTimeout(160);
  await expect(p.getByRole('textbox', { name: 'Page address' })).not.toBeFocused();
  await expect(p.locator('.desk-ws-label:visible')).toHaveText('terminal');
});
test('tab search opens its first matching page with Return', async ({ page: p }) => {
  await setup(p, { profile_id: 'profile-one', tab_id: 10 });
  await expect.poll(() => opened(p)).toHaveLength(1);
  await key(p, 'F2', { plain: true });
  await p.getByRole('searchbox', { name: 'Find a tab' }).fill('Other profile');
  await p.getByRole('searchbox', { name: 'Find a tab' }).press('Enter');
  await expect.poll(() => opened(p)).toEqual(['https://example.com/', 'https://example.net/']);
});
