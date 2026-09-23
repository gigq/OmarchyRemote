/* Linux application-launcher entries that open one Omarchy Remote app in its own window. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_KEY = /^[A-Za-z0-9][\w.-]{0,127}$/;

const folder = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'applications');
export const launcherFile = key => path.join(folder(), `omarchy-remote-${key}.desktop`);

// Desktop entry values are single lines; Exec arguments with spaces are quoted.
const line = value =>
  String(value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
const quote = value =>
  /[\s"'\\$`]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value;

export function entry({ key, name, host, command, icon }) {
  if (!APP_KEY.test(key)) throw new Error('Unsupported app');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${line(name).slice(0, 80) || key}`,
    `Comment=${line(`${name} on ${host}, through Omarchy Remote`).slice(0, 200)}`,
    `Exec=${[...command, `--app=${key}`].map(quote).join(' ')}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Network;',
    '',
  ].join('\n');
}

export function install(options) {
  if (process.platform !== 'linux') throw new Error('Launcher entries are available on Linux.');
  const file = launcherFile(options.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entry(options), { mode: 0o644 });
  return file;
}

export function remove(key) {
  if (!APP_KEY.test(key)) throw new Error('Unsupported app');
  fs.rmSync(launcherFile(key), { force: true });
}

export const installed = key => APP_KEY.test(key) && fs.existsSync(launcherFile(key));
