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
