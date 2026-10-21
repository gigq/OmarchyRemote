import { test, expect } from './fixtures.mjs';

const ID = '1b8ab544-8cc5-430e-8a40-0aec58bc3b10';
const NEW = '2c8ab544-8cc5-430e-8a40-0aec58bc3b10';
const entry = (role, text, name = '') => ({ role, text, name, time: '2026-10-03T10:00:00Z' });

async function setup(page, extra = [], before) {
  await page.setViewportSize({ width: 402, height: 874 });
  const state = {
    chats: [
      {
        id: ID,
        title: 'Dinner ideas',
        preview: 'Pasta is quick.',
        updated: new Date().toISOString(),
        busy: false,
      },
      ...extra,
    ],
    conversations: {
      [ID]: {
        id: ID,
        title: 'Dinner ideas',
        entries: [entry('user', 'Ideas for dinner?'), entry('assistant', '**Pasta** is quick.')],
        folder: '/home/qa/Chats/2026-10-03-dinner-ideas-1b8ab544',
        busy: false,
        partial: '',
        seq: 0,
        n: 0,
      },
    },
    sent: [],
    stopped: [],
    failSend: false,
    n: 0,
  };
  await page.route('**/api/**', r => r.abort());
  await page.route('**/api/chat', r =>
    r.fulfill({
      json: {
        folder: '~/Chats',
        available: true,
        agent: 'claude',
        models: [
          { id: 'fable', label: 'Fable' },
          { id: 'opus', label: 'Opus' },
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaults: { model: 'claude-fable-5-1', effort: 'high' },
        chats: state.chats,
        ...state.status,
      },
    })
  );
  await page.route('**/api/chat/send', async r => {
    const body = r.request().postDataJSON();
    state.sent.push(body);
    if (state.failSend)
      return r.fulfill({ status: 502, json: { error: 'Claude could not start' } });
    const id = body.id || NEW;
    if (!body.id)
      state.conversations[NEW] = {
        id: NEW,
        title: body.text,
        entries: [
          {
            ...entry('user', body.text),
            attachments: body.attachments.map(path => 'attachments/' + path.split('/u-').pop()),
          },
        ],
        busy: true,
        partial: '',
        seq: 0,
        n: state.n,
      };
    await r.fulfill({ json: { id } });
  });
  await page.route(/\/api\/chat\/[0-9a-f-]{36}$/, r => {
    const id = r.request().url().split('/').pop();
    return r.fulfill({ json: state.conversations[id] });
  });
  await page.route(/\/api\/chat\/[0-9a-f-]{36}\/stop$/, r => {
    state.stopped.push(r.request().url().split('/').at(-2));
    return r.fulfill({ json: { stopped: true } });
  });
  state.managed = [];
  for (const action of ['archive', 'delete'])
    await page.route(`**/api/chat/${action}`, r => {
      const { ids, archived } = r.request().postDataJSON();
      state.managed.push({ action, ids, ...(archived ? { archived } : {}) });
      const failed = ids.filter(id => id === state.failId);
      const done = ids.filter(id => id !== state.failId);
      state.chats = state.chats.filter(c => !done.includes(c.id));
      return r.fulfill({
        json: { done, failed: failed.map(id => ({ id, error: 'Permission denied' })) },
      });
    });
  await page.routeWebSocket('**/api/chat/ws', ws => {
    state.ws = ws;
  });
  await before?.(page, state);
  await page.goto('/native/');
  await page.getByText('chat', { exact: true }).first().click();
  const app = page.locator('#remote-chat-app');
  await expect(app).toBeVisible();
  // Numbered like the host's events.
  const emit = event => state.ws.send(JSON.stringify({ ...event, n: ++state.n }));
  return { app, state, emit };
}

test('the list shows saved chats and opens one with its Markdown reply', async ({ page }) => {
  const { app } = await setup(page);
  await expect(app.locator('.chat-row')).toHaveCount(1);
  await expect(app.locator('.chat-row-title')).toHaveText('Dinner ideas');
  await expect(app.locator('.chat-folder')).toHaveText('Saved in ~/Chats');
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  await expect(app.locator('.chat-message.user')).toHaveText('Ideas for dinner?');
  await expect(app.locator('.chat-message.assistant strong')).toHaveText('Pasta');
  // The open chat comes back after a reload; the shell also reopens the app.
  await page.reload();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  await app.getByRole('button', { name: 'All chats' }).click();
  await expect(app.locator('.chat-row')).toHaveCount(1);
});

test('a new chat streams its reply, shows tools, and can be stopped', async ({ page }) => {
  const { app, state, emit } = await setup(page);
  await app.getByRole('button', { name: 'New chat' }).click();
  await expect(app.locator('.chat-empty')).toContainText('Ask anything');
  // A chat has no folder until its first message is sent.
  await expect(app.getByRole('button', { name: 'Open chat folder' })).toBeHidden();
  const field = app.locator('textarea.native-input');
  await field.fill('What is a pelican?');
  await field.press('Enter');
  await expect
    .poll(() => state.sent)
    .toEqual([
      {
        id: null,
        text: 'What is a pelican?',
        attachments: [],
        agent: 'claude',
        model: '',
        effort: '',
      },
    ]);
  // Sending hides the keyboard; the message box stand-in takes its place.
  await expect(field).toBeHidden();
  await expect(app.getByRole('button', { name: 'Write a message' })).toBeVisible();
  // The tool event can arrive before the new chat has loaded; it still appears once.
  await expect(app.locator('.chat-title')).toHaveText('What is a pelican?');
  await expect(app.locator('.chat-message.user')).toHaveText('What is a pelican?');
  await expect(app.locator('.chat-status')).toHaveText('Claude is thinking…');
  emit({ type: 'entry', id: NEW, index: 1, entry: entry('tool', 'pelican facts', 'WebSearch') });
  await expect(app.locator('.chat-tool')).toHaveText('WebSearch pelican facts');
  emit({ type: 'delta', id: NEW, seq: 1, text: 'A **large** water' });
  emit({ type: 'delta', id: NEW, seq: 2, text: 'bird.' });
  // A delta it already has is ignored.
  emit({ type: 'delta', id: NEW, seq: 2, text: 'bird.' });
  await expect(app.locator('.chat-message.streaming')).toHaveText('A large waterbird.');
  await expect(app.locator('.chat-stop')).toBeVisible();
  await app.locator('.chat-stop').click();
  await expect.poll(() => state.stopped).toEqual([NEW]);
  emit({ type: 'entry', id: NEW, index: 2, entry: entry('assistant', 'A **large** waterbird.') });
  emit({ type: 'done', id: NEW, error: null });
  await expect(app.locator('.chat-message.streaming')).toBeHidden();
  await expect(app.locator('.chat-message.assistant:not(.streaming) strong')).toHaveText('large');
  await expect(app.locator('.chat-stop')).toBeHidden();
  await expect(app.locator('.chat-status')).toBeHidden();
  // Events for other chats leave this one alone.
  emit({ type: 'delta', id: ID, seq: 1, text: 'elsewhere' });
  await expect(app.locator('.chat-message.streaming')).toBeHidden();
});

test('a failed send keeps the message as a draft and shows why', async ({ page }) => {
  const { app, state } = await setup(page);
  state.failSend = true;
  await app.locator('.chat-row').click();
  const field = app.locator('textarea.native-input');
  await app.getByRole('button', { name: 'Write a message' }).click();
  await field.fill('Keep this text');
  await field.press('Enter');
  await expect(app.locator('.chat-status')).toHaveText('Claude could not start');
  await expect(field).toHaveValue('Keep this text');
});

test('replies cannot run script and their links leave the app', async ({ page }) => {
  const { app, emit } = await setup(page);
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-message.assistant:not(.streaming)')).toHaveCount(1);
  emit({
    type: 'entry',
    id: ID,
    index: 2,
    entry: entry(
      'assistant',
      'See [docs](https://example.com).\n\n<img src=x onerror="window.chatInjected=1"><script>window.chatInjected=2</script>'
    ),
  });
  const link = app.locator('.chat-message.assistant:not(.streaming) a');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.chatInjected)).toBeUndefined();
  expect(await app.locator('.chat-message.assistant [onerror], .chat-message script').count()).toBe(
    0
  );
});

