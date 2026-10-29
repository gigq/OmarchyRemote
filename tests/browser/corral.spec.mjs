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

async function setup(page, { width = 402, height = 874 } = {}, before) {
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
        machine: 'linuxbox',
        hosts: state.hosts || [],
        background: state.background || [],
        queued: state.queued || [],
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
    const { text, thread } = r.request().postDataJSON();
    state.sent.push(thread ? { id, text, thread } : { id, text });
    const m = { ...msg('you', text, 9), id: 'sent' + state.sent.length, thread: thread || '' };
    state.messages[id].push(m);
    return r.fulfill({ json: m });
  });
  await page.route('**/api/corral/dm', r => r.fulfill({ json: state.conversations[1] }));
  await page.route(/\/api\/corral\/conversations\/[^/]+\/messages\/[^/]+\/delete$/, r => {
    const [id, , message] = r.request().url().split('/').slice(-4, -1);
    const gone = state.messages[id]
      .filter(m => m.id === message || m.thread === message)
      .map(m => m.id);
    state.messages[id] = state.messages[id].filter(m => !gone.includes(m.id));
    (state.deleted ||= []).push(...gone);
    return r.fulfill({ json: { deleted: gone } });
  });
  await page.route('**/api/corral/activity', r =>
    r.fulfill({ json: { items: state.activity || [] } })
  );
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
  await before?.(page, state);
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
  // Both agents live in ~/git, so they group under it.
  await expect(app.locator('.corral-row-name')).toHaveText(['infra', 'git', 'alex', 'sam']);
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

test('a sent message stays in view as the working line and replies arrive', async ({ page }) => {
  const { app, state, emit } = await setup(page);
  // A conversation long enough to scroll.
  state.messages[INFRA] = Array.from({ length: 30 }, (_, i) => ({
    ...msg(i % 2 ? ALEX : 'you', 'Line ' + i + ' about the certificates and the servers.', 0),
    id: 'line' + i,
  }));
  await app.getByRole('listitem').filter({ hasText: 'infra' }).click();
  const list = app.locator('.corral-messages');
  const shown = async text => {
    const [box, view] = await Promise.all([
      list.locator('.corral-text', { hasText: text }).last().boundingBox(),
      list.boundingBox(),
    ]);
    return !!box && box.y + box.height <= view.y + view.height + 1;
  };
  await expect.poll(() => shown('Line 29')).toBe(true);
  await app.getByRole('button', { name: 'Write a message' }).click();
  const field = app.locator('textarea.native-input');
  await field.fill('@alex status?');
  await field.press('Enter');
  await expect.poll(() => state.sent.length).toBe(1);
  // The agent wakes: a working line appears under the messages, and the message stays in view.
  emit({ type: 'status', conversation: INFRA, agent: ALEX, status: 'thinking' });
  await expect(app.locator('.corral-working')).toBeVisible();
  await expect.poll(() => shown('@alex status?')).toBe(true);
  // So does the reply, once the line goes.
  emit({ type: 'status', conversation: INFRA, agent: ALEX, status: null });
  emit({
    type: 'message',
    conversation: INFRA,
    message: { ...msg(ALEX, 'All green.', 9), id: 'g' },
  });
  await expect.poll(() => shown('All green.')).toBe(true);
  // Scrolled back to read, new messages do not pull the list down.
  await list.evaluate(e => (e.scrollTop = 0));
  await page.waitForTimeout(100);
  emit({
    type: 'message',
    conversation: INFRA,
    message: { ...msg(ALEX, 'One more thing.', 8), id: 'o' },
  });
  await page.waitForTimeout(200);
  expect(await list.evaluate(e => e.scrollTop)).toBeLessThan(10);
});

