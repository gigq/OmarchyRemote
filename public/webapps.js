/* Host-wide web-app catalog, cached locally with a durable offline mutation queue. */
(() => {
  const { node, button, storage } = HyprlandUtil,
    storeKey = 'omarchy-webapps';
  const webURL = raw => {
    try {
      const u = new URL(raw.includes('://') ? raw : 'https://' + raw);
      return ['http:', 'https:'].includes(u.protocol) && u.hostname && !u.username && !u.password
        ? u.href
        : null;
    } catch {
      return null;
    }
  };
  let logic;
  let saved = storage.read(storeKey, []);
  saved = Array.isArray(saved)
    ? saved
        .filter(
          a =>
            typeof a?.id === 'string' &&
            /^webapp-[a-z0-9-]{1,72}$/.test(a.id) &&
            typeof a.name === 'string' &&
            a.name.trim() &&
            typeof a.url === 'string' &&
            webURL(a.url)
        )
        .slice(0, 50)
    : [];
  const persist = next => {
    storage.write(storeKey, next);
    saved = next;
  };
  const register = app => {
    HyprlandApps.defineWebApp(app);
    HyprlandApps.provide(app.id, { create: (root, host) => new WebApp(root, host, app) });
  };
  class WebApp {
    constructor(root, host, app) {
      this.root = root;
      this.host = host;
      this.app = app;
      this.active = false;
      this.preview = node('img', 'webapp-preview');
      this.preview.alt = app.name + ' preview';
      this.preview.hidden = true;
      this.status = node('div', 'webapp-status');
      this.status.setAttribute('role', 'status');
      root.append(this.preview, this.status);
      this.bridge = window.webkit?.messageHandlers?.browserDevice;
      this.state = e => {
        const v = e.detail || {};
        if (v.appID !== app.id || this.disposed) return;
        if (v.focused && this.active && !this.covered && host.logic.state.desk)
          host.logic.focusApp(app.id);
        if (v.preview?.startsWith('data:image/jpeg;base64,')) {
          this.preview.src = v.preview;
          this.preview.hidden = false;
        }
        if (v.error) this.error(v.error);
        else if (v.loading === false && !this.failed) this.status.replaceChildren();
      };
      window.addEventListener('host-browser-state', this.state);
      for (const type of [
        'pointerdown',
        'pointerup',
        'touchstart',
        'touchmove',
        'touchend',
        'click',
      ])
        root.addEventListener(type, e => e.stopPropagation());
      this.start();
      this.frame = () => {
        if (this.disposed) return;
        this.layout();
        this.frameID = requestAnimationFrame(this.frame);
      };
      this.frameID = requestAnimationFrame(this.frame);
    }
    async command(action, extra = {}) {
      return this.bridge.postMessage({ action, appID: this.app.id, ...extra });
    }
    async start() {
      try {
        const caps = await this.bridge?.postMessage({ action: 'capabilities' });
        if (this.disposed) return;
        if (!caps?.webApps) {
          this.status.replaceChildren(
            node(
              'p',
              '',
              this.bridge
                ? 'Update the native app to open web apps.'
                : 'Open this web app in the native iPhone or iPad app.'
            )
          );
          const link = node('a', 'remote-button', 'Open in browser');
          link.href = this.app.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          this.status.append(link);
          return;
        }
        this.ready = true;
        await this.command('open', { url: this.app.url });
        this.lastLayout = null;
        if (this.disposed) return;
        this.layout();
      } catch (e) {
        if (!this.disposed) this.error(e.message || 'Could not open web app');
      }
    }
    error(message) {
      this.failed = true;
      this.layout();
      this.status.replaceChildren(
        node('p', '', message),
        button('Retry', () => {
          this.failed = false;
          if (!this.ready) {
            this.start();
            return;
          }
          this.layout();
          this.command('reload').catch(e => this.error(e.message));
        })
      );
    }
    layout() {
      if (!this.ready || this.disposed) return;
      const r = this.root.getBoundingClientRect();
      const visible = !!(
        this.active &&
        !this.covered &&
        !this.failed &&
        !document.hidden &&
        !document.querySelector('.desk-sheet') &&
        r.width > 1 &&
        r.height > 1 &&
        this.root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
      this.root.closest('[data-workspace]')?.classList.toggle('native-surface-visible', visible);
      const opacity = HyprlandThemes.windowOpacity(this.host.logic.cur() === this.app.id);
      const v = visualViewport;
      const payload = {
        visible,
        focused: visible && this.host.logic.cur() === this.app.id,
        opacity,
        ...(visible
          ? {
              rect: [r.x - (v?.offsetLeft || 0), r.y - (v?.offsetTop || 0), r.width, r.height],
              viewport: innerWidth,
              radius: parseFloat(getComputedStyle(this.root).borderTopLeftRadius) || 0,
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
      if (visible && performance.now() - (this.lastPreview || 0) > 4000) {
        this.lastPreview = performance.now();
        this.command('snapshot').catch(() => {});
      }
    }
    show(active, { covered = false } = {}) {
      this.active = active;
      this.covered = covered;
      this.layout();
    }
    dispose() {
      this.root.closest('[data-workspace]')?.classList.remove('native-surface-visible');
      this.disposed = true;
      cancelAnimationFrame(this.frameID);
      window.removeEventListener('host-browser-state', this.state);
      if (this.ready) this.command('close').catch(() => {});
      this.root.replaceChildren();
    }
  }
  for (const app of saved) register(app);
  let queue = storage.read('omarchy-webapps-outbox', []);
  if (!Array.isArray(queue)) queue = [];
  let inFlight = null,
    syncing = false,
    syncMessage = 'Connecting to host…',
    refreshSettings = () => {};
  const saveQueue = () => storage.write('omarchy-webapps-outbox', queue);
  if (storage.get('omarchy-webapps-migrated') !== '1') {
    for (const app of saved)
      if (!queue.some(q => q.app?.id === app.id || q.id === app.id))
        queue.push({ action: 'import', app });
    saveQueue();
    storage.set('omarchy-webapps-migrated', '1');
  }
  const overlay = apps => {
    const rows = new Map(apps.map(a => [a.id, a]));
    for (const q of queue) {
      if (q.action === 'remove') rows.delete(q.id);
      else if (q.app) rows.set(q.app.id, q.app);
    }
    return [...rows.values()];
  };
  async function reconcile(apps) {
    const next = overlay(apps);
    if (JSON.stringify(next) === JSON.stringify(saved)) return;
    for (const previous of saved)
      if (!next.some(a => a.id === previous.id)) {
        if (logic?.state.open.includes(previous.id)) await logic.closeApp(previous.id);
        delete HyprlandApps.catalog[previous.id];
      }
    persist(next);
    for (const app of next) if (!HyprlandApps.get(app.id)) register(app);
    if (logic) {
      const pins = (logic.state.homePins || HyprlandApps.DEFAULT_PINS).filter(k =>
        HyprlandApps.get(k)
      );
      if (JSON.stringify(pins) !== JSON.stringify(logic.state.homePins)) {
        storage.write('omarchy-home-pins', pins);
        logic.set({ homePins: pins });
      } else logic.set({});
    }
    refreshSettings();
  }
  function sync() {
    if (inFlight) return inFlight;
    inFlight = performSync().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  async function performSync() {
    syncing = true;
    try {
      let data = await HyprlandPreferences.request('');
      if (data.schema !== 1 || !Array.isArray(data.webapps))
        throw Error('Host catalog unavailable');
      while (queue.length) {
        const item = queue[0];
        data = await HyprlandPreferences.request('/webapps', item);
        if (!Array.isArray(data.webapps)) throw Error('Host catalog unavailable');
        if (queue[0] === item) queue.shift();
        else queue = queue.filter(q => q !== item);
        saveQueue();
      }
      await reconcile(data.webapps);
      syncMessage =
        'Installed on ' + HyprlandApps.host.name + '. Available on every connected device.';
    } catch (e) {
      syncMessage = queue.length
        ? 'Saved locally · waiting to sync with host. ' + e.message
        : 'Using cached apps · ' + e.message;
    } finally {
      syncing = false;
      refreshSettings();
    }
  }
  function enqueue(change) {
    queue.push(change);
    saveQueue();
    sync();
  }
  const startup = sync(),
    ready = saved.length ? Promise.resolve() : startup;
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
  setInterval(() => {
    if (!document.hidden) sync();
  }, 5000);
  const keycap = (label, fn, aria, cls = '') => {
    const b = node('button', 'keycap ' + cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.onclick = e => {
      e.stopPropagation();
      fn();
    };
    return b;
  };
  const field = (label, input) => {
    const wrap = node('label', 'prompt-field webapps-field');
    wrap.append(node('span', 'prompt-label', label), input);
    return wrap;
  };
  /* Danger sheet over the Home sheet, naming the app and the host before removal. */
  function confirmUninstall(app, accept) {
    document.querySelector('.webapps-confirm')?.remove();
    const panel = node('section', 'webapps-confirm legend danger');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Uninstall from host');
    panel.append(node('span', 'legend-title', 'uninstall from ' + HyprlandApps.host.name));
    const line = node('div', 'webapps-confirm-app'),
      glyph = node('span', 'nf webapps-glyph', ''),
      text = node('div');
    text.append(node('strong', '', app.name), node('small', '', new URL(app.url).hostname));
    line.append(glyph, text);
    const copy = node(
      'p',
      '',
      `Removes it for every device connected to ${HyprlandApps.host.name}. Pins on this device and on other devices are cleared. You can install it again any time.`
    );
    const actions = node('div', 'webapps-confirm-actions');
    const close = () => panel.remove();
    actions.append(
      keycap('cancel', close, 'Cancel'),
      keycap(
        'uninstall',
        () => {
          close();
          accept();
        },
        'Uninstall',
        'rose filled'
      )
    );
    panel.append(line, copy, actions);
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend'])
      panel.addEventListener(type, e => e.stopPropagation(), { passive: true });
    (
      document.querySelector('.home-sheet') ||
      document.getElementById('touch-shell') ||
      document.body
    ).append(panel);
  }
  function settings(root) {
    const host = HyprlandApps.host.name;
    const section = node('section', 'webapps-settings');
    section.setAttribute('aria-label', 'Web apps');
    const add = node('section', 'legend webapps-add');
    add.append(node('span', 'legend-title', 'add'));
    const form = node('form', 'webapps-install'),
      name = node('input'),
      url = node('input');
    name.required = true;
    name.maxLength = 40;
    name.setAttribute('aria-label', 'Web app name');
    url.required = true;
    url.defaultValue = 'https://';
    url.value = 'https://';
    url.inputMode = 'url';
    url.autocapitalize = 'none';
    url.autocomplete = 'off';
    url.setAttribute('autocorrect', 'off');
    url.setAttribute('aria-label', 'Web app URL');
    const install = keycap('install', () => {}, 'Install web app', 'accent webapps-install-key');
    install.type = 'submit';
    const line = node('div', 'webapps-install-line');
    line.append(
      node(
        'span',
        'webapps-note',
        `Installs on ${host} for every connected device. Pins stay on this device.`
      ),
      install
    );
    form.append(field('name', name), field('url', url), line);
    const status = node('p', 'webapps-status');
    status.setAttribute('role', 'status');
    add.append(form, status);
    const installed = node('section', 'legend webapps-installed');
    const count = node('span', 'legend-meta');
    installed.append(node('span', 'legend-title', 'installed on ' + host), count);
    const list = node('div', 'webapps-list');
    installed.append(list);
    section.append(add, installed);
    root.prepend(section);
    const pins = () => logic?.state.homePins || HyprlandApps.DEFAULT_PINS;
    const setPins = next => {
      storage.write('omarchy-home-pins', next);
      logic?.set({ homePins: next });
    };
    const draw = () => {
      list.replaceChildren();
      count.textContent = String(saved.length);
      if (!saved.length)
        list.append(node('p', 'webapps-empty', 'No web apps on ' + host + ' yet.'));
      for (const app of saved) {
        const row = node('div', 'webapps-row'),
          open = keycap(
            '',
            () => {
              logic?.openApp(app.id);
              logic?.dashboard?.closeSheet();
            },
            'Open ' + app.name,
            'webapps-open'
          ),
          glyph = node('span', 'nf webapps-glyph', ''),
          text = node('div', 'webapps-text');
        text.append(node('strong', '', app.name), node('small', '', new URL(app.url).hostname));
        open.append(text);
        const pinned = pins().includes(app.id);
        const pin = keycap(
          '',
          () => {
            setPins(pinned ? pins().filter(k => k !== app.id) : [...pins(), app.id]);
            draw();
          },
          (pinned ? 'Unpin ' : 'Pin ') + app.name,
          'small webapps-pin'
        );
        pin.append(
          node('span', 'webapps-pin-mark', pinned ? '✓' : '+'),
          document.createTextNode(pinned ? 'pinned' : 'pin')
        );
        pin.setAttribute('aria-pressed', String(pinned));
        const remove = keycap(
          'uninstall',
          () =>
            confirmUninstall(app, async () => {
              try {
                await logic?.closeApp(app.id);
                if (logic?.state.open.includes(app.id))
                  throw Error('Close the app before removing it.');
                queue = queue.filter(q => q.app?.id !== app.id);
                enqueue({ action: 'remove', id: app.id });
                persist(saved.filter(a => a.id !== app.id));
                delete HyprlandApps.catalog[app.id];
                setPins(pins().filter(k => k !== app.id));
                draw();
                status.textContent = app.name + ' uninstalled. ' + syncMessage;
              } catch (e) {
                status.textContent = e.message;
              }
            }),
          'Uninstall ' + app.name + ' from host',
          'small rose'
        );
        row.append(glyph, open, pin, remove);
        list.append(row);
      }
    };
    form.onsubmit = e => {
      e.preventDefault();
      const title = name.value.trim(),
        href = webURL(url.value.trim());
      if (!title || !href) {
        status.textContent = 'Enter a name and an http or https URL.';
        return;
      }
      if (saved.length >= 50) {
        status.textContent = 'Remove a web app before installing another.';
        return;
      }
      try {
        const app = { id: 'webapp-' + crypto.randomUUID(), name: title, url: href };
        persist([...saved, app]);
        register(app);
        enqueue({ action: 'install', app });
        setPins([...pins(), app.id]);
        form.reset();
        draw();
        status.textContent = title + ' added. ' + syncMessage;
      } catch {
        status.textContent = 'Could not save this web app on the device.';
      }
    };
    let lastDraw;
    refreshSettings = () => {
      if (!section.isConnected) return;
      const signature = JSON.stringify(saved);
      if (signature !== lastDraw) {
        lastDraw = signature;
        draw();
      }
      status.textContent = syncMessage;
    };
    refreshSettings();
  }
  window.HyprlandWebApps = {
    ready,
    sync,
    settings,
    manage: () => logic?.dashboard?.managePins('web'),
    bind: value => {
      logic = value;
    },
  };
})();