test('tapping the message box types and tapping the conversation hides the keyboard', async ({
  page,
}) => {
  const { app, emit } = await setup(page);
  await app.locator('.chat-row').click();
  emit({ type: 'entry', id: 'x', index: 0, entry: entry('user', 'ignored') });
  emit({
    type: 'entry',
    id: ID,
    index: 2,
    entry: entry('tool', 'pelican facts and a long query that runs past the edge', 'WebSearch'),
  });
  await expect(app.locator('.chat-tool')).toBeVisible();
  const composer = app.locator('textarea.native-input');
  await expect(composer).toBeHidden();
  const font = locator => locator.evaluate(e => getComputedStyle(e).font);
  const standIn = await font(app.locator('.chat-prompt'));
  await app.getByRole('button', { name: 'Write a message' }).click();
  // The message box looks the same with the keyboard up or down.
  expect(await font(composer)).toBe(standIn);
  await expect(composer).toBeFocused();
  // The composer has no header row: no keyboard-dismiss or typing-mode button.
  await expect(app.getByRole('button', { name: 'Hide keyboard' })).toBeHidden();
  await expect(app.getByRole('button', { name: /mode/ })).toBeHidden();
  await page.screenshot({ path: 'artifacts/browser/chat-thread-keyboard.png' });
  await app.locator('.chat-message.assistant').first().click();
  await expect(composer).toBeHidden();
  await expect(app.getByRole('button', { name: 'Write a message' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/browser/chat-thread.png' });
});

test('an empty list invites a first chat', async ({ page }) => {
  const { app, state } = await setup(page);
  await page.unroute('**/api/chat');
  await page.route('**/api/chat', r =>
    r.fulfill({ json: { folder: '~/Chats', available: true, agent: 'claude', chats: [] } })
  );
  state.chats = [];
  await page.reload();
  await expect(app.getByRole('button', { name: 'Start a chat' })).toBeVisible();
  await expect(app.locator('.chat-folder')).toHaveText('Saved in ~/Chats');
  await page.screenshot({ path: 'artifacts/browser/chat-empty.png' });
  await app.getByRole('button', { name: 'Start a chat' }).click();
  await expect(app.locator('.chat-empty')).toContainText('Ask anything');
});

const more = [
  {
    id: '3c8ab544-8cc5-430e-8a40-0aec58bc3b10',
    title: 'Trip plan',
    preview: 'Day one',
    updated: new Date().toISOString(),
  },
  {
    id: '4d8ab544-8cc5-430e-8a40-0aec58bc3b10',
    title: 'Old notes',
    preview: 'Notes',
    updated: new Date().toISOString(),
  },
];

test('several chats can be selected and archived', async ({ page }) => {
  const { app, state } = await setup(page, more);
  await expect(app.locator('.chat-row')).toHaveCount(3);
  await app.getByRole('button', { name: 'Select' }).click();
  await expect(app.locator('.chat-heading')).toHaveText('0 selected');
  await expect(app.getByRole('button', { name: 'Archive' })).toBeDisabled();
  await expect(app.getByRole('button', { name: 'New chat' })).toBeHidden();
  await app.getByRole('checkbox', { name: /Dinner ideas/ }).click();
  await app.getByRole('checkbox', { name: /Old notes/ }).click();
  await expect(app.locator('.chat-heading')).toHaveText('2 selected');
  await expect(app.getByRole('checkbox', { name: /Dinner ideas/ })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.screenshot({ path: 'artifacts/browser/chat-select.png' });
  // A tap on a selected row unselects it rather than opening the chat.
  await app.getByRole('checkbox', { name: /Old notes/ }).click();
  await expect(app.locator('.chat-heading')).toHaveText('1 selected');
  await app.getByRole('checkbox', { name: /Old notes/ }).click();
  await app.getByRole('button', { name: 'Archive' }).click();
  await expect.poll(() => state.managed).toEqual([{ action: 'archive', ids: [ID, more[1].id] }]);
  await expect(app.locator('.chat-row')).toHaveCount(1);
  await expect(app.locator('.chat-heading')).toHaveText('Chats');
  await expect(app.locator('.chat-row-title')).toHaveText('Trip plan');
});

test('a right-click or a long press on a chat offers rename, archive, and delete', async ({
  page,
}) => {
  const { app, state } = await setup(page, more);
  state.renamed = [];
  await page.route(/\/api\/chat\/[0-9a-f-]{36}\/rename$/, r => {
    const id = r.request().url().split('/').at(-2);
    const { title } = r.request().postDataJSON();
    state.renamed.push({ id, title });
    state.chats = state.chats.map(c => (c.id === id ? { ...c, title } : c));
    return r.fulfill({ json: { renamed: true } });
  });
  const menu = page.getByRole('menu');
  await app.locator('.chat-row', { hasText: 'Dinner ideas' }).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Archive', 'Delete']);
  // Escape closes it, and nothing opened.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await app.locator('.chat-row', { hasText: 'Dinner ideas' }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('dialog', { name: 'Rename' }).getByRole('textbox');
  await expect(field).toHaveValue('Dinner ideas');
  await field.fill('Weeknight dinners');
  await page.screenshot({ path: 'artifacts/browser/chat-rename.png' });
  await field.press('Enter');
  await expect.poll(() => state.renamed).toEqual([{ id: ID, title: 'Weeknight dinners' }]);
  await expect(app.locator('.chat-row-title').first()).toHaveText('Weeknight dinners');
  // A long press on touch opens the same menu, and its release does not open the chat.
  const row = app.locator('.chat-row', { hasText: more[1].title });
  const box = await row.boundingBox();
  const at = { clientX: box.x + 40, clientY: box.y + 20, pointerType: 'touch', isPrimary: true };
  await row.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(650);
  await row.dispatchEvent('pointerup', at);
  await row.dispatchEvent('click');
  await expect(menu).toBeVisible();
  await expect(app.locator('.chat-row')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/browser/chat-menu.png' });
  // Deleting asks in the menu first.
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByText(`Delete “${more[1].title}” permanently?`)).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect.poll(() => state.managed).toEqual([{ action: 'delete', ids: [more[1].id] }]);
  await expect(app.locator('.chat-row')).toHaveCount(2);
  // Archive acts at once.
  await app.locator('.chat-row', { hasText: more[0].title }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  await expect.poll(() => state.managed.at(-1)).toEqual({ action: 'archive', ids: [more[0].id] });
  // On a wide screen the menu opens where the click was, and arrows move through it.
  await page.setViewportSize({ width: 1280, height: 800 });
  const first = app.locator('.chat-row').first();
  await expect(first).toBeVisible();
  // Wait for the resized layout to settle before clicking where the row is.
  let spot = null;
  await expect
    .poll(async () => {
      const box = await first.boundingBox();
      const settled = !!box && !!spot && box.x === spot.x && box.y === spot.y;
      spot = box;
      return settled;
    })
    .toBe(true);
  await page.mouse.click(spot.x + 30, spot.y + 10, { button: 'right' });
  await expect(menu).toBeVisible();
  const placed = await menu.boundingBox();
  expect(Math.abs(placed.x - (spot.x + 30))).toBeLessThan(2);
  expect(Math.abs(placed.y - (spot.y + 10))).toBeLessThan(2);
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.mouse.click(5, 5);
  await expect(menu).toBeHidden();
});

test('archived chats are listed apart, and come back or go for good', async ({ page }) => {
  const archived = [
    { id: more[0].id, title: 'Old notes', preview: 'Notes', updated: new Date().toISOString() },
    { id: more[1].id, title: 'Trip plan', preview: 'Day one', updated: new Date().toISOString() },
  ];
  const { app, state } = await setup(page, [], async (page, state) => {
    state.status = { archived: 2 };
    state.archive = [];
    await page.route('**/api/chat/archived', r => r.fulfill({ json: { chats: archived } }));
    await page.route('**/api/chat/restore', r => {
      const body = r.request().postDataJSON();
      state.archive.push({ action: 'restore', ...body });
      const chat = archived.find(c => body.ids.includes(c.id));
      archived.splice(archived.indexOf(chat), 1);
      state.chats.push({ ...chat, busy: false });
      state.status = { archived: archived.length };
      return r.fulfill({ json: { done: body.ids, failed: [] } });
    });
  });
  const link = app.getByRole('button', { name: 'Archived · 2' });
  await expect(link).toBeVisible();
  await page.screenshot({ path: 'artifacts/browser/chat-archive-link.png' });
  await link.click();
  await expect(app.locator('.chat-heading')).toHaveText('Archived');
  await expect(app.getByRole('button', { name: 'New chat' })).toBeHidden();
  const rows = app.locator('.chat-archived');
  await expect(rows.locator('.chat-row-title')).toHaveText(['Old notes', 'Trip plan']);
  await expect(app.locator('.chat-folder')).toHaveText('Archived in ~/Chats/archives');
  await page.screenshot({ path: 'artifacts/browser/chat-archive.png' });
  // Restore brings it back to the list.
  await app.getByRole('button', { name: 'Restore Old notes' }).click();
  await expect
    .poll(() => state.archive)
    .toEqual([{ action: 'restore', ids: [more[0].id], archived: true }]);
  await expect(rows).toHaveCount(1);
  // Delete, from its menu, asks first and deletes from the archive.
  await rows.first().click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByText('Delete “Trip plan” permanently?')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect
    .poll(() => state.managed)
    .toEqual([{ action: 'delete', ids: [more[1].id], archived: true }]);
  // Back in the list, the restored chat is there.
  await app.getByRole('button', { name: 'Back to chats' }).click();
  await expect(app.locator('.chat-heading')).toHaveText('Chats');
  await expect(app.locator('.chat-row-title')).toContainText(['Old notes']);
});

test('deleting asks first, and a chat that fails stays with the reason', async ({ page }) => {
  const { app, state } = await setup(page, more);
  state.failId = more[0].id;
  await app.getByRole('button', { name: 'Select' }).click();
  await app.getByRole('checkbox', { name: /Dinner ideas/ }).click();
  await app.getByRole('checkbox', { name: /Trip plan/ }).click();
  await app.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(app.locator('.chat-actions-text')).toHaveText('Delete 2 chats permanently?');
  await page.screenshot({ path: 'artifacts/browser/chat-delete-confirm.png' });
  // Keep backs out without deleting anything.
  await app.getByRole('button', { name: 'Keep' }).click();
  await expect(app.getByRole('button', { name: 'Archive' })).toBeVisible();
  expect(state.managed).toEqual([]);
  await app.getByRole('button', { name: 'Delete', exact: true }).click();
  await app.getByRole('button', { name: 'Delete permanently' }).click();
  await expect.poll(() => state.managed).toEqual([{ action: 'delete', ids: [ID, more[0].id] }]);
  await expect(app.locator('.chat-folder')).toHaveText('Could not delete 1: Permission denied');
  await expect(app.locator('.chat-row-title')).toHaveText(['Trip plan', 'Old notes']);
});

test('a chat removed elsewhere closes if it is open', async ({ page }) => {
  const { app, emit } = await setup(page);
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  emit({ type: 'removed', ids: [ID] });
  await expect(app.locator('.chat-heading')).toHaveText('Chats');
});

test('model and effort are chosen per chat and remembered for new chats', async ({ page }) => {
  const { app, state } = await setup(page);
  await app.getByRole('button', { name: 'New chat' }).click();
  const chip = app.locator('.chat-settings');
  await expect(chip).toHaveText('fable-5-1 · high');
  await chip.click();
  const model = app.getByRole('group', { name: 'Model' });
  const effort = app.getByRole('group', { name: 'Effort' });
  await expect(model.getByRole('button', { name: 'Default (fable-5-1)' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await model.getByRole('button', { name: 'Opus' }).click();
  await effort.getByRole('button', { name: 'xhigh' }).click();
  await expect(chip).toHaveText('Opus · xhigh');
  await expect(model.getByRole('button', { name: 'Opus' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'artifacts/browser/chat-settings.png' });
  const field = app.locator('textarea.native-input');
  await field.fill('Hello');
  await field.press('Enter');
  await expect
    .poll(() => state.sent)
    .toEqual([
      { id: null, text: 'Hello', attachments: [], agent: 'claude', model: 'opus', effort: 'xhigh' },
    ]);
  // The next new chat starts with the same choice.
  await app.getByRole('button', { name: 'New chat' }).click();
  await expect(chip).toHaveText('Opus · xhigh');
  // An existing chat shows its own settings, and a change goes with the next message.
  state.conversations[ID].model = 'fable';
  state.conversations[ID].effort = '';
  await app.getByRole('button', { name: 'All chats' }).click();
  await app.locator('.chat-row').first().click();
  await expect(chip).toHaveText('Fable · high');
  await chip.click();
  await expect(app.locator('.chat-settings-note')).toHaveText(
    'Changes apply from your next message.'
  );
  await effort.getByRole('button', { name: 'low' }).click();
  await app.getByRole('button', { name: 'Write a message' }).click();
  await field.fill('Again');
  await field.press('Enter');
  await expect
    .poll(() => state.sent.at(-1))
    .toEqual({
      id: ID,
      text: 'Again',
      attachments: [],
      agent: 'claude',
      model: 'fable',
      effort: 'low',
    });
});

test("a chat's folder opens in Files", async ({ page }) => {
  const { app } = await setup(page);
  await app.locator('.chat-row').click();
  await app.getByRole('button', { name: 'Open chat folder' }).click();
  await expect(page.locator('#remote-files-app')).toBeVisible();
});

test('raising the keyboard pushes the conversation up, keeping the latest message in view', async ({
  page,
}) => {
  const { app, state } = await setup(page);
  state.conversations[ID].entries = Array.from({ length: 40 }, (_, i) =>
    entry(i % 2 ? 'assistant' : 'user', `Message ${i + 1}`)
  );
  await app.locator('.chat-row').click();
  const messages = app.locator('.chat-messages');
  const last = app.locator('.chat-message:not(.streaming)').last();
  const visible = async locator => {
    const [box, view] = await Promise.all([locator.boundingBox(), messages.boundingBox()]);
    return !!box && !!view && box.y >= view.y && box.y + box.height <= view.y + view.height + 1;
  };
  await expect.poll(() => visible(last)).toBe(true);
  const fromBottom = () =>
    messages.evaluate(e => Math.round(e.scrollHeight - e.scrollTop - e.clientHeight));
  await app.getByRole('button', { name: 'Write a message' }).click();
  await expect(app.locator('textarea.native-input')).toBeFocused();
  // The conversation got shorter; it scrolled with it instead of hiding the latest message.
  await expect.poll(() => visible(last)).toBe(true);
  await expect.poll(fromBottom).toBe(0);
  // Reading further up, the same text stays the same distance above the message box.
  await app.locator('.chat-message').first().click();
  await expect(app.locator('textarea.native-input')).toBeHidden();
  await messages.evaluate(e => {
    e.scrollTop = e.scrollHeight - e.clientHeight - 200;
    e.dispatchEvent(new Event('scroll'));
  });
  const before = await fromBottom();
  await app.getByRole('button', { name: 'Write a message' }).click();
  await expect(app.locator('textarea.native-input')).toBeFocused();
  await expect.poll(fromBottom).toBe(before);
});

// A 1×1 PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('files attach to a message, send with it, and show in the conversation', async ({ page }) => {
  const { app, state, emit } = await setup(page);
  const uploads = [];
  await page.route('**/api/uploads/files?*', r => {
    const name = new URL(r.request().url()).searchParams.get('name');
    uploads.push({ name, client: r.request().headers()['x-hyprland-client'] });
    const kind = name.endsWith('.png') ? 'image' : 'file';
    return r.fulfill({
      json: { path: `/home/qa/.local/share/omarchy-remote/uploads/u-${name}`, kind },
    });
  });
  const fetched = [];
  await page.route(/\/api\/chat\/[0-9a-f-]{36}\/attachments\/.+$/, r => {
    fetched.push({
      name: decodeURIComponent(r.request().url().split('/').pop()),
      client: r.request().headers()['x-hyprland-client'],
    });
    return r.fulfill({ body: PIXEL, contentType: 'image/png' });
  });
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  await app.locator('input[type=file]').setInputFiles([
    { name: 'fridge.png', mimeType: 'image/png', buffer: PIXEL },
    { name: 'menu.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
  ]);
  const tray = app.getByLabel('Attachments');
  await expect(tray.locator('.chat-upload-name')).toHaveText(['fridge.png', 'menu.pdf']);
  await expect(tray.locator('img')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/browser/chat-uploads.png' });
  expect(uploads).toEqual([
    { name: 'fridge.png', client: '1' },
    { name: 'menu.pdf', client: '1' },
  ]);
  // The upload returns to the message, and the composer takes over the paperclip.
  const field = app.locator('textarea.native-input');
  await expect(field).toBeFocused();
  await expect(app.locator('.native-input-row .chat-attach')).toBeVisible();
  await app.getByRole('button', { name: 'Remove menu.pdf' }).click();
  await expect(tray.locator('.chat-upload-name')).toHaveText(['fridge.png']);
  // Waiting files survive a reload, like the draft.
  await page.reload();
  await expect(app.getByLabel('Attachments').locator('.chat-upload-name')).toHaveText([
    'fridge.png',
  ]);
  // A message can be only a file.
  await app.getByRole('button', { name: 'Write a message' }).click();
  await field.press('Enter');
  await expect
    .poll(() => state.sent)
    .toEqual([
      {
        id: ID,
        text: '',
        attachments: ['/home/qa/.local/share/omarchy-remote/uploads/u-fridge.png'],
        agent: 'claude',
        model: '',
        effort: '',
      },
    ]);
  await expect(app.getByLabel('Attachments')).toBeHidden();
  emit({
    type: 'entry',
    id: ID,
    index: 2,
    entry: {
      ...entry('user', 'What can I make?'),
      attachments: ['attachments/fridge.png', 'attachments/notes.txt'],
    },
  });
  const sent = app.locator('.chat-message.user').last();
  await expect(sent.locator('.chat-message-text')).toHaveText('What can I make?');
  await expect(sent.locator('.chat-attachment')).toHaveCount(2);
  await expect(sent.locator('.chat-attachment.image img')).toHaveAttribute('src', /^blob:/);
  await expect(sent.locator('.chat-attachment:not(.image)')).toHaveText('notes.txt');
  expect(fetched).toEqual([{ name: 'fridge.png', client: '1' }]);
  await page.screenshot({ path: 'artifacts/browser/chat-attachments.png' });
  // Tapping one opens the chat's attachments folder in Files.
  await sent.locator('.chat-attachment:not(.image)').click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('omarchy-files-path')))
    .toBe('/home/qa/Chats/2026-10-03-dinner-ideas-1b8ab544/attachments');
});

test('a pasted image attaches, and sending waits for uploads', async ({ page }) => {
  const { app, state } = await setup(page);
  let finish;
  const done = new Promise(resolve => (finish = resolve));
  await page.route('**/api/uploads/files?*', async r => {
    await done;
    return r.fulfill({ json: { path: '/uploads/u-image.png', kind: 'image' } });
  });
  await app.getByRole('button', { name: 'New chat' }).click();
  const field = app.locator('textarea.native-input');
  await field.evaluate(element => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );
  });
  await expect(app.locator('.chat-upload.uploading')).toHaveText('Uploading image.png…');
  await field.fill('Which plant?');
  await field.press('Enter');
  await expect(app.locator('.chat-upload-error')).toHaveText('Wait for the upload to finish.');
  expect(state.sent).toEqual([]);
  await expect(field).toHaveValue('Which plant?');
  finish();
  await expect(app.locator('.chat-upload-name')).toHaveText('image.png');
  await expect(app.locator('.chat-upload-error')).toBeHidden();
  await field.press('Enter');
  await expect.poll(() => state.sent.map(s => s.attachments)).toEqual([['/uploads/u-image.png']]);
  // The new chat shows its file at once, then as the host saved it.
  await expect(app.locator('.chat-message.user .chat-attachment')).toHaveText('image.png');
  await expect(app.locator('.chat-title')).toHaveText('Which plant?');
});

// A microphone that records at once and a host that transcribes it, as in the dictation specs.
async function voice(page, state) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => ({ getTracks: () => [{ stop() {} }] }),
    });
    window.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        this.state = 'inactive';
        this.mimeType = 'audio/mp4';
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable({ data: new Blob(['audio']) });
          this.onstop();
        });
      }
    };
    window.Audio = class {
      constructor() {
        this.paused = true;
        this.source = '';
      }
      set src(value) {
        this.source = value;
        this.currentSrc = value;
      }
      get src() {
        return this.source;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      removeAttribute() {
        this.src = '';
      }
    };
  });
  await page.route('**/api/dictation', r =>
    r.fulfill({
      json:
        r.request().method() === 'GET'
          ? { available: true, provider: 'Voxtype' }
          : { text: 'dictated words' },
    })
  );
  await page.route('**/api/voice', r => r.fulfill({ json: { available: true } }));
  state.replies = {};
  state.spoken = [];
  await page.route(/\/api\/chat\/[0-9a-f-]{36}\/response$/, r => {
    const id = r.request().url().split('/').at(-2);
    return r.fulfill({
      json: { session: id, working: false, answer: null, paragraphs: [], ...state.replies[id] },
    });
  });
  await page.route(/\/api\/chat\/[0-9a-f-]{36}\/speech$/, r => {
    state.spoken.push({ id: r.request().url().split('/').at(-2), ...r.request().postDataJSON() });
    return r.fulfill({ contentType: 'audio/wav', body: 'fixture audio' });
  });
}

