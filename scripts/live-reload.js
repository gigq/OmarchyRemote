(() => {
  const loadedVersion = window.__HYPRLAND_VERSION__;
  let reloading = false;
  const events = new EventSource('/__dev/events');
  events.addEventListener('version', event => {
    if (event.data !== loadedVersion && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  // iOS suspends networking in the background; compare again after returning.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const response = await fetch('/__dev/status', { cache: 'no-store' });
      if (!response.ok) return;
      const state = await response.json();
      if (state.version !== loadedVersion && !reloading) {
        reloading = true;
        location.reload();
      }
    } catch {
      /* EventSource reconnects when the server or tailnet returns. */
    }
  });
})();
