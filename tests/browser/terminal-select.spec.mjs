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
      '$ ';
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
  });
}
