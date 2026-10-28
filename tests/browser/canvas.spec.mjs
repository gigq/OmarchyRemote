import { test, expect } from './fixtures.mjs';

const ID = '4d8ab544-8cc5-430e-8a40-0aec58bc3b10';
const VIEW = `/api/canvas/view/${ID}/0123456789abcdef0123456789abcdef/`;
const entry = (role, text, name = '') => ({ role, text, name, time: '2026-10-17T10:00:00Z' });
// The page Claude wrote, with a button that answers for the person.
const PAGE = `<!doctype html><html><body style="background:#123">
<h1>Dinner plan</h1>
<button onclick="parent.postMessage({ type: 'canvas', text: 'Show the vegetarian version' }, '*')">Vegetarian</button>
</body></html>`;

async function setup(page, before) {
  await page.setViewportSize({ width: 402, height: 874 });
  const state = {
    session: {
      id: ID,
      title: 'Plan dinner',
      entries: [entry('user', 'Plan dinner'), entry('assistant', 'Here is a dinner plan.')],
      folder: '/home/qa/Canvas/2026-10-17-plan-dinner-4d8ab544',
      busy: false,
      partial: '',
      seq: 0,
      n: 0,
      view: VIEW,
      version: 1,
      page: true,
    },
    sent: [],
    loads: [],
    paths: [],
    list: [
      {
        id: ID,
        title: 'Plan dinner',
        preview: 'Here is a dinner plan.',
        updated: new Date().toISOString(),
        busy: false,
      },
    ],
    n: 0,
  };
  await page.route('**/api/**', r => r.abort());
  await page.route('**/api/canvas', r =>
    r.fulfill({
      json: {
        folder: '~/Canvas',
        available: true,
        agent: 'claude',
        agents: [{ id: 'claude', label: 'Claude', models: [], efforts: ['high'], defaults: {} }],
        chats: state.list,
      },
    })
  );
  await page.route(/\/api\/canvas\/[0-9a-f-]{36}$/, r => r.fulfill({ json: state.session }));
  await page.route('**/api/canvas/send', r => {
    state.sent.push(r.request().postDataJSON());
    return r.fulfill({ json: { id: ID } });
  });
  await page.route('**/api/canvas/view/**', r => {
    const url = new URL(r.request().url());
    state.loads.push(url.search);
    state.paths.push(url.pathname.slice(VIEW.length) + url.search);
    // A kept page says which turn left it.
    const turn = url.pathname.match(/\/@(\d+)\//)?.[1];
    const body = turn ? `<!doctype html><h1>Turn ${turn}</h1>` : PAGE;
    return r.fulfill({ body, contentType: 'text/html' });
  });
  await page.routeWebSocket('**/api/canvas/ws', ws => {
    state.ws = ws;
  });
  await before?.(page, state);
  await page.goto('/native/');
  await page.getByText('canvas', { exact: true }).first().click();
  const app = page.locator('#remote-canvas-app');
  await expect(app).toBeVisible();
  const emit = event => state.ws.send(JSON.stringify({ ...event, n: ++state.n }));
  return { app, state, emit };
}

test('a canvas shows the page Claude wrote, reloads it as it changes, and lets it answer', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page);
  await expect(app.locator('.chat-row-title')).toHaveText('Plan dinner');
  await app.locator('.chat-row').click();
  const frame = page.frameLocator('#remote-canvas-app iframe.canvas-frame');
  await expect(frame.locator('h1')).toHaveText('Dinner plan');
  // The frame runs the page apart from the shell.
  const sandbox = await app.locator('iframe.canvas-frame').getAttribute('sandbox');
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  const subtitle = app.locator('.canvas-subtitle');
  await expect(subtitle.locator('.canvas-said')).toHaveText('Here is a dinner plan.');
  // Tapping the subtitle shows the question too.
  await subtitle.click();
  await expect(subtitle.locator('.canvas-asked')).toBeVisible();
  // The page's button sends its message, with the screen and theme for Claude.
  await frame.getByRole('button', { name: 'Vegetarian' }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  const sent = state.sent[0];
  expect(sent).toMatchObject({ id: ID, text: 'Show the vegetarian version', agent: 'claude' });
  expect(sent.context.device).toBe('phone');
  expect(sent.context.screen.width).toBeGreaterThan(300);
  expect(sent.context.theme.background).toMatch(/^#|rgb/);
  // One line says what Claude is doing, then becomes its reply; no second status line.
  emit({ type: 'entry', id: ID, index: 2, entry: entry('user', 'Show the vegetarian version') });
  emit({ type: 'busy', id: ID });
  await expect(subtitle.locator('.canvas-said')).toHaveText('Claude is thinking…');
  await expect(app.locator('.chat-status')).toBeHidden();
  emit({
    type: 'entry',
    id: ID,
    index: 3,
    entry: entry('tool', 'vegetarian recipes', 'WebSearch'),
  });
  await expect(subtitle.locator('.canvas-said')).toHaveText('Searching · vegetarian recipes');
  emit({ type: 'entry', id: ID, index: 4, entry: entry('tool', 'index.html', 'Write') });
  await expect(subtitle.locator('.canvas-said')).toHaveText('Claude is drawing…');
  // A changed page reloads the frame; an unchanged version does not.
  const before = state.loads.length;
  emit({ type: 'page', id: ID, version: 2, page: true });
  await expect.poll(() => state.loads.length).toBe(before + 1);
  expect(state.loads.at(-1)).toBe('?v=2');
  emit({ type: 'page', id: ID, version: 2, page: true });
  await page.waitForTimeout(300);
  expect(state.loads.length).toBe(before + 1);
  emit({ type: 'entry', id: ID, index: 5, entry: entry('assistant', 'Swapped in a lentil stew.') });
  emit({ type: 'done', id: ID, error: null });
  await expect(subtitle.locator('.canvas-said')).toHaveText('Swapped in a lentil stew.');
  await page.screenshot({ path: 'artifacts/browser/canvas.png' });
});

test('a new canvas waits for its first page and asks for anything', async ({ page }) => {
  const { app, state } = await setup(page);
  await app.getByRole('button', { name: 'New chat' }).click();
  await expect(app.locator('.canvas-welcome')).toContainText('Ask for anything');
  await expect(app.locator('iframe.canvas-frame')).toBeHidden();
  const field = app.locator('textarea.native-input');
  await expect(field).toHaveAttribute('placeholder', 'Ask Claude for anything…');
  await field.fill('Show me the solar system');
  await field.press('Enter');
  await expect.poll(() => state.sent.at(-1)?.text).toBe('Show me the solar system');
  expect(state.sent.at(-1).context).toBeTruthy();
});

// A microphone that records at once, a host that transcribes it, and an audio element the test
// moves through its four seconds.
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
        this.duration = 4;
        this.currentTime = 0;
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
        if (this.source.startsWith('blob:')) window.speech = this;
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
          : { text: 'Make it vegetarian' },
    })
  );
  await page.route('**/api/voice', r => r.fulfill({ json: { available: true } }));
  state.reply = { answer: { id: 'old', text: 'Here is a dinner plan.' } };
  await page.route(/\/api\/canvas\/[0-9a-f-]{36}\/response$/, r =>
    r.fulfill({ json: { session: ID, working: false, paragraphs: [], ...state.reply } })
  );
  await page.route(/\/api\/canvas\/[0-9a-f-]{36}\/speech$/, r =>
    r.fulfill({ contentType: 'audio/wav', body: 'fixture audio' })
  );
}

