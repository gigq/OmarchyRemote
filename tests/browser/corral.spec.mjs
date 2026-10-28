import { test, expect } from './fixtures.mjs';

const ALEX = 'a1111111-1111-4111-8111-111111111111';
const SAM = 'a2222222-2222-4222-8222-222222222222';
const INFRA = 'c1111111-1111-4111-8111-111111111111';
const DM = 'c2222222-2222-4222-8222-222222222222';
const msg = (author, text, i) => ({
  id: 'm' + i,
  ts: `2026-10-28T10:0${i}:00.000Z`,
  author,
  text,
  chain: author === 'you' ? 0 : 1,
});

async function setup(page, { width = 402, height = 874 } = {}) {
  await page.setViewportSize({ width, height });
  const state = {
    agents: [
      {
        id: ALEX,
        name: 'alex',
        engine: 'claude',
        model: 'opus',
        effort: '',
        home: '/home/qa/git/infra',
        instructions: 'Keeps the servers up.',
        working: [],
      },
      {
        id: SAM,
        name: 'sam',
        engine: 'claudex',
        model: 'gemini-3-flash',
        effort: '',
        home: '/home/qa/git/web',
        instructions: '',
        working: [],
      },
    ],
    conversations: [
      {
        id: INFRA,
        kind: 'channel',
        name: 'infra',
        topic: 'Servers and certs',
        members: [ALEX],
        working: [],
      },
      { id: DM, kind: 'dm', name: '', topic: '', members: [ALEX], working: [] },
    ],
    messages: {
      [INFRA]: [
        msg('you', '@alex can you rotate the certs? See https://example.com/certs', 1),
        msg(ALEX, 'On it. **Done** for `api` and `web`.', 2),
        msg('corral', '@sam joined', 3),
      ],
      [DM]: [],
    },
    sent: [],
    created: [],
  };
  await page.route('**/api/**', r => r.abort());
  await page.route('**/api/corral', r =>
    r.fulfill({
      json: {
        person: 'Justin',
        folder: '~/Corral',
        engines: [
          {
            id: 'claude',
            label: 'Claude',
            models: [{ id: 'opus', label: 'Opus' }],
            efforts: ['low', 'high'],
          },
          {
            id: 'claudex',
            label: 'Claude X',
            models: [
              { id: 'opus', label: 'Opus' },
              { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
            ],
            efforts: ['low', 'high'],
          },
          { id: 'codex', label: 'Codex', models: [], efforts: ['low', 'high'] },
        ],
        agents: state.agents,
        conversations: state.conversations.map(c => ({
          ...c,
          last: state.messages[c.id].at(-1) || null,
        })),
      },
    })
  );
  await page.route(/\/api\/corral\/conversations\/[^/]+$/, r => {
    const id = r.request().url().split('/').pop();
    if (r.request().method() === 'POST') return r.fulfill({ json: { id } });
    const c = state.conversations.find(c => c.id === id);
    return r.fulfill({ json: { ...c, messages: state.messages[id] } });
  });
  await page.route(/\/api\/corral\/conversations\/[^/]+\/messages$/, r => {
    const id = r.request().url().split('/').at(-2);
    const { text } = r.request().postDataJSON();
    state.sent.push({ id, text });
    const m = msg('you', text, 9);
    state.messages[id].push(m);
    return r.fulfill({ json: m });
  });
  await page.route('**/api/corral/dm', r => r.fulfill({ json: state.conversations[1] }));
  await page.route('**/api/corral/agents', r => {
    const body = r.request().postDataJSON();
    state.created.push(body);
    const agent = { id: 'a3333333-3333-4333-8333-333333333333', ...body, working: [] };
    state.agents.push(agent);
    return r.fulfill({ json: agent });
  });
  await page.routeWebSocket('**/api/corral/ws', ws => {
    state.ws = ws;
  });
  await page.goto('/native/');
  await page.getByText('corral', { exact: true }).first().click();
  const app = page.locator('#remote-corral-app');
  await expect(app).toBeVisible();
  return { app, state, emit: e => state.ws.send(JSON.stringify(e)) };
}

test('channels and agents list in the sidebar, and a channel shows its conversation', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page);
  await expect(app.locator('.corral-row-name')).toHaveText(['infra', 'alex', 'sam']);
  await expect(app.locator('.corral-row-status')).toHaveText([
    'Claude · opus',
    'Claude X · gemini-3-flash',
  ]);
  await app.getByRole('listitem').filter({ hasText: 'infra' }).click();
  await expect(app.locator('.corral-title')).toHaveText('#infra');
  await expect(app.locator('.corral-subtitle')).toHaveText('Servers and certs');
  const messages = app.locator('.corral-messages');
  await expect(messages.locator('.corral-name')).toHaveText(['Justin', 'alex']);
  await expect(messages.locator('.corral-mention').first()).toHaveText('@alex');
  await expect(messages.locator('strong')).toHaveText('Done');
  await expect(messages.locator('.corral-note')).toHaveText('@sam joined');
  // An agent at work shows on one line with Stop, and in the sidebar.
  emit({ type: 'status', conversation: INFRA, agent: ALEX, status: 'Bash · openssl x509' });
  await expect(app.locator('.corral-working')).toContainText('@alex · Bash · openssl x509');
  await expect(app.locator('.corral-busy').first()).toBeAttached();
  await page.screenshot({ path: 'artifacts/browser/corral-channel.png' });
  // Its reply arrives.
  emit({ type: 'status', conversation: INFRA, agent: ALEX, status: null });
  emit({ type: 'message', conversation: INFRA, message: msg(ALEX, 'All certs renewed.', 4) });
  await expect(messages).toContainText('All certs renewed.');
  await expect(app.locator('.corral-working')).toBeHidden();
  // Typing @ offers names to mention, and the message goes to the channel.
  await app.getByRole('button', { name: 'Write a message' }).click();
  const field = app.locator('textarea.native-input');
  await field.pressSequentially('@s');
  await app.getByRole('button', { name: '@sam' }).click();
  await field.pressSequentially('please check the web certs');
  await field.press('Enter');
  await expect
    .poll(() => state.sent)
    .toEqual([{ id: INFRA, text: '@sam please check the web certs' }]);
  // Back on a phone returns to the sidebar.
  await app.getByRole('button', { name: 'All conversations' }).click();
  await expect(app.locator('.corral-side')).toBeVisible();
});

