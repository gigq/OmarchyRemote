import { test, expect } from './fixtures.mjs';
import { captureTerminals, visibleText, exitShell } from './terminal-helper.mjs';

test('taps and scrolling reach a TUI that tracks the mouse and stay local otherwise', async ({
  page,
}) => {
  await captureTerminals(page);
  // Echoed reports wrap at the terminal width; compare them unwrapped.
  const echoed = async () => (await visibleText(page)).replace(/\n/g, '');
  const count = (text, pattern) => text.match(pattern)?.length || 0;
  await page.goto('/native/');
  await page.getByText('terminal', { exact: true }).first().click();
  await expect(page.locator('#remote-terminal-app')).toContainText('· connected');
  // cat keeps the line discipline echoing whatever the terminal reports.
  await page.evaluate(() => qaTerms[0].input("printf '\\e[?1000h\\e[?1006h'; cat -v\r"));
  await expect.poll(() => page.evaluate(() => qaTerms[0].modes.mouseTrackingMode)).toBe('vt200');
  const scroller = page.locator('.remote-terminal .native-terminal-scroll');
  // The first column sits under the left swipe guard, which passes taps through.
  const edge = page.locator('.remote-terminal .native-scroll-edge.left');
  await edge.click({ position: { x: 3, y: 3 } });
  await expect.poll(() => visibleText(page)).toMatch(/\^\[\[<0;1;1M\^\[\[<0;1;1m/);
  const cell = await page.evaluate(() => {
    const view = qaTerms[0].nativeView;
    return { width: view.width, height: view.height };
  });
  await scroller.click({ position: { x: cell.width * 4.5, y: cell.height * 2.5 } });
  await expect.poll(() => visibleText(page)).toMatch(/\^\[\[<0;5;3M\^\[\[<0;5;3m/);
  // Wheel and swipe movement become wheel ticks at the cell under the pointer.
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + cell.width * 4.5, box.y + cell.height * 2.5);
  await page.mouse.wheel(0, cell.height * 2);
  await expect.poll(async () => count(await echoed(), /\^\[\[<65;5;3M/g)).toBe(2);
  await page.mouse.wheel(0, -cell.height);
  await expect.poll(async () => count(await echoed(), /\^\[\[<64;5;3M/g)).toBe(1);
  const cdp = await page.context().newCDPSession(page);
  const finger = { x: box.x + cell.width * 4.5, y: box.y + cell.height * 6.5 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: finger.x, y: finger.y - cell.height * i }],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // Each row of finger travel is one tick, reported at the cell under the finger.
  await expect.poll(async () => count(await echoed(), /\^\[\[<65;5;[3-6]M/g)).toBe(2 + 4);
  await expect(scroller).toHaveClass(/mouse-tracking/);
  await page.evaluate(() => qaTerms[0].input('\x03'));
  await page.evaluate(() => qaTerms[0].input("printf '\\e[?1000l'; cat -v\r"));
  await expect.poll(() => page.evaluate(() => qaTerms[0].modes.mouseTrackingMode)).toBe('none');
  await expect(scroller).not.toHaveClass(/mouse-tracking/);
  await edge.click({ position: { x: 3, y: 3 } });
  await scroller.click({ position: { x: cell.width * 4.5, y: cell.height * 2.5 } });
  await page.mouse.wheel(0, cell.height * 2);
  await page.waitForTimeout(300);
  const text = await echoed();
  expect(count(text, /\^\[\[<0;\d+;\d+M/g)).toBe(2);
  expect(count(text, /\^\[\[<65;\d+;\d+M/g)).toBe(6);
  await page.evaluate(() => qaTerms[0].input('\x03'));
  await exitShell(page);
});