test('Tab steps through the names to mention, putting each in place', async ({ page }) => {
  const { app, state } = await setup(page);
  await app.getByRole('listitem').filter({ hasText: 'infra' }).click();
  await app.getByRole('button', { name: 'Write a message' }).click();
  const field = app.locator('textarea.native-input');
  await field.pressSequentially('hey @');
  const chips = app.locator('.corral-suggestion');
  await expect(chips).toHaveText(['@alex', '@sam', '@here']);
  await field.press('Tab');
  await expect(field).toHaveValue('hey @alex');
  await expect(chips.nth(0)).toHaveClass(/active/);
  await field.press('Tab');
  await expect(field).toHaveValue('hey @sam');
  await expect(chips.nth(1)).toHaveClass(/active/);
  await field.press('Tab');
  await field.press('Tab');
  // Round to the first again, and Shift-Tab goes back.
  await expect(field).toHaveValue('hey @alex');
  await field.press('Shift+Tab');
  await expect(field).toHaveValue('hey @here');
  // The open composer stands in for the prompt row; there is one message box.
  await expect(app.locator('.corral-prompt-row')).toBeHidden();
  await page.screenshot({ path: 'artifacts/browser/corral-tab.png' });
  // Return keeps the name rather than sending.
  await field.press('Enter');
  await expect(field).toHaveValue('hey @here ');
  await expect(app.locator('.corral-suggest')).toBeHidden();
  expect(state.sent).toEqual([]);
  // A narrowed @word cycles only its matches; Escape closes them.
  await field.pressSequentially('and @s');
  await expect(chips).toHaveText(['@sam']);
  await field.press('Tab');
  await expect(field).toHaveValue('hey @here and @sam');
  await field.press('Escape');
  await expect(app.locator('.corral-suggest')).toBeHidden();
  await field.pressSequentially(' ok');
  await field.press('Enter');
  await expect.poll(() => state.sent).toEqual([{ id: INFRA, text: 'hey @here and @sam ok' }]);
});

