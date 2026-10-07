import { test, expect } from './fixtures.mjs';

// A mocked host: Muster never types into real panes in these tests.
const thread = (pane_id, state, extra = {}) => ({
  pane_id,
  tab_id: pane_id.split(':')[0] + ':t1',
  tab: '1',
  agent: 'claude',
  status: { question: 'blocked', ready: 'done', working: 'working', idle: 'idle' }[state],
  state,
  title: '',
  prompt: '',
  latest: '',
  updated: '2026-10-07T10:00:00Z',
  background: [],
  question: null,
  error: null,
  ...extra,
});
const COLOR = {
  id: 'menu-color',
  question: 'Which color do you prefer?',
  context: '',
  tabs: [
    { label: 'Color', done: false },
    { label: 'Fruits', done: false },
    { label: 'Submit', done: true },
  ],
  choices: [
    { number: 1, label: 'Red', detail: 'A warm color', checked: null },
    { number: 2, label: 'Green', detail: 'A cool color', checked: null },
    { number: 3, label: 'Type something.', detail: '', checked: null },
  ],
  multi: false,
  other: 3,
};
const FRUITS = {
  id: 'menu-fruits',
  question: 'Which fruits do you like?',
  context: '',
  tabs: COLOR.tabs,
  choices: [
    { number: 1, label: 'Apple', detail: '', checked: true },
    { number: 2, label: 'Pear', detail: '', checked: false },
    { number: 3, label: 'Plum', detail: '', checked: false },
    { number: 4, label: 'Chat about this', detail: '', checked: null },
  ],
  multi: true,
  other: null,
};

async function setup(page, { width = 402, height = 874 } = {}) {
  await page.setViewportSize({ width, height });
  const state = {
    projects: [
      {
        workspace_id: 'wA',
        label: 'NYCBevy',
        hidden: false,
        state: 'working',
        updated: '2026-10-07T10:05:00Z',
        threads: [
          thread('wA:p1', 'working', {
            title: 'Taxi physics',
            latest: 'Tuning the suspension now.',
            background: [{ description: 'cargo build' }],
          }),
        ],
      },
      {
        workspace_id: 'wB',
        label: 'PaperDiorama',
        hidden: false,
        state: 'question',
        updated: '2026-10-07T10:04:00Z',
        threads: [
          thread('wB:p1', 'question', {
            title: 'Pick a palette',
            prompt: 'Ask me about colors',
            question: COLOR,
          }),
          thread('wB:p2', 'ready', {
            tab: '2',
            title: 'Docs pass',
            prompt: 'Tidy the README',
            latest: 'Done. The README is tidy.',
          }),
        ],
      },
      {
        workspace_id: 'wC',
        label: 'OldThing',
        hidden: true,
        state: 'idle',
        updated: '2026-10-01T10:00:00Z',
        threads: [thread('wC:p1', 'idle', { title: 'Parked' })],
      },
    ],
    details: {},
    answers: [],
    sent: [],
    keys: [],
    hides: [],
  };
  const find = pane => state.projects.flatMap(p => p.threads).find(t => t.pane_id === pane);
  await page.route('**/api/**', r => r.abort());
  await page.route('**/api/muster', r => r.fulfill({ json: { projects: state.projects } }));
  await page.route('**/api/muster/hidden', r => {
    const body = r.request().postDataJSON();
    state.hides.push(body);
    for (const p of state.projects)
      if (p.workspace_id === body.workspace_id) p.hidden = body.hidden;
    return r.fulfill({ json: { hidden: 1 } });
  });
  await page.route(/\/api\/muster\/panes\/[^/]+$/, r => {
    const pane = decodeURIComponent(r.request().url().split('/').pop());
    return r.fulfill({
      json: {
        ...find(pane),
        paragraphs: [],
        updates: [],
        answer: { text: find(pane).latest || '' },
        working: find(pane).state === 'working',
        ...state.details[pane],
      },
    });
  });
  for (const action of ['answer', 'keys', 'send'])
    await page.route(new RegExp(`/api/muster/panes/[^/]+/${action}$`), r => {
      const pane = decodeURIComponent(r.request().url().split('/').at(-2));
      const body = r.request().postDataJSON();
      if (action === 'answer') {
        state.answers.push({ pane, ...body });
        // The first question leads to the second; the second finishes.
        const next = body.menu === 'menu-color' && !body.text ? FRUITS : null;
        find(pane).question = next;
        return r.fulfill({ json: { question: next } });
      }
      state[action === 'keys' ? 'keys' : 'sent'].push({ pane, ...body });
      return r.fulfill({ json: { type: 'ok' } });
    });
  await page.goto('/native/');
  await page.getByText('muster', { exact: true }).first().click();
  const app = page.locator('#remote-muster-app');
  await expect(app).toBeVisible();
  return { app, state };
}

