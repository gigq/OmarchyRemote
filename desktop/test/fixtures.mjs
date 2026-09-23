import { _electron, test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = process.env.REMOTE_TEST_URL || 'http://127.0.0.1:4187';

/* Launches the client with a throwaway profile. Linux needs a display: Xvfb, or a Wayland
   session when WAYLAND_DISPLAY is set. */
export async function launch(profile, env = {}, extra = []) {
  const app = await _electron.launch({
    // OMARCHY_DESKTOP_EXECUTABLE tests a packaged build; otherwise run the sources in Electron.
    executablePath:
      process.env.OMARCHY_DESKTOP_EXECUTABLE || createRequire(import.meta.url)('electron'),
    args: [
      ...(process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
      ...(process.env.OMARCHY_DESKTOP_EXECUTABLE ? [] : [desktop]),
      ...extra,
    ],
    env: { ...process.env, OMARCHY_USER_DATA: profile, ...env },
  });
  const window = await app.firstWindow();
  return { app, window };
}

export const test = base.extend({
  profile: async ({}, use) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-desktop-'));
    await use(folder);
    fs.rmSync(folder, { recursive: true, force: true });
  },
  // A local website for embedded pages; it never touches a real host's content.
  website: async ({}, use) => {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<!doctype html><title>QA page ${request.url}</title><body style="margin:0">` +
          `<input id="field"><p>needle haystack needle</p><a href="/next" target="_blank">next</a></body>`
      );
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${server.address().port}`);
    server.close();
  },
});
export { expect };