test('an agent with a picture shows it in the sidebar and beside its messages', async ({
  page,
}) => {
  const PICTURE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#e68e0d"/></svg>';
  const asked = [];
  const { app, state } = await setup(page, {}, async (page, state) => {
    state.agents[0].avatar = 1761650000000;
    await page.route(/\/api\/corral\/agents\/[^/]+\/avatar/, r => {
      asked.push({ url: r.request().url(), client: r.request().headers()['x-hyprland-client'] });
      return r.fulfill({ body: PICTURE, contentType: 'image/svg+xml' });
    });
  });
  const pictured = app
    .locator('.corral-agent-row', { hasText: 'alex' })
    .locator('.corral-avatar img');
  await expect(pictured).toBeVisible();
  await expect.poll(() => pictured.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  // Without one, the initial.
  await expect(
    app.locator('.corral-agent-row', { hasText: 'sam' }).locator('.corral-avatar')
  ).toHaveText('S');
  await app.getByRole('listitem').filter({ hasText: 'infra' }).click();
  await expect(
    app.locator('.corral-group', { hasText: 'On it.' }).locator('.corral-avatar img')
  ).toBeVisible();
  // It is asked for once, with the app's header, by version.
  expect(asked.length).toBe(1);
  expect(asked[0].client).toBe('1');
  expect(asked[0].url).toContain(`/api/corral/agents/${ALEX}/avatar?v=1761650000000`);
});

test('a reply in a thread stays in the thread, and the message shows how many it has', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page);
  await app.getByRole('listitem').filter({ hasText: 'infra' }).click();
  const list = app.locator('.corral-messages');
  // An older message's menu offers a thread.
  await list.locator('.corral-text', { hasText: 'On it.' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply in thread' }).click();
  await expect(app.locator('.corral-title')).toHaveText('Thread');
  await expect(app.locator('.corral-subtitle')).toHaveText('#infra');
  await expect(list.locator('.corral-text')).toHaveCount(1);
  await expect(list.locator('.corral-divider')).toHaveText('No replies yet');
  await app.getByRole('button', { name: 'Write a message' }).click();
  const field = app.locator('textarea.native-input');
  await field.fill('Which certs, exactly?');
  await field.press('Enter');
  await expect
    .poll(() => state.sent)
    .toEqual([{ id: INFRA, text: 'Which certs, exactly?', thread: 'm2' }]);
  await expect(list).toContainText('Which certs, exactly?');
  // The agent answers in the thread, with a working line there.
  emit({ type: 'status', conversation: INFRA, agent: ALEX, thread: 'm2', status: 'thinking' });
  await expect(app.locator('.corral-working')).toHaveText(/@alex is thinking/);
  emit({ type: 'status', conversation: INFRA, agent: ALEX, thread: 'm2', status: null });
  emit({
    type: 'message',
    conversation: INFRA,
    message: { ...msg(ALEX, 'The api and web ones.', 5), id: 'r1', thread: 'm2' },
  });
  await expect(list).toContainText('The api and web ones.');
  await expect(list.locator('.corral-divider')).toHaveText('2 replies');
  await page.screenshot({ path: 'artifacts/browser/corral-thread.png' });
  // Back in the channel, the replies are not in the timeline; the message says how many.
  await app.getByRole('button', { name: 'Back to #infra' }).click();
  await expect(app.locator('.corral-title')).toHaveText('#infra');
  await expect(list).not.toContainText('The api and web ones.');
  const replies = list.locator('.corral-replies');
  await expect(replies).toContainText('2 replies');
  await replies.click();
  await expect(app.locator('.corral-title')).toHaveText('Thread');
  await expect(list).toContainText('The api and web ones.');
});

test('agents whose homes share a folder group under it and collapse', async ({ page }) => {
  const { app } = await setup(page, {}, async (page, state) => {
    state.agents.push({
      id: 'a4444444-4444-4444-8444-444444444444',
      name: 'Ops',
      engine: 'codex',
      model: '',
      effort: '',
      home: '/home/qa/git/infra-tools',
      instructions: '',
      working: [],
    });
    // alex's home moves beside it, under ~/git, with sam elsewhere.
    state.agents[0].home = '/home/qa/git/infra';
    state.agents[1].home = '/home/qa/sites/web';
  });
  const group = app.getByRole('group', { name: 'git' });
  await expect(group.locator('.corral-row-name')).toHaveText(['git', 'alex', 'Ops']);
  await expect(group.locator('.corral-count')).toHaveText('2');
  // sam stands alone.
  await expect(app.locator('.corral-agent-row', { hasText: 'sam' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/browser/corral-groups.png' });
  await group.getByRole('button', { name: /git/ }).click();
  await expect(group.locator('.corral-agent-row')).toHaveCount(0);
  await expect(group.locator('.corral-group-head')).toHaveAttribute('aria-expanded', 'false');
  // Collapsed stays collapsed after a reload.
  await page.reload();
  await expect(app).toBeVisible();
  await expect(app.getByRole('group', { name: 'git' }).locator('.corral-agent-row')).toHaveCount(0);
  await app.getByRole('group', { name: 'git' }).getByRole('button', { name: /git/ }).click();
  await expect(app.getByRole('group', { name: 'git' }).locator('.corral-agent-row')).toHaveCount(2);
});

test('spoken names become the mentions they sound like', async ({ page }) => {
  await page.goto('/native/');
  const heard = await page.evaluate(() => {
    const agents = ['AsBuilt', 'WhatWaltBuilt', 'Corral', 'alex'];
    const channels = ['MovingRecords', 'infra'];
    return [
      'At as built, can you check with at what walt built?',
      'Ask at coral to post in hash moving records.',
      'hashtag Moving Records is quiet, at here.',
      'As built, where were we?',
      "Hey what walt built: read at as-built's notes.",
      'Meet at noon at the corral with at Alex.',
      'Look at everyone in #infra, @WhatWaltBuilt',
    ].map(text => HyprlandCorral.spokenMentions(text, agents, channels));
  });
  expect(heard).toEqual([
    '@AsBuilt, can you check with @WhatWaltBuilt?',
    'Ask @Corral to post in #MovingRecords.',
    '#MovingRecords is quiet, @here.',
    '@AsBuilt, where were we?',
    "Hey @WhatWaltBuilt: read @AsBuilt's notes.",
    // An ordinary "at" stays, and a short name has to be heard exactly.
    'Meet at noon at the corral with @alex.',
    'Look @everyone in #infra, @WhatWaltBuilt',
  ]);
});

// A microphone that records at once and a host that transcribes it, as in the Chat specs.
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
          : { text: 'Hey alex, check hash infra' },
    })
  );
  await page.route('**/api/voice', r => r.fulfill({ json: { available: true } }));
  state.replies = [];
  state.spoken = [];
  await page.route(/\/api\/corral\/conversations\/[^/]+\/response\?/, r => {
    const url = new URL(r.request().url());
    const session = url.pathname.split('/').at(-2) + '/' + url.searchParams.get('thread');
    return r.fulfill({
      json: {
        session,
        working: false,
        answer: state.replies.at(-1) || null,
        paragraphs: state.replies,
      },
    });
  });
  await page.route(/\/api\/corral\/conversations\/[^/]+\/speech\?/, r => {
    const url = new URL(r.request().url());
    state.spoken.push({ path: url.pathname + url.search, ...r.request().postDataJSON() });
    return r.fulfill({ contentType: 'audio/wav', body: 'fixture audio' });
  });
}

