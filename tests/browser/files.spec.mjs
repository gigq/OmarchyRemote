import { test, expect } from './fixtures.mjs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
test('Files browses the host, previews literal text, creates a folder and uploads there', async ({
  page: p,
}) => {
  const folder = await mkdtemp(process.env.HOME + '/omarchy-files-ui-');
  try {
    await writeFile(folder + '/readme.txt', 'Hello from HOST\n<script>window.bad=true</script>');
    await p.addInitScript(path => localStorage.setItem('omarchy-files-path', path), folder);
    await p.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', {
        value: async ({ files }) => {
          window.sharedFile = { name: files[0].name, text: await files[0].text() };
        },
        configurable: true,
      });
    });
    await p.goto('/native/');
    await p.getByText('files', { exact: true }).first().click();
    await expect(p.locator('.files-path')).toHaveAttribute('data-path', folder);
    await p.getByRole('button', { name: /readme.txt/ }).click();
    await expect(p.locator('.files-text')).toContainText('<script>window.bad=true</script>');
    expect(await p.evaluate(() => window.bad)).toBeUndefined();
    await expect(p.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
    await p.getByRole('button', { name: 'Save…', exact: true }).click();
    await expect
      .poll(() => p.evaluate(() => window.sharedFile))
      .toEqual({ name: 'readme.txt', text: 'Hello from HOST\n<script>window.bad=true</script>' });
    await p.getByRole('button', { name: 'Parent folder', exact: true }).click();
    await p.getByRole('button', { name: 'New item', exact: true }).click();
    await p.getByRole('button', { name: 'folder', exact: true }).click();
    await p.getByRole('textbox', { name: 'Folder name' }).fill('From phone');
    await p.getByRole('button', { name: 'Create', exact: true }).click();
    await p.getByRole('button', { name: /From phone/ }).click();
    await expect(p.locator('.files-path')).toHaveAttribute('data-path', folder + '/From phone');
    const chooser = p.waitForEvent('filechooser');
    await p.getByRole('button', { name: 'Upload files', exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: 'upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Uploaded from Files'),
    });
    await expect(p.locator('.files-entry')).toContainText('upload.txt');
    expect(await readFile(folder + '/From phone/upload.txt', 'utf8')).toBe('Uploaded from Files');
    await p.getByRole('button', { name: /upload.txt/ }).click();
    await expect(p.locator('.files-code-source')).toHaveText('Uploaded from Files');
    await p.screenshot({ path: 'artifacts/browser/files-preview.png' });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
