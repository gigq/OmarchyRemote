/* Device-local appearance shared by independently packaged desktop apps, scoped to a host. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const appearanceKeys = ['omarchy-theme', 'omarchy-wallpapers'];
const clean = values =>
  Object.fromEntries(
    appearanceKeys.filter(key => typeof values?.[key] === 'string').map(key => [key, values[key]])
  );

export class Appearance {
  constructor(folder, changed = () => {}) {
    this.folder = folder;
    this.changed = changed;
    this.watches = new Map();
  }
  file(scope) {
    return path.join(this.folder, createHash('sha256').update(scope).digest('hex') + '.json');
  }
  read(file) {
    try {
      return clean(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return {};
    }
  }
  get(scope) {
    if (!scope) return {};
    const file = this.file(scope);
    if (!this.watches.has(file)) {
      let previous = JSON.stringify(this.read(file));
      const listener = () => {
        const values = this.read(file);
        const next = JSON.stringify(values);
        if (next === previous) return;
        previous = next;
        this.changed(scope, values);
      };
      // Poll from our synchronous baseline: fs.watchFile can miss a file created
      // before its first asynchronous stat, especially when apps start together.
      const timer = setInterval(listener, 100);
      timer.unref();
      this.watches.set(file, timer);
    }
    return this.read(file);
  }
  set(scope, key, value) {
    if (
      !scope ||
      !appearanceKeys.includes(key) ||
      typeof value !== 'string' ||
      value.length > 65536
    )
      throw new Error('Unsupported appearance setting');
    const values = this.get(scope);
    if (values[key] === value) return values;
    values[key] = value;
    fs.mkdirSync(this.folder, { recursive: true });
    const file = this.file(scope);
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 });
    fs.renameSync(temporary, file);
    this.changed(scope, values);
    return values;
  }
  close() {
    for (const timer of this.watches.values()) clearInterval(timer);
    this.watches.clear();
  }
}