test('a tap on the microphone sends with mentions; holding Talk reads replies aloud', async ({
  page,
}) => {
  const { app, state } = await setup(page, {}, voice);
  await app.getByRole('listitem').filter({ hasText: 'infra' }).click();
  state.replies = [{ id: 'm2', text: 'alex says: On it.' }];
  const floating = app.locator('.herdr-voice-microphone');
  await app.locator('.dictation-button').click();
  await expect(floating).toHaveText('Send');
  await floating.click();
  // The spoken names went out as the mentions they sounded like.
  await expect.poll(() => state.sent).toEqual([{ id: INFRA, text: 'Hey @alex, check #infra' }]);
  await expect(floating).toHaveText('Talk');
  await page.screenshot({ path: 'artifacts/browser/corral-voice.png' });
  // Holding Talk reads the next reply aloud, from the conversation it came in.
  await floating.click({ delay: 650 });
  await expect(floating.locator('.herdr-voice-speaker')).toBeVisible();
  state.replies.push({ id: 'm5', text: 'alex says: Certs look fine.' });
  await expect
    .poll(() => state.spoken, { timeout: 6000 })
    .toMatchObject([
      { path: `/api/corral/conversations/${INFRA}/speech?thread=`, response_id: 'm5' },
    ]);
  // Tapping the bar microphone turns Voice off.
  await app.locator('.dictation-button').click();
  await expect(floating).toBeHidden();
});

test("another host's agents group under it, and a new agent can be made there", async ({
  page,
}) => {
  const WINNY = 'a4444444-4444-4444-8444-444444444444@winbox';
  const { app, state } = await setup(page, {}, async (page, state) => {
    state.hosts = [
      {
        name: 'winbox',
        online: true,
        error: '',
        engines: [
          {
            id: 'claude',
            label: 'Claude',
            models: [{ id: 'sonnet', label: 'Sonnet' }],
            efforts: ['low'],
          },
        ],
      },
      { name: 'mini', online: false, error: 'mini is not reachable', engines: [] },
    ];
    state.agents.push({
      id: WINNY,
      name: 'Winny',
      host: 'winbox',
      engine: 'claude',
      model: 'sonnet',
      effort: '',
      home: 'C:\\Users\\Justin',
      instructions: '',
      working: [],
    });
    const dm = { id: 'c3333333-3333-4333-8333-333333333333', kind: 'dm', name: '', topic: '' };
    state.conversations.push({ ...dm, members: [WINNY], working: [] });
    state.messages[dm.id] = [];
    await page.route('**/api/corral/dm', r => r.fulfill({ json: state.conversations.at(-1) }));
  });
  // Its own group, under the machine's name, even alone.
  const group = app.getByRole('group', { name: 'winbox' });
  await expect(group.locator('.corral-row-name')).toHaveText(['winbox', 'Winny']);
  await group.getByRole('listitem').click();
  await expect(app.locator('.corral-subtitle')).toHaveText(
    'Claude · sonnet · on winbox · C:\\Users\\Justin'
  );
  await page.screenshot({ path: 'artifacts/browser/corral-hosts.png' });
  // A new agent: the machine decides the engines, and Files cannot browse it.
  await app.getByRole('button', { name: 'All conversations' }).click();
  await app.getByRole('button', { name: 'New agent' }).click();
  const form = app.locator('.corral-form');
  await expect(form.getByLabel('Machine').locator('option')).toHaveText([
    'linuxbox (this one)',
    'winbox',
    'mini · not reachable',
  ]);
  await expect(form.getByLabel('Agent').locator('option')).toHaveText([
    'Claude',
    'Claude X',
    'Codex',
  ]);
  await form.getByLabel('Machine').selectOption('winbox');
  await expect(form.getByLabel('Agent').locator('option')).toHaveText(['Claude']);
  await expect(form.getByRole('button', { name: 'Choose…' })).toBeHidden();
  await form.getByLabel('Name').fill('Winfix');
  await form.getByLabel('Model').selectOption('sonnet');
  await form.getByLabel('Home folder').fill('~');
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect
    .poll(() => state.created)
    .toEqual([
      {
        name: 'Winfix',
        engine: 'claude',
        model: 'sonnet',
        effort: '',
        home: '~',
        instructions: '',
        host: 'winbox',
      },
    ]);
});