test('an agent is made with a name, engine, model, and home, then opens its DM', async ({
  page,
}) => {
  const { app, state } = await setup(page, { width: 1280, height: 800 });
  // Wide: the sidebar and the conversation side by side.
  await app.getByRole('button', { name: 'New agent' }).click();
  const form = app.locator('.corral-form');
  await form.getByLabel('Name').fill('Ivy');
  await form.getByLabel('Agent').selectOption('claudex');
  await form.getByLabel('Model').selectOption('gemini-3-flash');
  await form.getByLabel('Effort').selectOption('high');
  await form.getByLabel('Home folder').fill('~/git/docs');
  await form.getByLabel('Instructions').fill('Writes the docs.');
  await page.screenshot({ path: 'artifacts/browser/corral-agent.png' });
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect
    .poll(() => state.created)
    .toEqual([
      {
        name: 'Ivy',
        engine: 'claudex',
        model: 'gemini-3-flash',
        effort: 'high',
        home: '~/git/docs',
        instructions: 'Writes the docs.',
      },
    ]);
  await expect(app.locator('.corral-sheet')).toBeHidden();
  await expect(app.locator('.corral-side')).toBeVisible();
  await expect(app.locator('.corral-main')).toBeVisible();
  await page.screenshot({ path: 'artifacts/browser/corral-wide.png' });
});