test('the board puts questions first and groups each project’s tabs', async ({ page }) => {
  const { app } = await setup(page);
  const cards = app.locator('.muster-project');
  await expect(cards).toHaveCount(2);
  // The backend orders projects; hidden ones stay off the board.
  await expect(cards.locator('.muster-project-name')).toHaveText(['NYCBevy', 'PaperDiorama']);
  await expect(app.locator('.muster-summary')).toHaveText('1 need you · 1 ready · 1 working');
  const paper = cards.nth(1);
  await expect(paper.locator('.muster-row')).toHaveCount(2);
  await expect(paper.locator('.muster-row-question')).toHaveText('Which color do you prefer?');
  await expect(paper.locator('.muster-row-tab')).toHaveText(['1 · claude', '2 · claude']);
  await expect(cards.nth(0).locator('.muster-row-meta')).toHaveText('waiting on 1 background task');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/browser/muster-board.png' });
});

test('projects hide from the board and come back', async ({ page }) => {
  const { app, state } = await setup(page);
  await app.getByRole('button', { name: 'Hide NYCBevy' }).click();
  await expect(app.locator('.muster-project')).toHaveCount(1);
  expect(state.hides).toEqual([{ workspace_id: 'wA', hidden: true }]);
  const toggle = app.locator('.muster-hidden-toggle');
  await expect(toggle).toHaveText('Show hidden projects · 2');
  await toggle.click();
  const hidden = app.locator('.muster-hidden-row');
  await expect(hidden.locator('.muster-project-name')).toHaveText(['NYCBevy', 'OldThing']);
  await hidden.filter({ hasText: 'OldThing' }).getByRole('button', { name: 'Show' }).click();
  await expect(app.locator('.muster-project')).toHaveCount(2);
  expect(state.hides.at(-1)).toEqual({ workspace_id: 'wC', hidden: false });
  // A question in a hidden project still reaches the top of the board.
  await app.getByRole('button', { name: 'Hide PaperDiorama' }).click();
  await expect(app.locator('.muster-notice')).toContainText(
    'PaperDiorama is hidden and has a question.'
  );
});

test('a question is answered from Muster, one step at a time', async ({ page }) => {
  const { app, state } = await setup(page);
  await app.locator('.muster-row[data-pane="wB:p1"]').click();
  await expect(app.locator('.muster-thread-title')).toContainText('PaperDiorama');
  // The project's other tab is a tap away.
  await expect(app.locator('.muster-tab')).toHaveCount(2);
  const card = app.getByLabel('Question');
  await expect(card.locator('.muster-question-text')).toHaveText('Which color do you prefer?');
  await expect(card.locator('.muster-steps span')).toHaveText(['Color', 'Fruits', 'Submit']);
  await page.screenshot({ path: 'artifacts/browser/muster-question.png' });
  await card.getByRole('button', { name: /Green/ }).click();
  await expect
    .poll(() => state.answers)
    .toEqual([{ pane: 'wB:p1', menu: 'menu-color', choose: [2] }]);
  // The next question is multi-select: picks toggle here, and Continue sends them together.
  await expect(card.locator('.muster-question-text')).toHaveText('Which fruits do you like?');
  await expect(card.getByRole('checkbox')).toHaveCount(3);
  await expect(card.getByRole('checkbox', { name: /Apple/ })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await card.getByRole('checkbox', { name: /Plum/ }).click();
  await card.getByRole('checkbox', { name: /Apple/ }).click();
  await card.getByRole('button', { name: 'Continue' }).click();
  await expect
    .poll(() => state.answers.at(-1))
    .toEqual({ pane: 'wB:p1', menu: 'menu-fruits', choose: [3] });
  await expect(card).toBeHidden();
  expect(state.sent).toEqual([]);
});

test('a typed answer goes to the question’s own text choice', async ({ page }) => {
  const { app, state } = await setup(page);
  await app.locator('.muster-row[data-pane="wB:p1"]').click();
  await expect(app.getByLabel('Question')).toBeVisible();
  await app.locator('.muster-prompt').click();
  const field = app.locator('textarea.native-input');
  await expect(field).toHaveAttribute('placeholder', 'Type your own answer…');
  await field.fill('Teal, please');
  await field.press('Enter');
  await expect
    .poll(() => state.answers)
    .toEqual([{ pane: 'wB:p1', menu: 'menu-color', text: 'Teal, please' }]);
  expect(state.sent).toEqual([]);
});

test('a message goes to a thread that is not waiting, and its prose shows', async ({ page }) => {
  const { app, state } = await setup(page);
  state.details['wB:p2'] = { answer: { text: 'Done. The **README** is tidy.' } };
  await app.locator('.muster-row[data-pane="wB:p2"]').click();
  await expect(app.locator('.muster-said strong')).toHaveText('README');
  await expect(app.locator('.muster-asked')).toContainText('Tidy the README');
  await app.locator('.muster-prompt').click();
  const field = app.locator('textarea.native-input');
  await field.fill('Also update the changelog');
  await field.press('Enter');
  await expect
    .poll(() => state.sent)
    .toEqual([{ pane: 'wB:p2', text: 'Also update the changelog' }]);
  // The message shows at once; the old answer folds away as the previous reply.
  await expect(app.locator('.muster-asked p')).toHaveText('Also update the changelog');
  const previous = app.locator('.muster-previous');
  await expect(previous.locator('summary')).toHaveText('Previous reply');
  await expect(previous).not.toHaveAttribute('open');
  await expect(app.locator('.muster-body > .muster-said')).toHaveCount(0);
  await expect(app.locator('.muster-working')).toHaveText('Working on your message…');
  await page.screenshot({ path: 'artifacts/browser/muster-sent.png' });
  // The log catches up, then the agent's reply arrives.
  state.details['wB:p2'] = {
    prompt: 'Also update the changelog',
    answered: false,
    working: true,
    paragraphs: [{ text: 'Updating the changelog now.' }],
  };
  await expect(app.locator('.muster-body > .muster-said')).toHaveText(
    'Updating the changelog now.'
  );
  await expect(app.locator('.muster-working')).toHaveCount(0);
  await expect(previous).toContainText('README');
  // The board shows the message until there is a reply, not the old answer.
  state.projects[1].threads[1] = {
    ...state.projects[1].threads[1],
    prompt: 'Also update the changelog',
    answered: false,
    latest: '',
  };
  await app.getByRole('button', { name: 'Muster' }).click();
  await expect(app.locator('.muster-row[data-pane="wB:p2"] .muster-row-latest')).toHaveText(
    'You: Also update the changelog'
  );
  await app.locator('.muster-row[data-pane="wB:p2"]').click();
  // Switching tabs within the project.
  await app.locator('.muster-tab').first().click();
  await expect(app.getByLabel('Question')).toBeVisible();
  // Open in Herdr hands the pane to Herdr.
  await app.getByRole('button', { name: 'Open in Herdr' }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('omarchy-herdr-pane')))
    .toContain('wB:p1');
});

