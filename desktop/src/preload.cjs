/* Gives the Omarchy Remote shell the same bridges as the iOS and Android apps:
   window.webkit.messageHandlers.<channel>.postMessage(body) resolves with the reply. */
const { contextBridge, ipcRenderer } = require('electron');

if (window.top === window) {
  // Main returns null unless this frame is the selected host or the bundled host picker.
  const device = ipcRenderer.sendSync('omarchy:device');
  if (device)
    contextBridge.executeInMainWorld({
      func: (device, send) => {
        const request = async (channel, body) => {
          const value = await send(channel, body);
          if (value && typeof value === 'object' && typeof value.error === 'string')
            throw new Error(value.error);
          return value;
        };
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
