/* Shared DOM and storage helpers for app modules (window.HyprlandUtil).
   Loaded right after apps.js so every module can destructure what it needs. */
(() => {
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // Live DOM only: the design runtime keeps a hidden template copy inside <x-dc>.
  const mount = id => [...document.querySelectorAll('#' + id)].find(n => !n.closest('x-dc'));
  const button = (text, action, cls = 'remote-button') => {
    const b = node('button', cls, text);
    b.type = 'button';
    b.onclick = e => {
      e.stopPropagation();
      action(e);
    };
    return b;
  };
  // Native keeps a small local mirror so live and bundled offline origins share preferences.
  const native = window.__OMARCHY_DEVICE__?.snapshot;
  try {
    if (
      native &&
      ((window.__OMARCHY_DEVICE__?.scope &&
        localStorage.getItem('hyper-storage-scope') !== window.__OMARCHY_DEVICE__.scope &&
        (localStorage.getItem('hyper-storage-scope') !== null ||
          window.__OMARCHY_DEVICE__.scope !== window.__OMARCHY_DEVICE__.legacyScope)) ||
        Number(native['omarchy-local-modified'] || 0) >
          Number(localStorage.getItem('omarchy-local-modified') || 0))
    ) {
      for (const key of Object.keys(localStorage))
        if (key.startsWith('omarchy-')) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(native))
        if (key.startsWith('omarchy-') && typeof value === 'string')
          localStorage.setItem(key, value);
    }
    if (window.__OMARCHY_DEVICE__?.scope)
      localStorage.setItem('hyper-storage-scope', window.__OMARCHY_DEVICE__.scope);
  } catch {}
  let mirrorPending = false;
  const mirror = () => {
    if (!window.webkit?.messageHandlers?.shellStorage || mirrorPending) return;
    mirrorPending = true;
    queueMicrotask(() => {
      mirrorPending = false;
      try {
        const values = Object.fromEntries(
          Object.keys(localStorage)
            .filter(k => k.startsWith('omarchy-'))
            .map(k => [k, localStorage.getItem(k)])
        );
        window.webkit.messageHandlers.shellStorage.postMessage(
          window.__OMARCHY_DEVICE__?.scope === undefined
            ? values
            : { scope: window.__OMARCHY_DEVICE__.scope, values }
        );
      } catch {}
    });
  };
  window.addEventListener('pagehide', mirror);
  // localStorage can throw (private mode, quota); every accessor swallows that.
  const storage = {
    get: k => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        const value = v == null ? null : String(v);
        if (localStorage.getItem(k) === value) return;
        value == null ? localStorage.removeItem(k) : localStorage.setItem(k, value);
        if (k.startsWith('omarchy-')) {
          localStorage.setItem(
            'omarchy-local-modified',
            String(
              Math.max(Date.now(), Number(localStorage.getItem('omarchy-local-modified') || 0) + 1)
            )
          );
          mirror();
        }
        window.dispatchEvent(new CustomEvent('hyprland-storage', { detail: { key: k, value } }));
      } catch {}
    },
    read: (k, fallback = null) => {
      try {
        return JSON.parse(localStorage.getItem(k)) ?? fallback;
      } catch {
        return fallback;
      }
    },
    write: (k, v) => storage.set(k, JSON.stringify(v)),
  };
  /* A computer, or a phone or tablet with a keyboard attached: typing comes from real keys, so
     apps leave out what touch typing needs (the row of Esc, Tab, arrow, and Ctrl keys, and
     Terminal's message box). The desktop app is one; the iOS, Android, and visionOS apps are not
     unless a keyboard is connected; a browser is one unless it is on iOS or Android, or its main
     pointer is a finger. */
  const desktopClass = () => {
    if (window.__HYPRLAND_HARDWARE_KEYBOARD__ === true) return true;
    if (window.__OMARCHY_PLATFORM__ === 'desktop') return true;
    if (window.__HYPRLAND_NATIVE_FOCUS__ || window.__OMARCHY_PLATFORM__) return false;
    const { userAgent = '', platform = '', maxTouchPoints = 0 } = globalThis.navigator || {};
    const touchSystem =
      /iPhone|iPad|iPod|Android/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
    return !touchSystem && !globalThis.matchMedia?.('(pointer: coarse)').matches;
  };
  const markDesktopClass = () => {
    const on = desktopClass();
    const root = globalThis.document?.documentElement;
    if (!root || root.classList.contains('desktop-class') === on) return;
    root.classList.toggle('desktop-class', on);
    window.dispatchEvent(new Event('hyprland-desktop-class'));
  };
  markDesktopClass();
  window.addEventListener('hyprland-hardware-keyboard', markDesktopClass);
  globalThis.matchMedia?.('(pointer: coarse)').addEventListener?.('change', markDesktopClass);
  window.HyprlandUtil = { node, mount, button, storage, desktopClass };
})();
