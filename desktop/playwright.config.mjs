import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: '*.spec.mjs',
  workers: 1,
  timeout: 60000,
  reporter: 'list',
  outputDir: '../artifacts/desktop',
});
