import { test, expect } from './fixtures.mjs';

test('build downloads page fits phone and tablet and serves the install manifest', async ({
  page,
  request,
}) => {
  const catalog = await request.get('/builds/catalog.json');
  test.skip(catalog.status() === 404, 'No native builds have been published on this host');
  expect(catalog.ok()).toBeTruthy();
  const builds = await catalog.json();
  test.skip(!builds.length, 'No native builds have been published on this host');
  const hasIOS = builds.some(build => (build.platform || 'ios') === 'ios');
  for (const viewport of [
    { width: 402, height: 874 },
    { width: 1194, height: 834 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/builds/');
    await expect(page.getByRole('heading', { name: 'Your next update.' })).toBeVisible();
    if (hasIOS) {
      const install = page.getByRole('link', { name: 'Install on device' }).first();
      await expect(install).toBeVisible();
      const link = new URL(await install.getAttribute('href'));
      expect(link.protocol).toBe('itms-services:');
      const manifestURL = new URL(link.searchParams.get('url'));
      expect(manifestURL.protocol).toBe('https:');
      const manifest = await request.get(manifestURL.pathname);
      expect(manifest.ok()).toBeTruthy();
      expect(await manifest.text()).toContain('software-package');
    } else {
      await expect(page.getByRole('link', { name: /Download APK/ }).first()).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({
      path: `artifacts/browser/builds-${viewport.width}.png`,
      fullPage: true,
    });
  }
  const download = page
    .getByRole('link', { name: hasIOS ? /Download IPA/ : /Download APK/ })
    .first();
  const response = await request.head('/builds/' + (await download.getAttribute('href')));
  expect(response.ok()).toBeTruthy();
  expect(Number(response.headers()['content-length'])).toBeGreaterThan(0);
  for (const route of ['/builds/.publish.lock', '/builds/..%2fREADME.md', '/builds/unknown.ipa']) {
    expect((await request.get(route)).status()).toBe(404);
  }
});
