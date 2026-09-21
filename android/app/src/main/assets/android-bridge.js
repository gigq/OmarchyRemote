(() => {
  if (window.top !== window) return;
  const pending = new Map();
  let serial = 0;
  AndroidShell.onmessage = event => {
    const reply = JSON.parse(event.data);
    const callback = pending.get(reply.id);
    if (!callback) return;
    pending.delete(reply.id);
    if (reply.error) callback.reject(new Error(reply.error));
    else if (reply.value?.error) callback.reject(new Error(reply.value.error));
    else callback.resolve(reply.value);
  };
  const send = (channel, body) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      AndroidShell.postMessage(JSON.stringify({ id, channel, body }));
    });
  window.webkit = { messageHandlers: {} };
  for (const channel of [
    'shellHosts',
    'shellStorage',
    'shellKeyboard',
    'weatherDevice',
    'browserDevice',
  ]) {
    window.webkit.messageHandlers[channel] = { postMessage: body => send(channel, body) };
  }
  const canSave = data => data?.files?.length === 1 && data.files[0] instanceof File;
  Object.defineProperty(navigator, 'canShare', { value: canSave, configurable: true });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async data => {
      if (!canSave(data)) throw new TypeError('Choose one file to save.');
      const file = data.files[0];
      const { token } = await send('shellFiles', {
        action: 'begin',
        name: file.name,
        type: file.type,
        size: file.size,
      });
      try {
        for (let offset = 0; offset < file.size; offset += 196608) {
          const chunk = file.slice(offset, offset + 196608);
          const encoded = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(chunk);
          });
          await send('shellFiles', { action: 'append', token, offset, data: encoded });
        }
        const result = await send('shellFiles', { action: 'save', token });
        if (result.cancelled) throw new DOMException('Save cancelled', 'AbortError');
      } catch (error) {
        await send('shellFiles', { action: 'cancel', token }).catch(() => {});
        throw error;
      }
    },
  });
  window.__OMARCHY_PLATFORM__ = 'android';
  window.__HYPRLAND_NATIVE__ = true;
  window.__HYPRLAND_NATIVE_FOCUS__ = true;
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('native-shell', 'android-shell');
    const style = document.createElement('style');
    style.textContent =
      '.android-shell .prototype-layout{padding:0!important}.android-shell #touch-shell>div:first-child{padding-top:8px!important}';
    document.head.append(style);
  });
})();