test('Activity lists every conversation and thread by its latest message, and opens one', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page, {}, (page, state) => {
    state.messages[INFRA].push({ ...msg(ALEX, 'All three renewed.', 5), id: 'r1', thread: 'm1' });
    state.activity = [
      {
        conversation: INFRA,
        thread: 'm1',
        message: {
          id: 'r1',
          ts: '2026-10-28T10:05:00.000Z',
          author: ALEX,
          text: 'All three renewed.',
        },
        root: {
          id: 'm1',
          ts: '2026-10-28T10:01:00.000Z',
          author: 'you',
          text: '@alex can you rotate the certs?',
        },
        replies: 1,
      },
      {
        conversation: INFRA,
        thread: '',
        message: { id: 'm2', ts: '2026-10-28T10:02:00.000Z', author: ALEX, text: 'On it.' },
        root: null,
        replies: 0,
      },
    ];
  });
  // The sidebar's panel key opens Activity in the conversation's place on a phone.
  await app.getByRole('button', { name: 'Activity' }).first().click();
  const list = app.getByRole('list', { name: 'Activity' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.locator('.corral-activity-place .corral-row-name')).toHaveText([
    'Thread in #infra',
    '#infra',
  ]);
  await expect(list.locator('.corral-activity-root')).toHaveText(
    'Justin: @alex can you rotate the certs?'
  );
  // Replies not looked at yet stand out.
  await expect(list.locator('.fresh')).toHaveCount(2);
  await page.screenshot({ path: 'artifacts/browser/corral-activity.png' });
  // A row opens its thread, as its message's Reply would.
  await list.getByRole('listitem').first().click();
  await expect(app.locator('.corral-title')).toHaveText('Thread');
  await expect(app.locator('.corral-messages')).toContainText('All three renewed.');
  await expect(app.locator('.corral-details')).toBeHidden();
  // Seen now; a new reply elsewhere brings the list up to date.
  await app.getByRole('button', { name: 'Activity' }).last().click();
  await expect(list.locator('.fresh')).toHaveCount(1);
  state.activity.unshift({
    conversation: DM,
    thread: '',
    message: { id: 'd1', ts: '2026-10-28T10:09:00.000Z', author: ALEX, text: 'Backups done.' },
    root: null,
    replies: 0,
  });
  emit({ type: 'message', conversation: DM, message: msg(ALEX, 'Backups done.', 9) });
  await expect(list.locator('.corral-activity-place .corral-row-name').first()).toHaveText('@alex');
});

