/* Gives the Omarchy Remote shell the same bridges as the iOS and Android apps:
   window.webkit.messageHandlers.<channel>.postMessage(body) resolves with the reply. */
const { contextBridge, ipcRenderer } = require('electron');

if (window.top === window) {
  // Main returns null unless this frame is the selected host or the bundled host picker.
  const device = ipcRenderer.sendSync('omarchy:device');
  if (device) {
    ipcRenderer.on('omarchy:appearance', (event, update) => {
      if (update.scope !== device.scope) return;
      contextBridge.executeInMainWorld({
        func: values => {
          for (const [key, value] of Object.entries(values)) {
            const oldValue = localStorage.getItem(key);
            if (oldValue === value) continue;
            localStorage.setItem(key, value);
            window.dispatchEvent(
              new StorageEvent('storage', {
                key,
                oldValue,
                newValue: value,
                storageArea: localStorage,
              })
            );
          }
        },
        args: [update.values],
      });
    });
    contextBridge.executeInMainWorld({
      func: (device, send) => {
        const request = async (channel, body) => {
          const value = await send(channel, body);
          if (value && typeof value === 'object' && typeof value.error === 'string')
            throw new Error(value.error);
          return value;
        };
        // Appearance is shared across app bundles; other local state stays private to each app.
        for (const [key, value] of Object.entries(device.appearance || {}))
          try {
            localStorage.setItem(key, value);
          } catch {}
        window.addEventListener('hyprland-storage', event => {
          const { key, value } = event.detail || {};
          if (['omarchy-theme', 'omarchy-wallpapers'].includes(key) && typeof value === 'string')
            request('shellAppearance', { key, value }).catch(() => {});
        });
        window.__OMARCHY_DEVICE__ = device;
        window.__OMARCHY_PLATFORM__ = 'desktop';
        window.__HYPRLAND_NATIVE__ = true;
        const handlers = {};
        for (const channel of [
          'shellHosts',
          'shellStorage',
          'shellKeyboard',
          'weatherDevice',
          'browserDevice',
          'shellWindows',
          'shellFolders',
        ])
          handlers[channel] = Object.freeze({ postMessage: body => request(channel, body) });
        window.webkit = Object.freeze({ messageHandlers: Object.freeze(handlers) });
        // Files and Builds save through navigator.share in the native apps; here it is a save dialog.
        const canSave = data => data?.files?.length === 1 && data.files[0] instanceof File;
        Object.defineProperty(navigator, 'canShare', { value: canSave, configurable: true });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async data => {
            if (!canSave(data)) throw new TypeError('Choose one file to save.');
            const file = data.files[0];
            const result = await request('shellFiles', {
              name: file.name,
              bytes: await file.arrayBuffer(),
            });
            if (result?.cancelled) throw new DOMException('Save cancelled', 'AbortError');
          },
        });
        document.addEventListener('DOMContentLoaded', () =>
          document.documentElement.classList.add('native-shell', 'desktop-shell')
        );
      },
      args: [device, (channel, body) => ipcRenderer.invoke('omarchy:bridge', channel, body)],
    });
  }
}