test('in talk mode the reply is read aloud, its words lit as they are spoken', async ({ page }) => {
  const { app, state, emit } = await setup(page, voice);
  await app.locator('.chat-row').click();
  const said = app.locator('.canvas-subtitle .canvas-said');
  await expect(said).toHaveText('Here is a dinner plan.');
  // Holding the microphone turns on Voice with replies read aloud.
  await app.locator('.dictation-button').click({ delay: 650 });
  await expect(app.locator('.herdr-voice-speaker')).toBeVisible();
  const text = 'Swapped in a lentil stew with roasted carrots.';
  emit({ type: 'entry', id: ID, index: 2, entry: entry('user', 'Make it vegetarian') });
  emit({ type: 'entry', id: ID, index: 3, entry: entry('assistant', text) });
  state.reply = { answer: { id: 'new', text }, paragraphs: [{ id: 'new', text }] };
  const words = said.locator('.canvas-word');
  await expect(words).toHaveCount(8, { timeout: 6000 });
  await expect(said).toHaveText(text);
  await expect(said.locator('.spoken')).toHaveCount(1);
  // Halfway through the audio, about half the words are lit and the one being said stands out.
  await page.evaluate(() => (window.speech.currentTime = 2));
  await expect(said.locator('.current')).toHaveText('stew');
  await expect(said.locator('.spoken')).toHaveCount(5);
  await page.screenshot({ path: 'artifacts/browser/canvas-reading.png' });
  // When it ends, the subtitle is the plain reply again.
  await page.evaluate(() => {
    window.speech.ended = true;
    window.speech.onended();
  });
  await expect(words).toHaveCount(0);
  await expect(said).toHaveText(text);
});

