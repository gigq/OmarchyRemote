// Existing UI tests may read host apps, but must never mutate the user's shared settings.
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
});