test('a tap on the microphone talks and sends; holding the big button reads replies aloud', async ({
  page,
}) => {
  const { app, state } = await setup(page, [], voice);
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  state.replies[ID] = { answer: { id: 'old', text: 'Pasta is quick.' } };
  const small = app.locator('.dictation-button');
  const floating = app.locator('.herdr-voice-microphone');
  const speaker = floating.locator('.herdr-voice-speaker');
  // One tap records at once, and the big button sends it, replies kept silent.
  await small.click();
  await expect(floating).toHaveText('Send');
  await expect(speaker).toBeHidden();
  await page.screenshot({ path: 'artifacts/browser/chat-voice.png' });
  await floating.click();
  await expect
    .poll(() => state.sent)
    .toEqual([
      { id: ID, text: 'dictated words', attachments: [], agent: 'claude', model: '', effort: '' },
    ]);
  await expect(app.locator('textarea.native-input')).toHaveValue('');
  await expect(floating).toHaveText('Talk');
  state.replies[ID] = { answer: { id: 'quiet', text: 'Rice works too.' } };
  await page.waitForTimeout(2500);
  expect(state.spoken).toEqual([]);
  // Holding the big button reads the next reply aloud.
  await floating.click({ delay: 650 });
  await expect(speaker).toBeVisible();
  await floating.click();
  await floating.click();
  await expect.poll(() => state.sent.length).toBe(2);
  state.replies[ID] = {
    answer: { id: 'loud', text: 'Tacos.' },
    paragraphs: [{ id: 'loud', text: 'Tacos.' }],
  };
  await expect
    .poll(() => state.spoken, { timeout: 6000 })
    .toMatchObject([{ id: ID, response_id: 'loud' }]);
  // Tapping the bar microphone turns Voice off.
  await app.locator('.dictation-button').click();
  await expect(floating).toBeHidden();
});

