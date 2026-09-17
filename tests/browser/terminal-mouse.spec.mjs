import { test, expect } from './fixtures.mjs';
import { captureTerminals, visibleText, exitShell } from './terminal-helper.mjs';

test('taps reach a TUI that tracks the mouse and stay local otherwise', async ({ page }) => {
  await captureTerminals(page);
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
  await page.evaluate(() => qaTerms[0].input('\x03'));
  await page.evaluate(() => qaTerms[0].input("printf '\\e[?1000l'; cat -v\r"));
  await expect.poll(() => page.evaluate(() => qaTerms[0].modes.mouseTrackingMode)).toBe('none');
  await edge.click({ position: { x: 3, y: 3 } });
  await scroller.click({ position: { x: cell.width * 4.5, y: cell.height * 2.5 } });
  await page.waitForTimeout(300);
  expect((await visibleText(page)).match(/\^\[\[<0;\d+;\d+M/g)).toHaveLength(2);
  await page.evaluate(() => qaTerms[0].input('\x03'));
  await exitShell(page);
});
