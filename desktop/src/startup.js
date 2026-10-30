/* Window requests can arrive before Electron has finished creating the desktop client. */
export function windowRequests() {
  let open;
  const pending = new Set();
  return {
    request(key) {
      if (open) open(key);
      else pending.add(key);
    },
    ready(callback) {
      open = callback;
      for (const key of pending) open(key);
      pending.clear();
    },
  };
}
