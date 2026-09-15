import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Poll paths instead of keeping inode-bound watches, which can miss editor replacements.
export function watchSources(roots, changed, { interval = 750, onError = console.error } = {}) {
  function snapshot() {
    const entries = [];
    function visit(file) {
      let info;
      try {
        info = statSync(file, { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (info.isDirectory()) {
        for (const name of readdirSync(file).sort()) visit(path.join(file, name));
      } else if (info.isFile()) {
        entries.push([
          file,
          String(info.ino),
          String(info.size),
          String(info.mtimeNs),
          String(info.ctimeNs),
        ]);
      }
    }
    for (const root of roots) visit(root);
    return JSON.stringify(entries);
  }
  let previous = snapshot();
  const timer = setInterval(() => {
    try {
      const next = snapshot();
      if (next === previous) return;
      changed();
      previous = next;
    } catch (error) {
      onError(error);
    }
  }, interval);
  return { close: () => clearInterval(timer) };
}
