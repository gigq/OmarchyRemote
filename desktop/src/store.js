/* Device state kept in the app's user-data folder: device id, host directory, per-host
   shell snapshots, and website preferences. Never synced to a host. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clean } from './hosts.js';

const MAX_SNAPSHOT = 1048576;

export class Store {
  constructor(folder) {
    this.file = path.join(folder, 'device.json');
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.data = {
      deviceId: typeof data.deviceId === 'string' ? data.deviceId : randomUUID(),
      directory: clean(data.directory),
      snapshots: data.snapshots && typeof data.snapshots === 'object' ? data.snapshots : {},
      forceDark: data.forceDark === true,
    };
    this.save();
  }
  get directory() {
    return this.data.directory;
  }
  set directory(value) {
    this.data.directory = clean(value);
    // Snapshots belong to saved hosts only.
    const ids = new Set(this.data.directory.hosts.map(h => h.id));
    for (const id of Object.keys(this.data.snapshots))
      if (!ids.has(id)) delete this.data.snapshots[id];
    this.save();
  }
  snapshot(scope) {
    return this.data.snapshots[scope] || {};
  }
  saveSnapshot(scope, values) {
    if (!scope || scope !== this.data.directory.selected) return false;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
    if (JSON.stringify(values).length > MAX_SNAPSHOT) return false;
    this.data.snapshots[scope] = values;
    this.save();
    return true;
  }
  set forceDark(value) {
    this.data.forceDark = !!value;
    this.save();
  }
  get forceDark() {
    return this.data.forceDark;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