test('a wait Muster cannot read shows the screen with keys to answer it', async ({ page }) => {
  const { app, state } = await setup(page);
  const blocked = state.projects[1].threads[0];
  blocked.question = null;
  state.details['wB:p1'] = {
    screen: ' ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel',
  };
  await app.locator('.muster-row[data-pane="wB:p1"]').click();
  const card = app.getByLabel('Screen');
  await expect(card.locator('pre')).toContainText('Yes, I trust this folder');
  await card.getByRole('button', { name: '↓' }).click();
  await card.getByRole('button', { name: 'Enter' }).click();
  await expect.poll(() => state.keys.map(k => k.keys[0])).toEqual(['Down', 'Enter']);
  // Typing is held back while the agent waits on something only keys can answer.
  await app.locator('.muster-prompt').click();
  const field = app.locator('textarea.native-input');
  await field.fill('hello');
  await field.press('Enter');
  await expect(app.locator('.muster-thread-status')).toHaveText('Answer the question above first.');
  expect(state.sent).toEqual([]);
});

test('what came before your last message is summarized only when you open it', async ({ page }) => {
  const { app, state } = await setup(page);
  state.projects[1].threads[1].earlier = 3;
  const asked = [];
  let finish;
  await page.route(/\/api\/muster\/panes\/[^/]+\/summary$/, async r => {
    asked.push(decodeURIComponent(r.request().url().split('/').at(-2)));
    await new Promise(resolve => (finish = resolve));
    return r.fulfill({ json: { summary: 'You asked for a **docs pass**; the agent tidied it.' } });
  });
  await app.locator('.muster-row[data-pane="wB:p2"]').click();
  const earlier = app.locator('.muster-earlier');
  await expect(earlier.locator('summary')).toHaveText('Earlier in this thread · 3 messages');
  await expect(earlier).not.toHaveAttribute('open');
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  await earlier.locator('summary').click();
  await expect(earlier.locator('.muster-summarizing')).toHaveText('Summarizing…');
  await expect.poll(() => asked.length).toBe(1);
  finish();
  await expect(earlier.locator('.muster-recap strong')).toHaveText('docs pass');
  // The thread refreshes every two seconds; the summary stays open and is not asked for again.
  await page.waitForTimeout(2500);
  await expect(earlier).toHaveAttribute('open');
  await expect(earlier.locator('.muster-recap')).toContainText('the agent tidied it');
  await earlier.locator('summary').click();
  await earlier.locator('summary').click();
  await expect(earlier.locator('.muster-recap')).toContainText('the agent tidied it');
  expect(asked).toEqual(['wB:p2']);
  // A thread with nothing before its last message has no summary to open.
  await app.locator('.muster-tab').first().click();
  await expect(app.getByLabel('Question')).toBeVisible();
  await expect(app.locator('.muster-earlier')).toHaveCount(0);
});