test('Voice started in a new chat keeps reading it once the host names it', async ({ page }) => {
  const { app, state } = await setup(page, [], voice);
  await app.getByRole('button', { name: 'New chat' }).click();
  // Holding the bar microphone turns on Voice with replies read aloud.
  await app.locator('.dictation-button').click({ delay: 650 });
  const floating = app.locator('.herdr-voice-microphone');
  await expect(floating.locator('.herdr-voice-speaker')).toBeVisible();
  await floating.click();
  await floating.click();
  await expect
    .poll(() => state.sent)
    .toEqual([
      { id: null, text: 'dictated words', attachments: [], agent: 'claude', model: '', effort: '' },
    ]);
  await expect(app.locator('.chat-title')).toHaveText('dictated words');
  await expect(floating).toBeVisible();
  state.replies[NEW] = { paragraphs: [{ id: 'first', text: 'Hello there.' }], working: true };
  await expect
    .poll(() => state.spoken, { timeout: 6000 })
    .toMatchObject([{ id: NEW, response_id: 'first' }]);
});

test('a chat runs the agent chosen for it, and new chats start with the last one', async ({
  page,
}) => {
  const claudeModels = [
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
  ];
  const { app, state } = await setup(
    page,
    [
      {
        id: '3c8ab544-8cc5-430e-8a40-0aec58bc3b10',
        title: 'Taxi refactor',
        preview: 'Done.',
        updated: new Date().toISOString(),
        busy: false,
        agent: 'codex',
      },
    ],
    (_, state) => {
      state.status = {
        agent: 'claude',
        agents: [
          {
            id: 'claude',
            label: 'Claude',
            models: claudeModels,
            efforts: ['low', 'high', 'max'],
            defaults: { model: 'claude-opus-5-5', effort: 'high' },
          },
          {
            id: 'claudex',
            label: 'Claude X',
            models: claudeModels,
            efforts: ['low', 'high', 'max'],
            defaults: { model: 'claude-opus-5-5', effort: 'high' },
          },
          {
            id: 'codex',
            label: 'Codex',
            models: [],
            efforts: ['low', 'medium', 'high', 'xhigh'],
            defaults: { model: '', effort: '' },
          },
        ],
      };
    }
  );
  // Chats on another agent are tagged in the list.
  await expect(app.locator('.chat-row-agent')).toHaveText(['Codex']);
  await app.getByRole('button', { name: 'New chat' }).click();
  const chip = app.locator('.chat-settings');
  await expect(chip).toHaveText('Claude · opus-5-5 · high');
  await chip.click();
  const agent = app.getByRole('group', { name: 'Agent' });
  await expect(agent.getByRole('button')).toHaveText(['Claude', 'Claude X', 'Codex']);
  await page.screenshot({ path: 'artifacts/browser/chat-agents.png' });
  await agent.getByRole('button', { name: 'Codex' }).click();
  // Codex offers its own effort levels and runs its configured model.
  await expect(app.getByRole('group', { name: 'Model' }).getByRole('button')).toHaveText([
    'Default',
  ]);
  await app.getByRole('group', { name: 'Effort' }).getByRole('button', { name: 'xhigh' }).click();
  await expect(chip).toHaveText('Codex · Default · xhigh');
  const field = app.locator('textarea.native-input');
  await expect(field).toHaveAttribute('placeholder', 'Message Codex…');
  await field.fill('Refactor the taxi');
  await field.press('Enter');
  await expect
    .poll(() => state.sent.at(-1))
    .toEqual({
      id: null,
      text: 'Refactor the taxi',
      attachments: [],
      agent: 'codex',
      model: '',
      effort: 'xhigh',
    });
  // The next new chat starts with Codex too.
  await app.getByRole('button', { name: 'New chat' }).click();
  await expect(chip).toHaveText('Codex · Default · xhigh');
  // An existing Claude chat moves to Claude X, but not to Codex.
  await app.getByRole('button', { name: 'All chats' }).click();
  await app.locator('.chat-row').filter({ hasText: 'Dinner ideas' }).click();
  await expect(chip).toHaveText(/^Claude · /);
  await chip.click();
  await expect(agent.getByRole('button', { name: 'Codex' })).toBeDisabled();
  await agent.getByRole('button', { name: 'Claude X' }).click();
  await expect(chip).toHaveText(/^Claude X · /);
  await expect(app.locator('.chat-settings-note')).toHaveText(
    'Changes apply from your next message. Codex needs a new chat.'
  );
});
