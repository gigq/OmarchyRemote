/* Provider-neutral tab manager. The companion extension owns desktop mutations. */
(() => {
  const { node, storage } = window.HyprlandUtil;
  const LAST_TAB = 'omarchy-browser-last-tab';
  const webURL = raw => {
    try {
      const u = new URL(raw);
      return ['https:', 'http:'].includes(u.protocol) ? u : null;
    } catch {
      return null;
    }
  };
  class BrowserApp {
    constructor(root, host) {
      this.host = host;
      this.root = root;
      this.instances = [];
      this.filter = '';
      this.active = true;
      this.restoreTarget = storage.read(LAST_TAB);
      this.closedTabs = storage.read('omarchy-browser-closed-tabs', []);
      if (!Array.isArray(this.closedTabs)) this.closedTabs = [];
      this.zoom = 1;
      this.abort = new AbortController();
      root.classList.add('browser-app');
      this.search = node('input', 'browser-search');
      this.search.type = 'search';
      this.search.placeholder = 'Find a tab…';
      this.search.setAttribute('aria-label', 'Find a tab');
      this.search.autocapitalize = 'none';
      this.search.setAttribute('autocorrect', 'off');
      this.search.oninput = () => {
        this.restoreTarget = null;
        this.filter = this.search.value.toLowerCase();
        this.draw();
      };
      this.search.onkeydown = e => {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          this.selectTab(
            this.tabs().find(
              t =>
                webURL(t.tab.url) &&
                [t.tab.title, t.tab.url].some(value =>
                  String(value).toLowerCase().includes(this.filter)
                )
            )
          );
        }
      };
      this.status = node('div', 'remote-status');
      this.status.setAttribute('role', 'status');
      this.list = node('div', 'browser-list');
      const footer = node('div', 'browser-footer');
      footer.append(
        this.button('+ tab', () => this.newTab(), 'New desktop tab'),
        this.button('refresh', () => this.refresh(), 'Refresh tabs')
      );
      this.manager = node('div', 'browser-manager');
      this.manager.append(this.search, this.status, this.list, footer);
      root.append(this.manager);
      this.bridge = window.webkit?.messageHandlers?.browserDevice;
      this.capabilities = this.bridge
        ? Promise.resolve()
            .then(() => this.bridge.postMessage({ action: 'capabilities' }))
            .then(v => {
              this.nativeShortcuts = !!v?.shortcuts;
              this.nativeFind = !!v?.nativeFind;
              this.darkButton.hidden = !v?.darkMode;
              this.dark = !!v?.dark;
              this.darkButton.setAttribute('aria-pressed', String(this.dark));
              return (this.embedded = v?.embedded === true);
            })
            .catch(() => false)
        : Promise.resolve(false);
      this.pagePanel = node('div', 'browser-page');
      this.pagePanel.hidden = true;
      const nav = node('div', 'browser-navigation');
      this.back = this.button('‹', () => this.command('back'), 'Back');
      this.forward = this.button('›', () => this.command('forward'), 'Forward');
      this.back.disabled = this.forward.disabled = true;
      this.darkButton = this.button(
        'Dark',
        async () => {
          await this.toggleDark();
          this.showOptions(false);
        },
        'Force dark mode'
      );
      this.darkButton.hidden = true;
      this.darkButton.setAttribute('aria-pressed', 'false');
      this.more = this.button('…', () => this.showOptions(!this.optionsOpen), 'Browser options');
      this.more.setAttribute('aria-expanded', 'false');
      this.more.setAttribute('aria-haspopup', 'dialog');
      nav.append(
        this.button('‹', () => this.showManager(), 'Desktop tabs'),
        this.back,
        this.forward,
        this.more
      );
      const addressForm = node('form', 'browser-address-form');
      addressForm.noValidate = true;
      this.address = node('input', 'browser-address');
      this.address.type = 'url';
      this.address.autocapitalize = 'none';
      this.address.autocomplete = 'off';
      this.address.setAttribute('autocorrect', 'off');
      this.address.setAttribute('aria-label', 'Page address');
      this.address.enterKeyHint = 'go';
      addressForm.append(this.address);
      addressForm.onsubmit = e => {
        e.preventDefault();
        const url = webURL(
          this.address.value.includes('://') ? this.address.value : 'https://' + this.address.value
        );
        if (url) {
          this.address.blur();
          this.open(e, url.href);
        } else this.pageStatus.textContent = 'Enter an http or https URL';
      };
      this.pageStatus = node('div', 'remote-status');
      this.pageStatus.setAttribute('role', 'status');
      this.slot = node('div', 'browser-native-slot');
      this.preview = node('img', 'browser-preview');
      this.preview.alt = 'Page preview';
      this.preview.hidden = true;
      this.slot.append(this.preview);
      this.chrome = node('div', 'browser-chrome');
      this.chrome.append(nav, addressForm, this.pageStatus);
      this.options = node('div', 'browser-options-overlay');
      this.options.hidden = true;
      const optionsPanel = node('div', 'browser-options');
      optionsPanel.setAttribute('role', 'dialog');
      optionsPanel.setAttribute('aria-label', 'Browser options');
      optionsPanel.append(
        this.darkButton,
        this.button(
          'Reload',
          () => {
            this.showOptions(false);
            this.command('reload');
          },
          'Reload page'
        )
      );
      this.options.append(optionsPanel);
      this.options.onclick = e => {
        if (e.target === this.options) this.showOptions(false);
      };
      this.options.onkeydown = e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.showOptions(false);
        }
      };
      this.pagePanel.append(this.chrome, this.slot, this.options);
      root.append(this.pagePanel);
      this.resume = this.button('return to page', () => this.showPage(true), 'Return to page');
      this.resume.hidden = true;
      footer.append(this.resume);
      this.pageState = e => {
        if (this.disposed) return;
        const v = e.detail || {};
        if (v.appID) return;
        if (v.focused && this.root.contains(document.activeElement)) document.activeElement.blur();
        this.navigationState(v);
        if (typeof v.controlsHidden === 'boolean' && document.activeElement !== this.address)
          this.setChrome(v.controlsHidden);
        if (v.error) this.setChrome(false);
        if (
          v.focused &&
          this.active &&
          !this.covered &&
          this.host?.logic.state.desk &&
          this.host.logic.cur() !== 'browser'
        )
          this.host.logic.focusApp('browser');
        if (v.url && document.activeElement !== this.address) this.address.value = v.url;
        if ('back' in v) this.back.disabled = !v.back;
        if ('forward' in v) this.forward.disabled = !v.forward;
        if ('error' in v || 'loading' in v)
          this.pageStatus.textContent = v.error || (v.loading ? 'Loading…' : '');
        if (v.preview?.startsWith('data:image/jpeg;base64,')) {
          this.preview.src = v.preview;
          this.preview.hidden = false;
        }
      };
      window.addEventListener('host-browser-state', this.pageState);
      this.frame = () => {
        if (this.disposed) return;
        this.syncContext();
        if (this.embedded && this.pageOpen) this.layout();
        this.frameID = requestAnimationFrame(this.frame);
      };
      this.frameID = requestAnimationFrame(this.frame);
      const controls = '.browser-footer button,.browser-dialog button';
      let touch = null;
      root.addEventListener('pointerdown', e => {
        if (e.target.closest(controls)) e.preventDefault();
      });
      root.addEventListener(
        'touchstart',
        e => {
          const button = e.target.closest(controls);
          if (
            !button ||
            button.disabled ||
            !root.contains(document.activeElement) ||
            !document.activeElement.matches('input')
          )
            return;
          const t = e.touches[0];
          touch = { button, x: t.clientX, y: t.clientY, moved: false };
          e.preventDefault();
        },
        { passive: false }
      );
      root.addEventListener(
        'touchmove',
        e => {
          if (touch) {
            const t = e.touches[0];
            if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 10) touch.moved = true;
          }
        },
        { passive: true }
      );
      root.addEventListener(
        'touchend',
        e => {
          if (!touch) return;
          const t = touch;
          touch = null;
          e.preventDefault();
          if (!t.moved && t.button.isConnected) t.button.click();
        },
        { passive: false }
      );
      root.addEventListener('touchcancel', () => {
        touch = null;
      });
      for (const event of [
        'pointerdown',
        'pointerup',
        'touchstart',
        'touchmove',
        'touchend',
        'click',
      ])
        root.addEventListener(event, e => e.stopPropagation());
      this.visibility = () => {
        if (!document.hidden && this.active) this.refresh();
      };
      document.addEventListener('visibilitychange', this.visibility);
      this.refresh();
      this.timer = setInterval(() => {
        if (this.active && !document.hidden) this.refresh();
      }, 2000);
    }
    button(text, fn, label) {
      const b = node('button', 'remote-button', text);
      b.type = 'button';
      if (label) b.setAttribute('aria-label', label);
      b.onclick = fn;
      return b;
    }
    async api(path, data) {
      const r = await fetch('/api/browser/' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
      });
      const value = await r.json();
      if (!r.ok) throw Error(value.error || 'Browser unavailable');
      return value;
    }
    refresh() {
      if (this.disposed) return Promise.resolve();
      if (this.refreshPromise) return this.refreshPromise;
      this.refreshPromise = this.fetchSnapshot().finally(() => {
        this.refreshPromise = null;
      });
      return this.refreshPromise;
    }
    async fetchSnapshot() {
      try {
        const data = await this.api('snapshot');
        if (this.disposed) return;
        const key = JSON.stringify(data.instances);
        if (key !== this.last) {
          this.instances = data.instances;
          this.last = key;
          this.draw();
        }
        await this.restoreLastTab();
        if (
          this.navigationTarget &&
          this.navigationProfile &&
          !this.instances.some(i => i.id === this.navigationTarget.instance_id)
        ) {
          const reconnected = this.instances.find(i => i.profile_id === this.navigationProfile);
          if (reconnected)
            this.navigationTarget = { ...this.navigationTarget, instance_id: reconnected.id };
        }
        if (
          this.navigationTarget &&
          !this.current() &&
          this.instances.some(i => i.id === this.navigationTarget.instance_id) &&
          !this.busy
        ) {
          clearTimeout(this.syncTimer);
          this.pendingNavigation = null;
          this.navigationTarget = null;
          storage.set(LAST_TAB, null);
          this.resume.hidden = true;
          this.showManager();
        }
        if (this.failed) {
          this.failed = false;
          this.status.textContent = '';
        }
      } catch (e) {
        if (!this.disposed) {
          this.failed = true;
          this.status.textContent = e.message;
        }
      }
    }
    draw() {
      const scroll = this.list.scrollTop;
      this.list.replaceChildren();
      if (!this.instances.length) {
        this.list.append(
          node('h3', '', 'Connect Vivaldi'),
          node(
            'p',
            'browser-empty',
            'Load the Omarchy Remote Browser extension in Vivaldi on the host. Open windows and workspaces will appear here. Closing a tab here closes it on the desktop.'
          ),
          node('p', 'browser-empty', 'Phone pages use their own login sessions.')
        );
        return;
      }
      let count = 0;
      for (const instance of this.instances) {
        const group = node('section', 'browser-instance');
        group.append(node('h3', '', instance.label || 'Vivaldi'));
        for (const [wi, window] of instance.windows.entries()) {
          const tabs = window.tabs.filter(
            t =>
              !this.filter ||
              [t.title, t.url].some(x => String(x).toLowerCase().includes(this.filter))
          );
          if (!tabs.length && this.filter) continue;
          const section = node('section', 'browser-window');
          const title = node(
            'div',
            'browser-window-title',
            `Window ${wi + 1}${window.focused ? ' · active' : ''}`
          );
          title.append(
            this.button('+', () => this.newTab(instance, window), 'New tab in window ' + (wi + 1))
          );
          section.append(title);
          const groups = new Map();
          for (const tab of tabs) {
            const id = tab.workspace_id || 0;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(tab);
          }
          for (const [id, items] of groups) {
            const name = id
              ? instance.workspaces.find(w => w.id === id)?.name || 'Workspace ' + id
              : 'Tabs';
            section.append(node('div', 'browser-workspace-title', name));
            for (const tab of items.sort((a, b) => a.index - b.index)) {
              count++;
              section.append(this.row(instance, window, tab));
            }
          }
          if (!tabs.length) section.append(node('p', 'browser-empty', 'No tabs'));
          group.append(section);
        }
        this.list.append(group);
      }
      if (!count && this.filter) this.list.append(node('p', 'browser-empty', 'No matching tabs.'));
      this.list.scrollTop = scroll;
    }
    row(instance, window, tab) {
      const row = node('div', 'browser-tab' + (tab.active ? ' active' : ''));
      row.dataset.tab = tab.id;
      const url = webURL(tab.url);
      const link = node(url ? 'a' : 'button', 'browser-open');
      if (url) {
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.onclick = e => this.open(e, url.href, { instance_id: instance.id, tab_id: tab.id });
      } else {
        link.type = 'button';
        link.onclick = () => {
          this.status.textContent = 'This internal page can only open on the desktop.';
        };
      }
      link.setAttribute('aria-label', 'Open ' + tab.title + ' on phone');
      const text = node('span', 'browser-tab-text');
      text.append(
        node('span', 'browser-tab-title', tab.title || 'New tab'),
        node(
          'small',
          '',
          url
            ? url.hostname + (url.pathname === '/' ? '' : url.pathname)
            : tab.url || 'Internal page'
        )
      );
      const badges = [
        tab.pinned ? 'pinned' : '',
        tab.muted ? 'muted' : '',
        tab.audible ? 'audio' : '',
        tab.stack_id ? 'stack' : '',
      ].filter(Boolean);
      if (badges.length) text.append(node('small', 'browser-badges', badges.join(' · ')));
      link.append(text);
      row.append(
        link,
        this.button('⋯', () => this.tabMenu(instance, window, tab), 'Manage ' + tab.title),
        this.button(
          '×',
          () => this.closeTab({ instance, window, tab }),
          'Close ' + tab.title + ' on desktop'
        )
      );
      return row;
    }
    tabs() {
      return this.instances.flatMap(instance =>
        instance.windows.flatMap(window =>
          window.tabs
            .slice()
            .sort((a, b) => a.index - b.index)
            .map(tab => ({ instance, window, tab }))
        )
      );
    }
    current() {
      const q = this.navigationTarget;
      return q && this.tabs().find(t => t.instance.id === q.instance_id && t.tab.id === q.tab_id);
    }
    rememberTab(target) {
      const instance = this.instances.find(i => i.id === target.instance_id);
      if (instance)
        storage.write(LAST_TAB, {
          profile_id: instance.profile_id || null,
          instance_id: instance.id,
          tab_id: target.tab_id,
        });
    }
    async restoreLastTab() {
      const q = this.restoreTarget;
      if (!q || !(await this.capabilities) || this.disposed || this.restoreTarget !== q) return;
      const instance = this.instances.find(i =>
        q.profile_id ? i.profile_id === q.profile_id : i.id === q.instance_id
      );
      if (!instance) return; // A disconnected profile may reconnect; don't erase its saved tab.
      const tab = instance.windows.flatMap(w => w.tabs).find(t => t.id === q.tab_id);
      this.restoreTarget = null;
      if (!tab || !webURL(tab.url)) {
        storage.set(LAST_TAB, null);
        return;
      }
      await this.open(
        null,
        tab.url,
        { instance_id: instance.id, tab_id: tab.id },
        { restoring: true }
      );
    }
    showManager(focus = false) {
      this.restoreTarget = null;
      this.dismiss();
      this.showPage(false);
      if (focus) {
        this.search.focus({ preventScroll: true });
        this.search.select();
      }
    }
    syncContext() {
      if (!this.nativeShortcuts || this.disposed) return;
      const active = !!(
        this.active &&
        !this.covered &&
        !document.hidden &&
        !document.querySelector('.desk-sheet') &&
        this.host?.logic.cur() === 'browser'
      );
      if (active !== this.lastContext) {
        this.lastContext = active;
        this.command('context', { active });
      }
    }
    async selectTab(item) {
      if (item && webURL(item.tab.url)) {
        this.dismiss();
        await this.open(null, item.tab.url, { instance_id: item.instance.id, tab_id: item.tab.id });
      }
    }
    cycleTab(step) {
      const tabs = this.tabs().filter(t => webURL(t.tab.url)),
        current = this.current();
      const index = tabs.findIndex(t => t.tab === current?.tab);
      if (tabs.length) this.selectTab(tabs[(index + step + tabs.length) % tabs.length]);
    }
    numberedTab(number) {
      const current = this.current();
      const tabs = this.tabs().filter(
        t =>
          webURL(t.tab.url) &&
          (!current || (t.instance === current.instance && t.window === current.window))
      );
      this.selectTab(tabs[number === 9 ? tabs.length - 1 : number - 1]);
    }
    async closeTab(item = this.current()) {
      if (!item) return;
      const { instance, window, tab } = item;
      const current = this.current();
      const tabs = this.tabs().filter(t => webURL(t.tab.url));
      const index = tabs.findIndex(t => t.tab === tab);
      const next = tabs[index + 1] || tabs[index - 1];
      if (
        !(await this.act(instance, { action: 'close', tab_id: tab.id }, 'Tab closed on desktop.'))
      )
        return;
      if (webURL(tab.url)) {
        this.closedTabs.push({
          profile_id: instance.profile_id || null,
          instance_id: instance.id,
          window_id: window.id,
          workspace_id: tab.workspace_id || 0,
          url: tab.url,
        });
        this.closedTabs = this.closedTabs.slice(-20);
        storage.write('omarchy-browser-closed-tabs', this.closedTabs);
      }
      if (current?.tab === tab) {
        clearTimeout(this.syncTimer);
        this.pendingNavigation = null;
        this.navigationTarget = null;
        storage.set(LAST_TAB, null);
        if (next) await this.selectTab(next);
        else {
          this.resume.hidden = true;
          this.showManager();
          await this.command('close');
          this.lastContext = null;
          this.syncContext();
        }
      }
    }
    async reopenTab() {
      const saved = this.closedTabs.at(-1);
      if (!saved) {
        this.status.textContent = 'No tabs closed here to reopen.';
        this.showManager();
        return;
      }
      const instance = this.instances.find(i =>
        saved.profile_id ? i.profile_id === saved.profile_id : i.id === saved.instance_id
      );
      if (!instance) {
        this.status.textContent = 'Reconnect that desktop browser to reopen its tab.';
        this.showManager();
        return;
      }
      const window = instance.windows.find(w => w.id === saved.window_id) || instance.windows[0];
      if (await this.createTab(instance, window, saved.url, saved.workspace_id)) {
        this.closedTabs.pop();
        storage.write('omarchy-browser-closed-tabs', this.closedTabs);
      }
    }
    async createTab(instance, window, url, workspace = 0) {
      if (this.busy) return false;
      this.busy = true;
      try {
        const response = await this.api('action', {
          instance_id: instance.id,
          action: 'create',
          url,
          ...(window
            ? {
                window_id: window.id,
                ...(instance.workspace_write ? { workspace_id: workspace } : {}),
              }
            : { new_window: true }),
        });
        await this.refresh();
        this.dismiss();
        const id = response.result?.tab_id;
        const locate = () =>
          this.tabs().find(
            t =>
              t.instance.id === instance.id &&
              (id != null
                ? t.tab.id === id
                : t.window.id === response.result?.window_id && t.tab.url === url)
          );
        let found = locate();
        // The extension acknowledges creation before its debounced snapshot arrives.
        for (let attempt = 0; !found && !this.disposed && attempt < 3; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 150));
          await this.refresh();
          found = locate();
        }
        if (this.disposed) return false;
        if (found) await this.selectTab(found);
        else if (id != null) await this.open(null, url, { instance_id: instance.id, tab_id: id });
        else this.showManager();
        return true;
      } catch (e) {
        this.status.textContent = e.message;
        return false;
      } finally {
        this.busy = false;
      }
    }
    async focusAddress() {
      const serial = (this.inputFocusSerial = (this.inputFocusSerial || 0) + 1);
      if (!this.pageOpen) {
        this.search.focus({ preventScroll: true });
        this.search.select();
        return;
      }
      this.setChrome(false);
      if (this.nativeShortcuts) await this.command('focus', { active: false });
      if (
        this.disposed ||
        serial !== this.inputFocusSerial ||
        !this.active ||
        this.covered ||
        this.host?.logic.cur() !== 'browser'
      )
        return;
      this.address.focus({ preventScroll: true });
      this.address.select();
      this.layout();
    }
    openFind() {
      if (!this.pageOpen || !this.nativeFind) return;
      this.inputFocusSerial = (this.inputFocusSerial || 0) + 1;
      this.setChrome(false);
      if (this.root.contains(document.activeElement)) document.activeElement.blur();
      this.layout();
      this.command('findOpen');
    }
    find(backwards) {
      if (this.pageOpen && this.nativeFind) {
        this.inputFocusSerial = (this.inputFocusSerial || 0) + 1;
        if (this.root.contains(document.activeElement)) document.activeElement.blur();
        this.layout();
        this.command('findNext', { backwards });
      }
    }
    async escapePage() {
      const serial = (this.inputFocusSerial = (this.inputFocusSerial || 0) + 1);
      this.address.blur();
      if (!this.nativeShortcuts) return;
      const result = this.nativeFind ? await this.command('findClose') : null;
      if (
        this.disposed ||
        result?.closed ||
        serial !== this.inputFocusSerial ||
        !this.active ||
        this.covered ||
        this.host?.logic.cur() !== 'browser'
      )
        return;
      this.command('stop');
      this.command('focus');
    }
    setZoom(value) {
      this.zoom = Math.max(0.25, Math.min(5, value));
      this.command('zoom', { value: this.zoom });
    }
    // Listed in the desk shortcut sheet while the browser is in front; shortcut() below takes
    // the matching keydown events before the shell bindings.
    static shortcuts = [
      ['⌘L', 'Focus the address bar (⇧ opens the tab manager)'],
      ['⌘T', 'New tab (⇧ reopens the last closed tab)'],
      ['⌘N', 'New window'],
      ['⌘⇧W', 'Close browser tab (⌘W closes the window)'],
      ['⌘R / F5', 'Reload (⇧ bypasses the cache)'],
      ['⌘F / F3', 'Find in page'],
      ['⌘G / ⇧⌘G', 'Next / previous match'],
      ['⌘[ / ⌘]', 'Back / forward'],
      ['⌘1 … ⌘9', 'Switch to a numbered tab'],
      ['⌘⌥← / →', 'Previous / next tab (also Ctrl+Tab, Ctrl+PageUp/Down)'],
      ['⌘+ / ⌘− / ⌘0', 'Zoom in / out / reset'],
      ['F2', 'Tab manager'],
      ['Esc', 'Close the dialog, options, or page view'],
    ];
    // Only the embedded (native) browser takes these keys, so the sheet lists them only then.
    get shortcuts() {
      return this.embedded ? BrowserApp.shortcuts : [];
    }
    shortcut(e) {
      if (!this.embedded || !this.active || this.covered || e.repeat) return false;
      const cmd = e.metaKey && !e.ctrlKey,
        ctrl = e.ctrlKey && !e.metaKey && !e.altKey,
        plain = !e.metaKey && !e.ctrlKey && !e.altKey,
        c = e.code,
        shift = e.shiftKey;
      let run;
      if (plain && c === 'Escape') {
        if (this.dialog) run = () => this.dismiss();
        else if (this.optionsOpen) run = () => this.showOptions(false);
        else if (this.pageOpen) run = () => this.escapePage();
      } else if (ctrl && c === 'Tab') run = () => this.cycleTab(shift ? -1 : 1);
      else if (ctrl && /^Page(Up|Down)$/.test(c))
        run = () => this.cycleTab(c === 'PageUp' ? -1 : 1);
      else if (plain && c === 'F2') run = () => this.showManager(true);
      else if (plain && c === 'F3' && this.nativeFind) run = () => this.find(shift);
      else if (plain && c === 'F5') run = () => this.command('reload', { bypassCache: shift });
      else if (cmd && e.altKey && /^Arrow(Left|Right)$/.test(c))
        run = () => this.cycleTab(c === 'ArrowLeft' ? -1 : 1);
      else if (cmd && !e.altKey) {
        if (c === 'KeyL') run = () => (shift ? this.showManager(true) : this.focusAddress());
        else if (c === 'KeyT')
          run = () => {
            if (shift) this.reopenTab();
            else {
              const t = this.current();
              if (this.pageOpen) this.showManager();
              this.newTab(t?.instance, t?.window);
            }
          };
        else if (c === 'KeyN' && !shift)
          run = () => {
            const t = this.current();
            this.showManager();
            this.newTab(t?.instance, null, true);
          };
        else if (c === 'KeyW' && shift) run = () => this.closeTab();
        else if (c === 'KeyF' && this.nativeFind)
          run = () => (shift ? this.host.logic.desk?.toggleFull?.() : this.openFind());
        else if (c === 'KeyR')
          run = () =>
            this.pageOpen ? this.command('reload', { bypassCache: shift }) : this.refresh();
        else if (c === 'KeyG' && this.nativeFind) run = () => this.find(shift);
        else if (!shift && /^Bracket(Left|Right)$/.test(c))
          run = () => this.pageOpen && this.command(c === 'BracketLeft' ? 'back' : 'forward');
        else if (!shift && /^Digit[1-9]$/.test(c)) run = () => this.numberedTab(Number(c.slice(5)));
        else if (
          this.nativeShortcuts &&
          ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract'].includes(c)
        )
          run = () =>
            this.setZoom(
              c === 'Digit0'
                ? 1
                : this.zoom + (['Minus', 'NumpadSubtract'].includes(c) ? -0.1 : 0.1)
            );
      }
      if (!run) return false;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.optionsOpen && c !== 'Escape') this.showOptions(false);
      run();
      return true;
    }
    rgb(variable) {
      const e = node('span');
      e.style.color = `var(${variable})`;
      this.root.append(e);
      const value = getComputedStyle(e)
        .color.match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number);
      e.remove();
      return value;
    }
    async command(action, extra = {}) {
      try {
        return await this.bridge.postMessage({ action, ...extra });
      } catch (e) {
        if (!this.disposed) this.pageStatus.textContent = e.message || 'Could not open page';
      }
    }
    async toggleDark() {
      this.darkButton.disabled = true;
      try {
        const result = await this.bridge.postMessage({ action: 'dark', enabled: !this.dark });
        this.dark = !!result.dark;
        this.darkButton.setAttribute('aria-pressed', String(this.dark));
        this.lastPreview = 0;
      } catch (e) {
        this.pageStatus.textContent = e.message || 'Could not change dark mode';
      } finally {
        this.darkButton.disabled = false;
      }
    }
    showOptions(open) {
      this.optionsOpen = open;
      this.options.hidden = !open;
      this.more.setAttribute('aria-expanded', String(open));
      this.layout();
      if (open) this.options.querySelector('button:not([hidden])')?.focus({ preventScroll: true });
      else if (this.options.contains(document.activeElement))
        this.more.focus({ preventScroll: true });
    }
    setChrome(hidden) {
      if (hidden && this.optionsOpen) this.showOptions(false);
      this.chromeHidden = hidden;
      this.chrome.inert = hidden;
      this.pagePanel.classList.toggle('browser-chrome-hidden', hidden);
    }
    showPage(visible) {
      this.inputFocusSerial = (this.inputFocusSerial || 0) + 1;
      if (!visible && this.nativeFind) this.command('findClose');
      if (this.optionsOpen) this.showOptions(false);
      this.pageOpen = visible;
      this.root.classList.toggle('browser-reading', visible);
      if (visible) this.setChrome(false);
      this.manager.hidden = visible;
      this.pagePanel.hidden = !visible;
      this.lastLayout = null;
      this.layout();
    }
    layout() {
      this.syncContext();
      if (!this.embedded) return;
      const r = this.slot.getBoundingClientRect();
      const style = getComputedStyle(this.root);
      const visible = !!(
        this.pageOpen &&
        !this.optionsOpen &&
        !this.dialog &&
        this.active &&
        !this.covered &&
        !document.hidden &&
        !document.querySelector('.desk-sheet') &&
        r.width > 1 &&
        r.height > 1 &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        this.root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
      if (visible && performance.now() - (this.lastPreview || 0) > 4000) {
        this.lastPreview = performance.now();
        this.command('snapshot');
      }
      this.root.closest('[data-workspace]')?.classList.toggle('native-surface-visible', visible);
      const opacity = HyprlandThemes.windowOpacity(this.host?.logic.cur() === 'browser');
      const v = visualViewport;
      const payload = {
        visible,
        focused:
          visible &&
          this.host?.logic.cur() === 'browser' &&
          !this.root.contains(document.activeElement?.closest('input,textarea,select')),
        opacity,
        ...(visible
          ? {
              rect: [r.x - (v?.offsetLeft || 0), r.y - (v?.offsetTop || 0), r.width, r.height],
              viewport: innerWidth,
              radius: parseFloat(getComputedStyle(this.slot).borderBottomLeftRadius) || 0,
              roundedTop: !!this.chromeHidden,
              controlsHidden: !!this.chromeHidden,
              background: HyprlandThemes.backgroundRGB(),
            }
          : {}),
      };
      const key = JSON.stringify(payload);
      if (key === this.lastLayout) return;
      this.lastLayout = key;
      this.command('layout', payload);
    }
    async open(event, url, target, { restoring = false } = {}) {
      if (!restoring) this.restoreTarget = null;
      if (!this.bridge) return;
      event?.preventDefault();
      await this.capabilities;
      if (this.disposed) return;
      if (!this.embedded) {
        try {
          await this.bridge.postMessage({
            url,
            background: this.rgb('--theme-background'),
            accent: this.rgb('--theme-accent'),
          });
        } catch (e) {
          this.status.textContent = e.message || 'Could not open page';
        }
        return;
      }
      clearTimeout(this.syncTimer);
      this.pendingNavigation = null;
      this.navigationTarget = target || this.navigationTarget;
      if (target) {
        this.navigationProfile = this.instances.find(i => i.id === target.instance_id)?.profile_id;
        this.lastSyncedURL = url;
        this.rememberTab(target);
      }
      this.initialPreviousURL = this.nativeURL === url ? null : this.nativeURL;
      this.preview.hidden = true;
      this.address.value = url;
      await this.command('open', { url });
      if (this.disposed) return;
      this.resume.hidden = false;
      this.showPage(true);
      if (!target) this.queueNavigation(url);
    }
    navigationState(v) {
      if (v.url) this.nativeURL = v.url;
      if (v.error || v.loading === true) {
        clearTimeout(this.syncTimer);
        this.pendingNavigation = null;
        return;
      }
      const url = webURL(v.url)?.href;
      if (!url || v.loading !== false || !this.navigationTarget) return;
      // An old page can emit a final state while the replacement starts loading.
      if (this.initialPreviousURL === url) return;
      this.initialPreviousURL = null;
      if (url !== this.lastSyncedURL) this.queueNavigation(url);
    }
    queueNavigation(url) {
      if (!this.navigationTarget) return;
      this.pendingNavigation = { ...this.navigationTarget, url };
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => this.flushNavigation(), 300);
    }
    async flushNavigation() {
      if (this.syncing || this.disposed || !this.pendingNavigation) return;
      const q = this.pendingNavigation;
      this.pendingNavigation = null;
      this.syncing = true;
      try {
        await this.api('action', { ...q, action: 'navigate' });
        if (
          this.navigationTarget?.instance_id === q.instance_id &&
          this.navigationTarget?.tab_id === q.tab_id
        )
          this.lastSyncedURL = q.url;
        if (
          this.pendingNavigation?.url === q.url &&
          this.pendingNavigation.instance_id === q.instance_id &&
          this.pendingNavigation.tab_id === q.tab_id
        )
          this.pendingNavigation = null;
      } catch (e) {
        if (!this.disposed) {
          this.pageStatus.textContent = 'Desktop tab was not updated: ' + e.message;
          this.setChrome(false);
        }
      } finally {
        this.syncing = false;
        if (this.pendingNavigation && !this.disposed) this.flushNavigation();
      }
    }
    async act(instance, action, message) {
      if (this.busy) return false;
      this.busy = true;
      this.status.textContent = 'Updating desktop…';
      try {
        await this.api('action', { instance_id: instance.id, ...action });
        this.status.textContent = message || 'Desktop updated.';
        await this.refresh();
        return true;
      } catch (e) {
        this.status.textContent = e.message;
        await this.refresh();
        return false;
      } finally {
        this.busy = false;
      }
    }
    sheet(title) {
      this.dialog?.remove();
      const form = node('form', 'browser-dialog');
      form.setAttribute('role', 'dialog');
      form.setAttribute('aria-label', title);
      form.append(node('h3', '', title));
      this.root.append(form);
      this.dialog = form;
      this.restoreTarget = null;
      this.layout();
      return form;
    }
    dismiss() {
      this.dialog?.remove();
      this.dialog = null;
      this.layout();
    }
    tabMenu(i, w, t) {
      const form = this.sheet(t.title);
      form.onsubmit = e => e.preventDefault();
      for (const [label, q] of [
        ['Show on desktop', { action: 'focus' }],
        ['Reload on desktop', { action: 'reload' }],
        [t.pinned ? 'Unpin' : 'Pin', { action: 'pin', value: !t.pinned }],
        [t.muted ? 'Unmute' : 'Mute', { action: 'mute', value: !t.muted }],
      ])
        form.append(
          this.button(label, async () => {
            if (await this.act(i, { ...q, tab_id: t.id })) this.dismiss();
          })
        );
      form.append(
        this.button('Move…', () => this.moveTab(i, w, t)),
        this.button('Cancel', () => this.dismiss())
      );
    }
    select(form, label, items, current) {
      const field = node('select');
      field.setAttribute('aria-label', label);
      for (const [value, text] of items) {
        const option = node('option', '', text);
        option.value = value;
        field.append(option);
      }
      field.value = String(current);
      const caption = node('label', '', label);
      caption.append(field);
      form.append(caption);
      return field;
    }
    moveTab(i, w, t) {
      const form = this.sheet('Move tab');
      const window = this.select(
        form,
        'Window',
        i.windows.map((w, n) => [w.id, 'Window ' + (n + 1)]),
        w.id
      );
      const workspace = i.workspace_write
        ? this.select(
            form,
            'Workspace',
            [[0, 'No workspace'], ...i.workspaces.map(w => [w.id, w.name])],
            t.workspace_id || 0
          )
        : null;
      const position = this.select(
        form,
        'Position',
        [
          [-1, 'Last'],
          [0, 'First'],
        ],
        -1
      );
      const submit = this.button('Move', () => {});
      submit.type = 'submit';
      form.append(
        submit,
        this.button('Cancel', () => this.dismiss())
      );
      form.onsubmit = async e => {
        e.preventDefault();
        if (
          await this.act(i, {
            action: 'move',
            tab_id: t.id,
            window_id: Number(window.value),
            ...(workspace ? { workspace_id: Number(workspace.value) } : {}),
            index: Number(position.value),
          })
        )
          this.dismiss();
      };
    }
    newTab(instance, window, newWindow = false) {
      if (!this.instances.length) {
        this.status.textContent = 'Connect a desktop browser first.';
        return;
      }
      const form = this.sheet('New desktop tab');
      const browsers = this.select(
        form,
        'Browser',
        this.instances.map(i => [i.id, i.label]),
        instance?.id || this.instances[0].id
      );
      const destination = this.select(form, 'Window', [], 0);
      const spaces = this.select(form, 'Workspace', [], 0);
      const update = () => {
        const i = this.instances.find(i => i.id === browsers.value);
        spaces.parentElement.hidden = !i.workspace_write;
        destination.replaceChildren();
        for (const [value, text] of [
          [-1, 'New window'],
          ...i.windows.map((w, n) => [w.id, 'Window ' + (n + 1)]),
        ]) {
          const o = node('option', '', text);
          o.value = value;
          destination.append(o);
        }
        destination.value = String(newWindow ? -1 : (window?.id ?? i.windows[0]?.id ?? -1));
        spaces.replaceChildren();
        for (const [value, text] of [
          [0, 'No workspace'],
          ...i.workspaces.map(w => [w.id, w.name]),
        ]) {
          const o = node('option', '', text);
          o.value = value;
          spaces.append(o);
        }
      };
      browsers.onchange = update;
      update();
      const field = node('input');
      field.type = 'url';
      field.placeholder = 'https://…';
      field.setAttribute('aria-label', 'URL');
      field.autocapitalize = 'none';
      field.setAttribute('autocorrect', 'off');
      form.append(field);
      const submit = this.button('Create', () => {});
      submit.type = 'submit';
      form.append(
        submit,
        this.button('Cancel', () => this.dismiss())
      );
      form.onsubmit = async e => {
        e.preventDefault();
        const url = webURL(field.value.includes('://') ? field.value : 'https://' + field.value);
        if (!url) {
          this.status.textContent = 'Enter an http or https URL';
          return;
        }
        const i = this.instances.find(i => i.id === browsers.value);
        if (!i) return;
        const dest = Number(destination.value);
        await this.createTab(
          i,
          dest === -1 ? null : i.windows.find(w => w.id === dest),
          url.href,
          Number(spaces.value)
        );
      };
      field.focus();
    }
    show(active, { covered = false } = {}) {
      if ((!active || covered) && this.optionsOpen) this.showOptions(false);
      this.active = active;
      this.covered = covered;
      this.layout();
      if (!active && this.root.contains(document.activeElement)) document.activeElement.blur();
    }
    dispose() {
      this.root.closest('[data-workspace]')?.classList.remove('native-surface-visible');
      this.disposed = true;
      if (this.nativeShortcuts) this.command('context', { active: false });
      clearTimeout(this.syncTimer);
      this.pendingNavigation = null;
      cancelAnimationFrame(this.frameID);
      window.removeEventListener('host-browser-state', this.pageState);
      if (this.embedded) this.command('close');
      clearInterval(this.timer);
      this.abort.abort();
      document.removeEventListener('visibilitychange', this.visibility);
      this.root.replaceChildren();
    }
  }
  window.HostBrowserApp = BrowserApp;
  window.HyprlandApps?.provide('browser', { create: (root, host) => new BrowserApp(root, host) });
})();
