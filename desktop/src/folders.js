import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Match the backend's persisted identity, not a hostname or a path that might also
// exist on a remote machine. Read-only: clients never create a host database.
export async function localHostId(home = os.homedir()) {
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path.join(home, '.local/share/omarchy-remote/settings.sqlite3'), {
      readOnly: true,
    });
    return db.prepare("SELECT value FROM meta WHERE key = 'host_id'").get()?.value || null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// A failed identity check or OS opener leaves the caller free to use host Files.
export async function openHostFolder(folder, { selected, fetch, openPath, hostId = localHostId }) {
  const host = selected();
  if (!host || typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0'))
    return false;
  try {
    const local = await hostId();
    if (!local) return false;
    const response = await fetch(new URL('/api/state', host).href, {
      headers: { 'X-Hyprland-Client': '1' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok || (await response.json()).host_id !== local) return false;
    if (!(await fs.stat(folder)).isDirectory() || selected() !== host) return false;
    return (await openPath(folder)) === '';
  } catch {
    return false;
  }
}