test('with room, Activity sits beside the conversation', async ({ page }) => {
  const { app, state } = await setup(page, { width: 1400, height: 900 }, (page, state) => {
    state.activity = [
      {
        conversation: INFRA,
        thread: '',
        message: { id: 'm2', ts: '2026-10-28T10:02:00.000Z', author: ALEX, text: 'On it.' },
        root: null,
        replies: 0,
      },
    ];
  });
  await app.getByRole('button', { name: 'Activity' }).first().click();
  await app.getByRole('list', { name: 'Activity' }).getByRole('listitem').click();
  await expect(app.locator('.corral-title')).toHaveText('#infra');
  await expect(app.locator('.corral-details')).toBeVisible();
  await expect(app.locator('.corral-side')).toBeVisible();
  // Its key is in the conversation's bar, beside the panel, not over the sidebar.
  await expect(app.getByRole('button', { name: 'Activity', exact: true })).toHaveCount(1);
  await expect(app.locator('.corral-main').getByRole('button', { name: 'Activity' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/browser/corral-activity-wide.png' });
  // The panel stays open across visits.
  await page.reload();
  await page.getByText('corral', { exact: true }).first().click();
  await expect(page.locator('#remote-corral-app .corral-details')).toBeVisible();
});

test('work an agent left running shows apart from a turn under way', async ({ page }) => {
  const { app, emit } = await setup(page, {}, (page, state) => {
    state.background = [
      { conversation: INFRA, agent: ALEX, thread: '', command: 'bash tools/render.sh' },
    ];
  });
  const channel = app.locator('.corral-row:not(.corral-agent-row)').filter({ hasText: 'infra' });
  await expect(channel.locator('.corral-busy.background')).toBeVisible();
  const alex = app.locator('.corral-agent-row').filter({ hasText: 'alex' });
  await expect(alex.locator('.corral-row-status')).toHaveText(
    'running in the background in #infra'
  );
  await expect(alex.locator('.corral-busy.background')).toBeVisible();
  await channel.click();
  const line = app.locator('.corral-working');
  await expect(line).toHaveText(/@alex · in the background: bash tools\/render\.sh/);
  await expect(line).toHaveClass(/background/);
  // Background work is the agent's own; Stop is for a turn under way.
  await expect(line.getByRole('button', { name: 'Stop' })).toBeHidden();
  await page.screenshot({ path: 'artifacts/browser/corral-background.png' });
  // A turn under way shows green, with Stop, and the background work beside it.
  emit({ type: 'status', conversation: INFRA, agent: SAM, status: 'thinking' });
  await expect(line).not.toHaveClass(/background/);
  await expect(line.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(line).toHaveText(/@sam is thinking….*@alex · in the background/);
  emit({ type: 'status', conversation: INFRA, agent: SAM, status: null });
  // When it finishes, the line and the dots go.
  emit({ type: 'background', background: [] });
  await expect(line).toBeHidden();
  await expect(app.locator('.corral-busy')).toHaveCount(0);
});

test('the filter narrows Activity to the agent or room open, until pressed again', async ({
  page,
}) => {
  const WEB = 'c4444444-4444-4444-8444-444444444444';
  const item = (conversation, thread, author, text, minute, agents) => ({
    conversation,
    thread,
    message: { id: 'x' + minute, ts: `2026-10-28T10:${minute}:00.000Z`, author, text },
    root: thread
      ? { id: thread, ts: '2026-10-28T10:01:00.000Z', author: 'you', text: 'certs?' }
      : null,
    agents,
    replies: thread ? 1 : 0,
  });
  const { app } = await setup(page, { width: 1400, height: 900 }, (page, state) => {
    state.conversations.push({
      id: WEB,
      kind: 'channel',
      name: 'web',
      topic: '',
      members: [SAM],
      working: [],
    });
    state.messages[WEB] = [msg(SAM, 'Deployed.', 7)];
    state.activity = [
      item(INFRA, 'm1', ALEX, 'All three renewed.', 30, [ALEX]),
      item(WEB, '', SAM, 'Deployed.', 20, [SAM]),
      item(DM, '', ALEX, 'Backups done.', 10, [ALEX]),
    ];
  });
  const places = app.locator('.corral-activity-place .corral-row-name');
  const filter = app.getByRole('button', { name: 'Filter Activity' });
  // Nothing open: nothing to filter by.
  await app.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(places).toHaveText(['Thread in #infra', '#web', '@alex']);
  await expect(filter).toBeDisabled();
  // In alex's direct message, the filter keeps what alex is part of.
  await app.locator('.corral-agent-row').filter({ hasText: 'alex' }).click();
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(app.locator('.corral-filter-note')).toHaveText('Only @alex');
  await expect(places).toHaveText(['Thread in #infra', '@alex']);
  await page.screenshot({ path: 'artifacts/browser/corral-activity-filter.png' });
  // Opening a row keeps the filter on what it was pressed for.
  await app.getByRole('list', { name: 'Activity' }).getByRole('listitem').first().click();
  await expect(app.locator('.corral-title')).toHaveText('Thread');
  await expect(places).toHaveText(['Thread in #infra', '@alex']);
  // Pressed again, everything shows; in a room, it keeps the room and its agents.
  await filter.click();
  await expect(places).toHaveCount(3);
  await expect(app.locator('.corral-filter-note')).toBeHidden();
  await app.locator('.corral-row:not(.corral-agent-row)').filter({ hasText: 'web' }).click();
  await filter.click();
  await expect(app.locator('.corral-filter-note')).toHaveText("Only #web's agents");
  await expect(places).toHaveText(['#web']);
});

test('a message sent while its agent works shows as waiting until it is given', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page);
  await app.getByRole('listitem').filter({ hasText: 'infra' }).first().click();
  emit({ type: 'status', conversation: INFRA, agent: ALEX, status: 'Bash · make render' });
  await app.getByRole('button', { name: 'Write a message' }).click();
  const field = app.locator('textarea.native-input');
  await field.fill('@alex and the web certs too');
  await field.press('Enter');
  await expect.poll(() => state.sent.length).toBe(1);
  // Corral says it waits for alex's turn to end.
  emit({ type: 'queued', queued: [{ conversation: INFRA, message: 'sent1', agents: [ALEX] }] });
  const sent = app.locator('.corral-text').filter({ hasText: 'and the web certs too' });
  await expect(sent).toHaveClass(/queued/);
  await expect(app.locator('.corral-queued')).toHaveText(
    'Waiting for @alex to finish its current turn'
  );
  await expect(app.locator('.corral-text.queued')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/browser/corral-queued.png' });
  // Its next turn starts with it: delivered.
  emit({ type: 'queued', queued: [] });
  await expect(sent).not.toHaveClass(/queued/);
  await expect(app.locator('.corral-queued')).toHaveCount(0);
});

test('any message can be deleted, and a thread goes with the message it hangs from', async ({
  page,
}) => {
  const { app, state } = await setup(page, {}, (page, state) => {
    state.messages[INFRA].push({ ...msg(ALEX, 'All three renewed.', 5), id: 'r1', thread: 'm1' });
  });
  await app.getByRole('listitem').filter({ hasText: 'infra' }).first().click();
  const list = app.locator('.corral-messages');
  // An agent's reply.
  await list.locator('.corral-text', { hasText: 'On it.' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByText('Delete this message?')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect.poll(() => state.deleted).toEqual(['m2']);
  await expect(list).not.toContainText('On it.');
  // The message a thread hangs from says how many replies go with it.
  await list.locator('.corral-text', { hasText: 'rotate the certs' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByText('Delete this message and its 1 reply?')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect.poll(() => state.deleted).toEqual(['m2', 'm1', 'r1']);
  await expect(list).not.toContainText('rotate the certs');
});

test('a thread stays open when Corral reconnects, and after a reload', async ({ page }) => {
  const { app, state } = await setup(page, {}, (page, state) => {
    state.messages[INFRA].push({ ...msg(ALEX, 'All three renewed.', 5), id: 'r1', thread: 'm1' });
  });
  await app.getByRole('listitem').filter({ hasText: 'infra' }).first().click();
  await app.locator('.corral-replies').click();
  await expect(app.locator('.corral-title')).toHaveText('Thread');
  // The host restarts: its socket closes, and Corral reconnects.
  await state.ws.close();
  await page.waitForTimeout(2500);
  await expect(app.locator('.corral-title')).toHaveText('Thread');
  await expect(app.locator('.corral-messages')).toContainText('All three renewed.');
  // The shell reopens Corral after a reload, and Corral its thread.
  await page.reload();
  await expect(page.locator('#remote-corral-app .corral-title')).toHaveText('Thread');
});
