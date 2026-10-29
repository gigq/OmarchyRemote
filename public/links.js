/* Links open in Omarchy Remote: a link in a Chat, Muster or Canvas reply, or a web address in
   Herdr or Terminal output, opens the browser window straight to that page. The page is the native
   web view saved web apps use; where there is none, as in a plain browser tab, a new tab. */
(() => {
  const { node, button, storage } = HyprlandUtil;
  const KEY = 'omarchy-web-link';
  // The native web view behind the window, by the id web views are known by.
  const VIEW = 'webapp-link';
  const webURL = raw => {
    try {
      const u = new URL(String(raw));
      return ['http:', 'https:'].includes(u.protocol) && u.hostname && !u.username && !u.password
        ? u.href
        : null;
    } catch {
      return null;
    }
  };
  const browserDevice = () => window.webkit?.messageHandlers?.browserDevice;
  let current = null;

  // Opens a web address in the browser window; false when it is not one.
  function open(raw) {
    const url = webURL(raw);
    if (!url) return false;
    const logic = HyprlandApps.logic;
    if (!browserDevice() || !logic) {
      window.open(url, '_blank', 'noopener');
      return true;
    }
    storage.set(KEY, url);
    current?.load(url);
    logic.openApp('web');
    return true;
  }
  // Opens a web address in the system's own browser: the native apps send a new window there.
  function outside(raw) {
    const url = webURL(raw);
    if (url) window.open(url, '_blank', 'noopener');
    return !!url;
  }
  // A link's menu items, for an app's context menu: open it here or in the system browser, or
  // copy it. None for an element that is not in a web link.
  function menuItems(pressed) {
    const link = pressed?.closest?.('a[href]');
    const url = link && webURL(link.href);
    if (!url) return [];
    return [
      { label: 'Open in the Omarchy browser', run: () => open(url) },
      { label: 'Open in the default browser', run: () => outside(url) },
      { label: 'Copy link', run: () => navigator.clipboard?.writeText(url).catch(() => {}) },
    ];
  }
  // Has clicks on a container's links open in the browser window instead of leaving the app.
  function capture(container) {
    container.addEventListener('click', e => {
      const link = e.target.closest?.('a[href]');
      if (!link || !container.contains(link) || e.defaultPrevented) return;
      if (open(link.href)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  class LinkBrowser {
    constructor(root, host) {
      this.root = root;
      this.host = host;
      this.url = webURL(storage.get(KEY)) || '';
      const key = (text, label, fn) => {
        const b = button(text, fn, 'keycap web-key');
        b.setAttribute('aria-label', label);
        b.title = label;
        return b;
      };
      this.backKey = key('‹', 'Back', () => this.navigateBack());
      this.forwardKey = key('›', 'Forward', () => this.navigateForward());
      this.reloadKey = key('↻', 'Reload', () => this.command('reload').catch(() => {}));
      this.address = node('span', 'web-address');
      this.address.setAttribute('role', 'status');
      const outsideKey = key('↗', 'Open in the system browser', () => outside(this.url));
      const close = key('×', 'Close', () => HyprlandApps.logic?.closeApp('web'));
      const bar = node('div', 'web-bar');
      bar.append(this.backKey, this.forwardKey, this.reloadKey, this.address, outsideKey, close);
      this.page = node('div', 'web-page');
      this.status = node('div', 'webapp-status');
      this.status.setAttribute('role', 'status');
      this.page.append(this.status);
      root.append(bar, this.page);
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend'])
        this.page.addEventListener(type, e => e.stopPropagation());
      this.state = e => {
        const v = e.detail || {};
        if (v.appID !== VIEW || this.disposed) return;
        if (v.focused && this.active && !this.covered && host.logic.state.desk)
          host.logic.focusApp('web');
        if (webURL(v.url)) {
          this.url = v.url;
          storage.set(KEY, v.url);
        }
        if ('back' in v) this.canGoBack = !!v.back;
        if ('forward' in v) this.canGoForward = !!v.forward;
        if ('loading' in v) this.loading = !!v.loading;
        if (v.error) this.error(v.error);
        else if (v.loading === false && !this.failed) this.status.replaceChildren();
        this.renderBar();
      };
      window.addEventListener('host-browser-state', this.state);
      current = this;
      this.renderBar();
      this.start();
      this.frame = () => {
        if (this.disposed) return;
        this.layout();
        this.frameID = requestAnimationFrame(this.frame);
      };
      this.frameID = requestAnimationFrame(this.frame);
    }
    renderBar() {
      let host = this.url;
      try {
        const u = new URL(this.url);
        host = u.host + (u.pathname === '/' ? '' : u.pathname);
      } catch {}
      this.address.textContent = host || 'No page open';
      this.address.title = this.url;
      this.backKey.disabled = !this.canGoBack;
      this.forwardKey.disabled = !this.canGoForward;
      this.reloadKey.classList.toggle('loading', !!this.loading);
    }
    async command(action, extra = {}) {
      return browserDevice().postMessage({ action, appID: VIEW, ...extra });
    }
    async start() {
      try {
        const caps = await browserDevice()?.postMessage({ action: 'capabilities' });
        if (this.disposed) return;
        if (!caps?.webApps) {
          this.status.replaceChildren(node('p', '', 'Update the app to open pages here.'));
          const link = node('a', 'remote-button', 'Open in browser');
          link.href = this.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          this.status.append(link);
          return;
        }
        this.ready = true;
        if (this.url) await this.command('open', { url: this.url });
        else this.status.replaceChildren(node('p', '', 'Links you open from apps show here.'));
        this.lastLayout = null;
        this.layout();
      } catch (e) {
        if (!this.disposed) this.error(e.message || 'Could not open the page');
      }
    }
    // Shows another page, from a link opened while the window is up.
    load(url) {
      this.url = url;
      this.failed = false;
      this.canGoBack = this.canGoForward = false;
      this.status.replaceChildren();
      this.renderBar();
      if (this.ready) this.command('open', { url }).catch(e => this.error(e.message));
    }
    error(message) {
      this.failed = true;
      this.layout();
      this.status.replaceChildren(
        node('p', '', message),
        button('Retry', () => {
          this.failed = false;
          this.status.replaceChildren();
          this.command('open', { url: this.url }).catch(e => this.error(e.message));
        })
      );
    }
    // Tells the native view where the page goes: the area under the bar, while it shows.
    layout() {
      if (!this.ready || this.disposed) return;
      const r = this.page.getBoundingClientRect();
      const visible = !!(
        this.url &&
        this.active &&
        !this.covered &&
        !this.failed &&
        !document.hidden &&
        !document.querySelector('.desk-sheet,.context-scrim') &&
        r.width > 1 &&
        r.height > 1 &&
        this.root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
      this.root.closest('[data-workspace]')?.classList.toggle('native-surface-visible', visible);
      const v = visualViewport;
      const payload = {
        visible,
        focused: visible && this.host.logic.cur() === 'web',
        opacity: HyprlandThemes.windowOpacity(this.host.logic.cur() === 'web'),
        ...(visible
          ? {
              rect: [r.x - (v?.offsetLeft || 0), r.y - (v?.offsetTop || 0), r.width, r.height],
              viewport: innerWidth,
              radius: parseFloat(getComputedStyle(this.page).borderTopLeftRadius) || 0,
              roundedTop: true,
              controlsHidden: true,
              background: HyprlandThemes.backgroundRGB(),
            }
          : {}),
      };
      const key = JSON.stringify(payload);
      if (key !== this.lastLayout) {
        this.lastLayout = key;
        this.command('layout', payload).catch(e => {
          if (!this.disposed) this.error(e.message);
        });
      }
    }
    show(active, { covered = false } = {}) {
      this.active = active;
      this.covered = covered;
      this.layout();
    }
    navigateBack() {
      if (!this.canGoBack || !this.ready) return false;
      this.command('back').catch(() => {});
      return true;
    }
    navigateForward() {
      if (!this.canGoForward || !this.ready) return false;
      this.command('forward').catch(() => {});
      return true;
    }
    dispose() {
      this.disposed = true;
      if (current === this) current = null;
      cancelAnimationFrame(this.frameID);
      window.removeEventListener('host-browser-state', this.state);
      this.root.closest('[data-workspace]')?.classList.remove('native-surface-visible');
      if (this.ready) this.command('close').catch(() => {});
      this.root.replaceChildren();
    }
  }

  HyprlandApps.provide('web', { create: (root, host) => new LinkBrowser(root, host) });
  window.HyprlandLinks = { open, outside, capture, menuItems };
})();
