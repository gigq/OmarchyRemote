import { test, expect } from './fixtures.mjs';
import { captureTerminals, visibleText } from './terminal-helper.mjs';
test('Services lists host units, searches, opens actions and reconnects', async ({ page: p }) => {
  await captureTerminals(p);
  await p.goto('/native/');
  await p.getByText('services', { exact: true }).first().click();
  const app = p.locator('#remote-services-app');
  await expect(app).toContainText('· connected');
  const id = await p.evaluate(() => localStorage.getItem('omarchy-services-id'));
  expect(id).toBeTruthy();
  await expect.poll(() => visibleText(p)).toContain('.service');
  await p.waitForTimeout(500);
  await p.screenshot({ path: 'artifacts/browser/services.png' });
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await p.evaluate(() => qaTerms[0].input('omarchy-remote-dev'));
  await expect.poll(() => visibleText(p)).toContain('omarchy-remote-dev');
  await app.getByRole('button', { name: 'Back', exact: true }).click();
  await app.getByRole('button', { name: 'Select', exact: true }).click();
  await expect.poll(() => visibleText(p)).toContain('Restart');
  await p.screenshot({ path: 'artifacts/browser/services-actions.png' });
  // Inspect the menu only; never operate existing host services during QA.
  await app.getByRole('button', { name: 'Back', exact: true }).click();
  // Reload restores the open workspace and reconnects the same host session.
  await p.reload();
  await expect(app).toContainText('· connected');
  expect(await p.evaluate(() => localStorage.getItem('omarchy-services-id'))).toBe(id);
  await expect.poll(() => visibleText(p)).toContain('omarchy-remote-dev');
  await p.screenshot({ path: 'artifacts/browser/services-resume.png' });
});
