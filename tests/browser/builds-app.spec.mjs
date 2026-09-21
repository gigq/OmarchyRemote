import { test, expect } from './fixtures.mjs';

for (const viewport of [
  { width: 402, height: 874 },
  { width: 1194, height: 834 },
]) {
  test(`Builds launches with setup and changes to published builds at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    let catalog = [];
    await page.route('**/builds/catalog.json', route => route.fulfill({ json: catalog }));
    await page.goto('/');
    await page.keyboard.press('Meta+k');
    await page.getByRole('searchbox', { name: 'Search apps, panes and files' }).fill('Builds');
    await page.getByRole('button', { name: /Builds.*build dashboard/ }).click();
    const app = page.locator('#remote-builds-app');
    await expect(app.getByRole('heading', { name: 'A home for your builds.' })).toBeVisible();
    await expect(app.getByRole('link', { name: 'Get the agent skill' })).toHaveAttribute(
      'href',
      '/builds/SKILL.md'
    );
    expect(await app.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect
      .poll(() => app.evaluate(el => Math.abs(el.getBoundingClientRect().left)))
      .toBeLessThan(50);
    await page.screenshot({ path: `artifacts/browser/builds-app-setup-${viewport.width}.png` });
    catalog = [
      {
        id: 'a'.repeat(64),
        sha256: 'a'.repeat(64),
        build: '42',
        version: '1.0',
        notes: 'A new update',
        published: '2026-09-21',
        expires: '2027-08-17',
        commit: 'abc123',
        bytes: 1024,
      },
    ];
    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(app.getByRole('heading', { name: 'Build 42' })).toBeVisible();
    await expect(app.getByText('A new update')).toBeVisible();
    await expect(app.getByRole('heading', { name: 'A home for your builds.' })).toHaveCount(0);
    await expect(app.getByRole('button', { name: 'Copy dashboard link' })).toBeVisible();
    await page.screenshot({ path: `artifacts/browser/builds-app-published-${viewport.width}.png` });
  });
}

test('native Install sends only the build identity and reports handoff or failure accurately', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  const id = 'b'.repeat(64);
  await page.addInitScript(() => {
    window.installRequests = [];
    window.acceptInstall = true;
    window.webkit = {
      messageHandlers: {
        shellInstallBuild: {
          postMessage: async message => {
            window.installRequests.push(message);
            return { opened: window.acceptInstall };
          },
        },
      },
    };
  });
  await page.route('**/builds/catalog.json', route =>
    route.fulfill({
      json: [{ id, build: '37', version: '0.2.0', notes: 'Native installation', bytes: 100 }],
    })
  );
  await page.goto('/');
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search apps, panes and files' }).fill('Builds');
  await page.getByRole('button', { name: /Builds.*build dashboard/ }).click();
  const app = page.locator('#remote-builds-app');
  const install = app.getByRole('button', { name: 'Install build 37' });
  await expect(install).toBeVisible();
  expect(await page.evaluate(() => window.installRequests)).toEqual([]);
  await install.click();
  expect(await page.evaluate(() => window.installRequests)).toEqual([{ build: id }]);
  await expect(app.getByRole('status')).toContainText('Install request sent to iOS');
  await expect(install).toBeEnabled();
  await page.evaluate(() => (window.acceptInstall = false));
  await install.click();
  await expect(app.getByRole('status')).toContainText('could not open the installer');
  await expect(install).toBeEnabled();
});

test('Android shows only APK builds and explains installation permission', async ({ page }) => {
  await page.addInitScript(() => {
    window.__OMARCHY_PLATFORM__ = 'android';
    window.installRequests = [];
    window.installReply = { permissionRequired: true };
    window.webkit = {
      messageHandlers: {
        shellInstallBuild: {
          postMessage: async message => {
            window.installRequests.push(message);
            return window.installReply;
          },
        },
      },
    };
  });
  await page.route('**/builds/catalog.json', route =>
    route.fulfill({
      json: [
        { id: 'a'.repeat(64), build: '99', version: '1', notes: 'iOS only' },
        {
          id: 'b'.repeat(64),
          build: '2',
          version: '1',
          platform: 'android',
          min_sdk: 30,
          notes: 'Android update',
        },
      ],
    })
  );
  await page.goto('/');
  await page.keyboard.press('Meta+k');
  await page.getByRole('searchbox', { name: 'Search apps, panes and files' }).fill('Builds');
  await page.getByRole('button', { name: /Builds.*build dashboard/ }).click();
  const app = page.locator('#remote-builds-app');
  await expect(app.getByText('iOS only')).toHaveCount(0);
  await expect(app.getByText('Android update')).toBeVisible();
  await app.getByRole('button', { name: 'Install build 2' }).click();
  await expect(app.getByRole('status')).toContainText('Allow updates from this app');
  await page.evaluate(() => (window.installReply = { opened: true }));
  await app.getByRole('button', { name: 'Install build 2' }).click();
  await expect(app.getByRole('status')).toContainText('Install request sent to Android');
  expect(await page.evaluate(() => window.installRequests)).toEqual([
    { build: 'b'.repeat(64) },
    { build: 'b'.repeat(64) },
  ]);
});
