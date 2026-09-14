import { test, expect } from './fixtures.mjs';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
);
test('image picker preserves pane drafts, blocks premature send, and Latest shares the header', async ({
  page,
}) => {
  const sent = [];
  let finishUpload;
  await page.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          workspaces: [{ workspace_id: 'qa', label: 'Upload QA' }],
          tabs: [],
          panes: ['one', 'two'].map(pane_id => ({
            pane_id,
            workspace_id: 'qa',
            terminal_title_stripped: pane_id,
          })),
        },
      })
    );
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'input') sent.push(m);
      if (m.type === 'select' && m.pane_id)
        ws.send(
          JSON.stringify({
            type: 'pane',
            pane_id: m.pane_id,
            read: {
              pane_id: m.pane_id,
              text: Array.from({ length: 100 }, (_, i) => 'Line ' + i).join('\n'),
            },
          })
        );
    });
  });
  await page.route(
    '**/api/uploads/images',
    route =>
      new Promise(resolve => {
        finishUpload = async () => {
          await route.fulfill({ json: { path: '/tmp/upload-test.png' } });
          resolve();
        };
      })
  );
  await page.goto('/native/');
  await page.getByText('herdr', { exact: true }).first().click();
  await page.locator('.herdr-pane').filter({ hasText: 'one' }).click();
  await page.locator('.herdr-output').tap();
  const field = page.locator('#remote-herdr-app .native-input');
  await field.fill('First draft');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach images', exact: true }).click();
  await (await picker).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => !!finishUpload).toBe(true);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'All panes' }).click();
  await page.locator('.herdr-pane').filter({ hasText: 'two' }).click();
  await page.locator('.herdr-output').tap();
  await field.fill('Second draft');
  await finishUpload();
  await expect(page.getByRole('button', { name: 'Attach images', exact: true })).toBeEnabled();
  await expect(field).toHaveValue('Second draft');
  expect(sent).toEqual([]);
  await page.getByRole('button', { name: 'All panes' }).click();
  await page.locator('.herdr-pane').filter({ hasText: 'one' }).click();
  await page.locator('.herdr-output').tap();
  await expect(field).toHaveValue('First draft\nImage: /tmp/upload-test.png\n');
  await expect(page.locator('.herdr-output')).toContainText('Line 99');
  await page.waitForTimeout(250);
  await page.locator('.herdr-output .native-terminal-scroll').evaluate(el => (el.scrollTop = 0));
  const latest = page.getByRole('button', { name: '↓ Latest', exact: true });
  await expect(latest).toBeVisible();
  await expect(page.locator('.native-input-header')).toContainText('Latest');
  const a = await latest.boundingBox(),
    b = await page.getByRole('button', { name: 'Switch typing mode' }).boundingBox();
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  await latest.click();
  await expect(latest).toBeHidden();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(sent).toHaveLength(1);
  expect(sent[0].pane_id).toBe('one');
  expect(sent[0].text).toContain('Image: /tmp/upload-test.png');
});