test('back and forward step through earlier pages, and sending from one continues from there', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page);
  // Three turns, the first two with their pages kept.
  state.session.entries = [
    entry('user', 'Plan dinner'),
    entry('assistant', 'Here is a dinner plan.'),
    entry('user', 'Add dessert'),
    entry('tool', 'index.html', 'Write'),
    entry('assistant', 'Added a pie.'),
    entry('user', 'Make it vegan'),
    entry('assistant', 'All vegan now.'),
  ];
  state.session.turns = [
    { turn: 1, version: 11 },
    { turn: 2, version: 12 },
    { turn: 3, version: 13 },
  ];
  await app.locator('.chat-row').click();
  const frame = page.frameLocator('#remote-canvas-app iframe.canvas-frame');
  const said = app.locator('.canvas-subtitle .canvas-said');
  const back = app.getByRole('button', { name: 'Earlier page' });
  const forward = app.getByRole('button', { name: 'Later page' });
  const field = app.locator('textarea.native-input');
  await expect(frame.locator('h1')).toHaveText('Dinner plan');
  await expect(said).toHaveText('All vegan now.');
  await expect(forward).toBeDisabled();
  await back.click();
  await expect(frame.locator('h1')).toHaveText('Turn 2');
  await expect(said).toHaveText('2/3Added a pie.');
  await expect(field).toHaveAttribute('placeholder', 'Continue from here…');
  await back.click();
  await expect(frame.locator('h1')).toHaveText('Turn 1');
  await expect(said).toHaveText('1/3Here is a dinner plan.');
  await expect(back).toBeDisabled();
  await page.screenshot({ path: 'artifacts/browser/canvas-earlier.png' });
  // Forward returns to the live page.
  await forward.click();
  await forward.click();
  await expect(frame.locator('h1')).toHaveText('Dinner plan');
  await expect(field).toHaveAttribute('placeholder', 'Ask Claude for anything…');
  // Sending from an earlier page continues from it; the turns after it are gone.
  await back.click();
  await expect(said).toHaveText('2/3Added a pie.');
  await app.getByRole('button', { name: 'Write a message' }).click();
  await field.fill('Make it gluten free instead');
  await field.press('Enter');
  await expect.poll(() => state.sent.at(-1)?.from).toBe(2);
  emit({ type: 'rewound', id: ID, entries: 5, turns: state.session.turns.slice(0, 2) });
  emit({ type: 'entry', id: ID, index: 5, entry: entry('user', 'Make it gluten free instead') });
  emit({ type: 'busy', id: ID });
  await expect(said).toHaveText('Claude is thinking…');
  await expect(app.locator('.canvas-position')).toHaveCount(0);
  // Back now reaches the second turn, kept, not the vegan one that was dropped.
  await back.click();
  await expect(said).toHaveText('2/3Added a pie.');
});

