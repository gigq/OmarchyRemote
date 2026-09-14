// Formats the shell component inside public/index.html.
//
// The template is a design-tool export whose markup we leave alone, but the
// `<script type="text/x-dc">` block inside it is ordinary JavaScript that the
// x-dc runtime evaluates. Prettier skips the file (see .prettierignore), so
// this script formats that one block with the repository's Prettier settings.
//
//   node scripts/format-template.mjs          # rewrite in place
//   node scripts/format-template.mjs --check  # exit 1 if it would change
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import prettier from 'prettier';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html');
const check = process.argv.includes('--check');
const html = await readFile(file, 'utf8');
const open = html.indexOf('<script type="text/x-dc"');
const start = html.indexOf('>', open) + 1;
const end = html.indexOf('</script>', start);
if (open < 0 || end < 0) throw new Error('public/index.html: x-dc script block not found');

const source = html.slice(start, end);
const options = { ...(await prettier.resolveConfig(file)), parser: 'babel' };
const formatted = '\n' + (await prettier.format(source, options));
if (formatted === source) process.exit(0);
if (check) {
  console.error('public/index.html: component script is not formatted; run `npm run format`');
  process.exit(1);
}
await writeFile(file, html.slice(0, start) + formatted + html.slice(end));
console.log('public/index.html (component script)');
