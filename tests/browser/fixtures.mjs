import { test as base, expect } from '@playwright/test';
export { expect };
export const test = base.extend({
  isolatedSettings: [
    async ({ context }, use) => {
      await context.route('**/api/state{,/**}', route => route.abort());
      await use();
    },
    { auto: true },
  ],
  // Close every host terminal session a test opens, even when the test times out,
  // so the backend's session cap is never exhausted by earlier specs.
  terminalSessions: [
    async ({ context, request }, use) => {
      const ids = new Set();
      context.on('response', async response => {
        if (!response.ok() || !/\/api\/terminal\/session(\?|$)/.test(response.url())) return;
        const body = await response.json().catch(() => null);
        if (body?.id) ids.add(body.id);
      });
      await use();
      for (const id of ids)
        await request
          .post(`/api/terminal/${encodeURIComponent(id)}/close`, {
            headers: { 'X-Hyprland-Client': '1' },
            data: {},
          })
          .catch(() => {});
    },
    { auto: true },
  ],
});