test('a canvas has a design level, sent with each message and kept for new canvases', async ({
  page,
}) => {
  const { app, state } = await setup(page);
  await app.locator('.chat-row').click();
  const chip = app.locator('.chat-settings');
  // No level yet is medium.
  await expect(chip).toHaveText('medium UI · Default · default');
  await chip.click();
  const design = app.getByRole('group', { name: 'Design' });
  await expect(design.getByRole('button')).toHaveText(['quick', 'medium', 'detailed', 'max']);
  await expect(design.getByRole('button', { name: 'medium' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await design.getByRole('button', { name: 'max' }).click();
  await expect(chip).toHaveText('max UI · Default · default');
  await page.screenshot({ path: 'artifacts/browser/canvas-design.png' });
  await app.getByRole('button', { name: 'Write a message' }).click();
  const field = app.locator('textarea.native-input');
  await field.fill('Show me the Leafs season');
  await field.press('Enter');
  await expect.poll(() => state.sent.at(-1)?.design).toBe('max');
  // A new canvas starts with the level used last.
  await app.locator('.chat-thread-view .chat-new').click();
  await expect(chip).toHaveText('max UI · Default · default');
});

test('a page made for a wider screen offers a phone version, kept and shown on the phone', async ({
  page,
}) => {
  const { app, state, emit } = await setup(page);
  Object.assign(state.session, { layout: 'wide', variants: [], version: 2 });
  state.redraws = [];
  await page.route(/\/api\/canvas\/[0-9a-f-]{36}\/redraw$/, r => {
    state.redraws.push(r.request().postDataJSON());
    return r.fulfill({ json: { redrawing: 'phone' } });
  });
  await app.locator('.chat-row').click();
  const redraw = app.locator('.canvas-redraw');
  await expect(redraw).toHaveText('Redraw for phone');
  await expect.poll(() => state.paths.at(-1)).toBe('?v=2');
  await page.screenshot({ path: 'artifacts/browser/canvas-redraw.png' });
  await redraw.click();
  await expect.poll(() => state.redraws.length).toBe(1);
  expect(state.redraws[0].layout).toBe('phone');
  expect(state.redraws[0].context.device).toBe('phone');
  emit({ type: 'redraw', id: ID, layout: 'phone', state: 'started' });
  await expect(redraw).toHaveText('Redrawing for phone…');
  await expect(redraw).toBeDisabled();
  // The phone version arrives and is what the phone shows.
  emit({ type: 'page', id: ID, version: 3, page: true, layout: 'wide', variants: ['phone'] });
  emit({ type: 'redraw', id: ID, layout: 'phone', state: 'done', error: null });
  await expect(redraw).toBeHidden();
  await expect.poll(() => state.paths.at(-1)).toBe('index.phone.html?v=3');
  // A wider screen shows the page as it was made, and offers nothing.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => state.paths.at(-1)).toBe('?v=3');
  await expect(redraw).toBeHidden();
  // A later turn changes the page: the phone version is out of date, and is offered again.
  await page.setViewportSize({ width: 402, height: 874 });
  emit({ type: 'page', id: ID, version: 4, page: true, layout: 'wide', variants: [] });
  await expect(redraw).toHaveText('Redraw for phone');
  await expect.poll(() => state.paths.at(-1)).toBe('?v=4');
  // A failed redraw says so and can be tried again.
  emit({ type: 'redraw', id: ID, layout: 'phone', state: 'started' });
  emit({ type: 'redraw', id: ID, layout: 'phone', state: 'done', error: 'Claude stopped' });
  await expect(redraw).toHaveText('Redraw for phone failed · try again');
  await expect(redraw).toBeEnabled();
});

test('a page made on a phone offers a version for a wider screen', async ({ page }) => {
  const { app, state } = await setup(page);
  Object.assign(state.session, { layout: 'phone', variants: [] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await app.locator('.chat-row').click();
  await expect(app.locator('.canvas-redraw')).toHaveText('Redraw for this screen');
});

for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
])
  test(`a page goes full screen and back at ${viewport.width}px`, async ({ page }) => {
    const { app } = await setup(page);
    await page.setViewportSize(viewport);
    await app.locator('.chat-row').click();
    const frame = app.locator('iframe.canvas-frame');
    await expect(frame).toBeVisible();
    const before = await frame.boundingBox();
    await app.getByRole('button', { name: 'Full screen' }).click();
    const exit = app.getByRole('button', { name: 'Exit full screen' });
    await expect(exit).toBeVisible();
    // The page covers the whole window, over the header, subtitle, and composer.
    await expect
      .poll(async () => {
        const box = await frame.boundingBox();
        return [box.x, box.y, box.width, box.height].map(Math.round);
      })
      .toEqual([0, 0, viewport.width, viewport.height]);
    expect((await frame.boundingBox()).height).toBeGreaterThan(before.height);
    const atCorner = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.chat-stage'),
      { x: 20, y: 20 }
    );
    expect(atCorner).toBe(true);
    await page.screenshot({ path: `artifacts/browser/canvas-full-${viewport.width}.png` });
    // The frame is not reloaded on the way in or out.
    const loads = await frame.evaluate(f => f.dataset.src);
    await exit.click();
    await expect(exit).toBeHidden();
    await expect
      .poll(async () => Math.round((await frame.boundingBox()).height))
      .toBe(Math.round(before.height));
    expect(await frame.evaluate(f => f.dataset.src)).toBe(loads);
    // Escape leaves it too.
    await app.getByRole('button', { name: 'Full screen' }).click();
    await expect(exit).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exit).toBeHidden();
  });

test('each canvas shows its icon in the list, or the Canvas mark until it has one', async ({
  page,
}) => {
  const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#e68e0d"/></svg>';
  const { app } = await setup(page, async (page, state) => {
    await page.route('**/icon.svg?v=*', r =>
      r.fulfill({ body: ICON, contentType: 'image/svg+xml' })
    );
    state.list = [
      { ...state.list[0], icon: `${VIEW}icon.svg?v=5` },
      {
        id: '5d8ab544-8cc5-430e-8a40-0aec58bc3b10',
        title: 'Tea types',
        preview: 'Three teas.',
        updated: new Date().toISOString(),
        busy: false,
      },
    ];
  });
  const rows = app.locator('.chat-row');
  await expect(rows).toHaveCount(2);
  const drawn = rows.first().locator('.chat-row-icon img');
  await expect(drawn).toHaveAttribute('src', `${VIEW}icon.svg?v=5`);
  await expect.poll(() => drawn.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await expect(rows.nth(1).locator('.canvas-icon-mark')).toBeVisible();
  // The title and preview sit beside the icon, measured together so a sliding app agrees.
  const beside = await rows.first().evaluate(row => {
    const icon = row.querySelector('.chat-row-icon').getBoundingClientRect();
    const title = row.querySelector('.chat-row-title').getBoundingClientRect();
    return title.left >= icon.right;
  });
  expect(beside).toBe(true);
  await page.screenshot({ path: 'artifacts/browser/canvas-icons.png' });
  // Selecting still works with icons.
  await app.getByRole('button', { name: 'Select' }).click();
  await app.getByRole('checkbox', { name: /Tea types/ }).click();
  await expect(app.locator('.chat-heading')).toHaveText('1 selected');
});

test('an empty canvas list shows the Canvas paintbrush, not Chat’s bubbles', async ({ page }) => {
  const { app } = await setup(page, async (page, state) => {
    state.list = [];
  });
  await expect(app.locator('.chat-list-empty-title')).toHaveText('No canvases yet');
  await expect(app.locator('.chat-list-empty-icon')).toHaveText('\uf1fc');
  await page.screenshot({ path: 'artifacts/browser/canvas-empty.png' });
});

test('the reply under the page can be selected and copied, and a tap still opens it', async ({
  page,
}) => {
  const { app } = await setup(page);
  await app.locator('.chat-row').click();
  const subtitle = app.getByRole('button', { name: /Here is a dinner plan/ });
  const said = app.locator('.canvas-said');
  await expect(said).toHaveText('Here is a dinner plan.');
  expect(
    await said.evaluate(e => getComputedStyle(e).webkitUserSelect || getComputedStyle(e).userSelect)
  ).toBe('text');
  // Dragging across the words selects them, without opening or closing the subtitle.
  const box = await said.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toContain('dinner plan');
  await expect(subtitle).toHaveAttribute('aria-expanded', 'false');
  // A plain tap opens it, as before, and Enter closes it.
  await page.evaluate(() => getSelection().removeAllRanges());
  await subtitle.click();
  await expect(subtitle).toHaveAttribute('aria-expanded', 'true');
  await subtitle.focus();
  await page.keyboard.press('Enter');
  await expect(subtitle).toHaveAttribute('aria-expanded', 'false');
});

test('links in the subtitle and on the page open in the browser window', async ({ page }) => {
  const { app, state } = await setup(page, async page => {
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
  });
  state.session.entries = [
    entry('user', 'Plan dinner'),
    entry('assistant', 'Recipe from https://example.com/stew, scaled for four.'),
  ];
  await app.locator('.chat-row').click();
  const opened = () =>
    page.evaluate(() =>
      webCommands.filter(c => c.action === 'open' && c.appID === 'webapp-link').map(c => c.url)
    );
  const link = app.locator('.canvas-said a.canvas-link');
  await expect(link).toHaveText('https://example.com/stew');
  await link.click();
  await expect.poll(opened).toEqual(['https://example.com/stew']);
  // Following the link did not open or close the subtitle.
  await expect(app.locator('.canvas-subtitle')).toHaveAttribute('aria-expanded', 'false');
  // A link on the page comes up from the frame, as the host's script sends it.
  await page.evaluate(() => HyprlandApps.logic.openApp('canvas'));
  await page
    .frameLocator('#remote-canvas-app iframe.canvas-frame')
    .locator('body')
    .evaluate(() =>
      parent.postMessage({ type: 'canvas-link', url: 'https://example.org/map' }, '*')
    );
  await expect.poll(opened).toEqual(['https://example.com/stew', 'https://example.org/map']);
});
