import { test, expect } from './fixtures.mjs';

// Text in a terminal can be selected with the mouse from anywhere on a line, including its
// first characters, which sit where touch devices keep their edge-swipe guards.
for (const [width, height, layout] of [
  [1194, 834, 'desk'],
  [402, 874, 'phone'],
]) {
  test(`a mouse drag selects terminal text from the start of a line (${layout})`, async ({
    page: p,
  }) => {
    await p.setViewportSize({ width, height });
    await p.route('**/api/**', r =>
      r.fulfill({ json: r.request().url().endsWith('/session') ? { id: 'qa-1' } : { ok: true } })
    );
    const text =
      Array.from({ length: 6 }, (_, i) => `line ${i} with some words to select\r\n`).join('') +
      '$ ' +
      'typed words '.repeat(5);
    await p.routeWebSocket('**/api/terminal/*/ws', ws => {
      ws.send(JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: [...Buffer.from(text)] }));
    });
    await p.goto('/native/');
    if (layout === 'desk') {
      await p.evaluate(() => {
        window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
        dispatchEvent(new Event('hyprland-hardware-keyboard'));
      });
      await p.keyboard.press('Meta+Enter');
    } else await p.getByText('terminal', { exact: true }).first().click();
    const row = p.locator('#remote-terminal-app .native-terminal-row').filter({
      hasText: 'line 2 with',
    });
    await expect(row).toHaveCount(1);
    // Let the window finish opening so the text stays under the pointer.
    let box = null;
    await expect
      .poll(async () => {
        const previous = box;
        box = await row.boundingBox();
        return !!previous && previous.x === box.x && previous.y === box.y;
      })
      .toBe(true);
    console.log(
      'fine pointer',
      await p.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)
    );
    const drag = async (from, to) => {
      await p.evaluate(() => getSelection().removeAllRanges());
      await p.mouse.move(box.x + from, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + to, box.y + box.height / 2, { steps: 8 });
      await p.mouse.up();
      return p.evaluate(() => getSelection().toString());
    };
    expect(await drag(2, 100)).toMatch(/^line 2 with/);
    // The window did not move: the drag was a selection, not a workspace swipe.
    expect((await row.boundingBox()).x).toBe(box.x);
    expect(await drag(60, 200)).toMatch(/^ith some words/);
    // Past the end of the text the selection stops there, not in the terminal's blank columns.
    const view = await p.locator('#remote-terminal-app .native-terminal-scroll').boundingBox();
    expect(await drag(2, view.x + view.width - 40 - box.x)).toBe(
      'line 2 with some words to select'
    );
    // Several lines copy as lines, without trailing spaces.
    await p.evaluate(() => getSelection().removeAllRanges());
    await p.mouse.move(box.x + 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + 30, box.y + box.height * 2.5, { steps: 8 });
    await p.mouse.up();
    const copied = await p.evaluate(() => {
      const data = new DataTransfer();
      const anchor = getSelection().anchorNode.parentElement;
      anchor.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
      );
      return data.getData('text/plain');
    });
    expect(copied).toBe('line 2 with some words to select\nline 3 with some words to select\nline');
    // The cursor sits right after the typed text, however long the line, at either text size.
    const gap = await p.evaluate(() => {
      const row = [...document.querySelectorAll('#remote-terminal-app .native-terminal-row')].find(
        r => r.textContent.includes('typed words')
      );
      const cursor = [...row.querySelectorAll('span')].find(s => s.style.boxShadow);
      const text = document.createRange();
      text.selectNodeContents(row.querySelector('span'));
      return cursor.getBoundingClientRect().left - text.getBoundingClientRect().right;
    });
    expect(Math.abs(gap)).toBeLessThan(2);
  });
}

// iOS spends a long press with the keyboard up on ending the input's editing session, and can
// blur the input only after the finger lifts. The keyboard must stay down then, so the next long
// press selects, instead of popping back up.
test('on a phone a long press puts the keyboard away so text can be selected', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r =>
    r.fulfill({ json: r.request().url().endsWith('/session') ? { id: 'qa-1' } : { ok: true } })
  );
  const text = Array.from({ length: 6 }, (_, i) => `line ${i} with some words\r\n`).join('') + '$ ';
  await p.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(JSON.stringify({ type: 'screen', cols: 50, rows: 24, data: [...Buffer.from(text)] }));
  });
  await p.goto('/native/');
  await p.getByText('terminal', { exact: true }).first().click();
  const app = p.locator('#remote-terminal-app');
  const row = app.locator('.native-terminal-row').filter({ hasText: 'line 2 with' });
  await expect(row).toHaveCount(1);
  const input = app.locator('textarea.native-input');
  await app.locator('.native-terminal-scroll').click();
  await expect(input).toBeFocused();
  const touch = (type, target = row) =>
    target.evaluate((el, type) => {
      const t = new Touch({ identifier: 1, target: el, clientX: 60, clientY: 8 });
      el.dispatchEvent(
        new TouchEvent(type, {
          touches: type === 'touchstart' ? [t] : [],
          changedTouches: [t],
          bubbles: true,
        })
      );
    }, type);
  // The first long press only ends the editing session, after the finger lifts.
  await touch('touchstart');
  await p.waitForTimeout(600);
  await touch('touchend');
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForTimeout(400);
  await expect(input).not.toBeFocused();
  // The next long press selects, and the keyboard stays away while it does.
  await touch('touchstart');
  await p.waitForTimeout(600);
  await row.evaluate(el => getSelection().selectAllChildren(el));
  await touch('touchend');
  await p.waitForTimeout(400);
  expect(await p.evaluate(() => getSelection().toString())).toContain('line 2 with some words');
  await expect(input).not.toBeFocused();
  // A tap brings the keyboard back.
  await p.evaluate(() => getSelection().removeAllRanges());
  await touch('touchstart');
  await touch('touchend');
  await row.click();
  await expect(input).toBeFocused();
});
