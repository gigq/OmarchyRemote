/* Live dashboard, attention inbox and a native-input universal launcher. */
(() => {
  const { node: el, mount } = window.HyprlandUtil;
  const read = window.HyprlandUtil.storage.read,
    save = window.HyprlandUtil.storage.write;
  const group = p => HyprlandRemote.paneGroup(p);
  const title = p => p.terminal_title_stripped || p.agent || p.pane_id;
  class Dashboard {
    constructor(logic) {
      this.logic = logic;
      this.abort = new AbortController();
      this.dismissed = read('omarchy-inbox-dismissed', []);
      this.muted = read('omarchy-inbox-muted', false);
      this.snapshot = null;
      this.home = mount('home-attention');
      this.metrics = mount('home-metrics');
      this.launch = mount('dashboard-launcher');
      this.inbox = mount('dashboard-notifications');
      this.buildLauncher();
      const host = el('div', 'home-host');
      this.host = host;
      this.hostLine(HyprlandApps.host.name + ' · connecting…');
      this.home.parentElement.insertBefore(
        host,
        this.home.parentElement.querySelector('[data-live-date]')
      );
      this.home.classList.add('legend');
      this.metrics.classList.add('legend');
      this.metrics.append(el('span', 'legend-title', 'host'));
      this.drawHome();
      this.drawInbox();
      const pins = read('omarchy-home-pins', null);
      if (Array.isArray(pins))
        logic.set({ homePins: [...new Set(pins.filter(k => k !== 'home' && logic.APPS[k]))] });
      this.timer = setInterval(() => this.poll(), 5000);
      this.poll();
      this.visibility = () => {
        if (!document.hidden) this.poll();
      };
      document.addEventListener('visibilitychange', this.visibility);
    }
    hostLine(text, uptime) {
      const name = el('span');
      name.append(el('i', 'state-dot'), document.createTextNode(text));
      this.host.replaceChildren(name);
      if (uptime) this.host.append(el('span', '', uptime));
    }
    /* Home sheet: pinned apps (drag to reorder), the host catalog, and the web apps tab. */
    managePins(tab = 'apps') {
      if (this.pinPanel) {
        this.pinTab = tab;
        this.pinDraw?.();
        return;
      }
      const panel = (this.pinPanel = el('section', 'home-sheet'));
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Pinned apps');
      this.pinTab = tab;
      const key = (label, fn, aria, cls = '') => {
        const b = el('button', 'keycap ' + cls, label);
        b.type = 'button';
        if (aria) b.setAttribute('aria-label', aria);
        b.onclick = e => {
          e.stopPropagation();
          fn();
        };
        return b;
      };
      const pins = () => this.logic.state.homePins || HyprlandApps.DEFAULT_PINS;
      const setPins = next => {
        save('omarchy-home-pins', next);
        this.logic.set({ homePins: next });
        draw();
      };
      const glyphOf = app => {
        const g = el('span', 'nf home-sheet-glyph', app.icon || app.glyph);
        g.style.color = app.color;
        return g;
      };
      const appRow = (k, app, pinned) => {
        const row = el('div', 'home-sheet-row');
        if (pinned) {
          const handle = el('span', 'home-sheet-handle', '⋮⋮');
          handle.onpointerdown = ev => this.dragPin(ev, row, k, pins(), setPins);
          row.append(handle);
        }
        row.append(glyphOf(app), el('span', 'home-sheet-name', app.name));
        const letter = app.superKeys?.find(x => /^[a-z]$/.test(x));
        if (pinned && letter) row.append(el('span', 'kbd super', letter));
        if (!pinned)
          row.append(
            k.startsWith('webapp-')
              ? el('span', 'tag', 'web')
              : el('span', 'home-sheet-detail', app.description || '')
          );
        const toggle = key(
          pinned ? '−' : '+',
          () => setPins(pinned ? pins().filter(x => x !== k) : [...pins(), k]),
          app.name,
          'icon ' + (pinned ? 'rose' : 'home-sheet-add')
        );
        toggle.setAttribute('aria-pressed', String(pinned));
        row.append(toggle);
        return row;
      };
      const legend = (title, meta) => {
        const box = el('section', 'legend home-sheet-legend');
        box.append(el('span', 'legend-title', title));
        if (meta) box.append(el('span', 'legend-meta', meta));
        return box;
      };
      const draw = () => {
        const keys = pins().filter(k => this.logic.APPS[k]);
        const apps = Object.entries(this.logic.APPS).filter(([k, a]) => k !== 'home' && !a.baseKey);
        const webCount = apps.filter(([k]) => k.startsWith('webapp-')).length;
        panel.replaceChildren();
        const head = el('div', 'home-sheet-head');
        head.append(
          el('h2', '', 'Home'),
          key(
            'done',
            () => {
              this.closeSheet();
            },
            'Done',
            'medium'
          )
        );
        const rail = el('div', 'rail home-sheet-rail');
        for (const [id, label, count] of [
          ['apps', 'apps', keys.length + ' pinned'],
          ['web', 'web apps', String(webCount)],
        ]) {
          const b = key(label, () => this.managePins(id), id === 'web' ? 'Web apps' : 'Apps');
          b.className = '';
          b.append(el('span', 'count', count));
          b.setAttribute('aria-pressed', String(this.pinTab === id));
          rail.append(b);
        }
        const body = el('div', 'home-sheet-body');
        panel.append(head, rail, body);
        if (this.pinTab === 'web') {
          window.HyprlandWebApps?.settings(body);
          return;
        }
        const onHome = legend('on home', 'this device · drag to reorder');
        for (const k of keys) onHome.append(appRow(k, this.logic.APPS[k], true));
        if (!keys.length)
          onHome.append(el('p', 'dashboard-muted home-sheet-empty', 'Nothing pinned yet.'));
        const available = legend('available on ' + HyprlandApps.host.name);
        const rest = apps.filter(([k]) => !keys.includes(k));
        for (const [k, app] of rest) available.append(appRow(k, app, false));
        if (!rest.length)
          available.append(
            el('p', 'dashboard-muted home-sheet-empty', 'Everything is on Home already.')
          );
        body.append(onHome, available);
      };
      this.pinDraw = draw;
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend'])
        panel.addEventListener(type, e => e.stopPropagation(), { passive: true });
      // Desk mode frames Home as a grid panel; while Home is showing, the sheet fills that panel
      // instead of the shell. On other desks it stays a shell overlay so the desk keeps its tiles.
      const onHome =
        document.documentElement.classList.contains('desk-mode') && this.logic.state.ws === 0;
      const home = onHome
        ? [...document.querySelectorAll('[data-workspace="home"]')].find(n => !n.closest('x-dc'))
        : null;
      (home || mount('touch-shell')).append(panel);
      draw();
    }
    closeSheet() {
      this.pinPanel?.remove();
      this.pinPanel = null;
      this.pinDraw = null;
    }
    dragPin(ev, row, k, keys, commit) {
      ev.preventDefault();
      const handle = ev.currentTarget;
      const rows = [...row.parentElement.querySelectorAll('.home-sheet-row')];
      const from = rows.indexOf(row);
      let to = from;
      const place = y => {
        to = rows.findIndex(r => y < r.getBoundingClientRect().bottom);
        if (to < 0) to = rows.length - 1;
        rows.forEach((r, i) => r.classList.toggle('home-sheet-target', i === to && i !== from));
      };
      row.classList.add('home-sheet-dragging');
      handle.setPointerCapture(ev.pointerId);
      handle.onpointermove = e => place(e.clientY);
      handle.onpointerup = handle.onpointercancel = () => {
        handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
        row.classList.remove('home-sheet-dragging');
        rows.forEach(r => r.classList.remove('home-sheet-target'));
        if (to === from) return;
        const next = keys.filter(x => x !== k);
        next.splice(to, 0, k);
        commit(next);
      };
    }
    button(label, fn, cls = '') {
      const b = el('button', 'dashboard-button ' + cls, label);
      b.type = 'button';
      b.onclick = e => {
        e.stopPropagation();
        fn();
      };
      return b;
    }
    async api(path) {
      const r = await fetch('/api/' + path, {
        headers: { 'X-Hyprland-Client': '1' },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
      });
      if (!r.ok) throw Error(HyprlandApps.host.name + ' unavailable');
      return r.json();
    }
    async poll() {
      if (this.busy || document.hidden) return;
      this.busy = true;
      try {
        const [herd, widgets] = await Promise.allSettled([
          this.api('herdr/snapshot'),
          this.api('widgets'),
        ]);
        if (herd.status === 'fulfilled') {
          this.snapshot = herd.value;
          this.online = true;
          this.drawHome();
          this.drawInbox();
        } else {
          this.online = false;
          this.drawHome();
          this.drawInbox();
        }
        if (widgets.status === 'fulfilled') {
          const m = widgets.value.metrics;
          if (m && !m.error) {
            const hours = Math.floor(m.uptime / 3600);
            this.hostLine(
              HyprlandApps.host.name,
              'up ' + Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h'
            );
            this.drawMetrics([
              ['cpu', m.cpu_percent, '%'],
              ['mem', (m.memory_used / m.memory_total) * 100, '%'],
              ['disk', (m.disk_used / m.disk_total) * 100, '%'],
              ['temp', m.temperature, '°C'],
            ]);
          } else {
            this.hostLine(HyprlandApps.host.name + ' · metrics unavailable');
            this.drawMetrics(null, 'Host metrics unavailable');
          }
        } else {
          this.hostLine(HyprlandApps.host.name + ' · disconnected');
          this.drawMetrics(null, 'Host metrics unavailable');
        }
      } finally {
        this.busy = false;
      }
    }
    // Four label/value cells with a 3px meter each; disk turns yellow past 80%.
    drawMetrics(cells, message) {
      this.metrics.replaceChildren(el('span', 'legend-title', 'host'));
      if (!cells) {
        this.metrics.append(el('p', 'dashboard-muted', message));
        return;
      }
      for (const [label, raw, unit] of cells) {
        const ok = Number.isFinite(raw),
          value = ok ? Math.round(raw) : null;
        const cell = el('div', 'home-metric');
        const line = el('div', 'home-metric-line');
        line.append(el('span', '', label), el('span', '', ok ? value + unit : '—'));
        const tone = label === 'disk' && ok && value > 80 ? 'yellow' : '';
        if (tone) line.dataset.tone = tone;
        const meter = el('div', 'meter'),
          fill = el('i');
        fill.style.width = (ok ? Math.max(0, Math.min(100, value)) : 0) + '%';
        if (tone) fill.dataset.tone = tone;
        meter.append(fill);
        cell.append(line, meter);
        this.metrics.append(cell);
      }
    }
    panes() {
      return this.snapshot ? HyprlandRemote.orderHerdr(this.snapshot).flatMap(w => w.panes) : [];
    }
    navigate(key, action) {
      if (!this.logic.state.open.includes(key) && this.logic.state.open.length >= 10) {
        this.logic.openApp(key);
        return;
      }
      this.pending = { key, action };
      this.logic.openApp(key);
    }
    openPane(p) {
      this.navigate('herdr', () => this.logic.remote.app('herdr')?.select(p.pane_id));
    }
    drawHome() {
      this.home.replaceChildren();
      const panes = this.panes(),
        waiting = panes.filter(p => group(p) === 'attention');
      const meta = el('span', 'legend-meta');
      if (this.online) {
        meta.append(
          document.createTextNode(panes.length + ' panes · '),
          el('em', '', panes.filter(p => group(p) === 'running').length + ' running')
        );
      } else meta.textContent = this.snapshot ? 'Disconnected' : 'Connecting…';
      this.home.append(
        this.button('herdr', () => this.logic.openApp('herdr'), 'legend-title'),
        meta
      );
      const badges = this.logic.state.badges || {};
      if ((badges.herdr || 0) !== waiting.length)
        this.logic.set({ badges: { ...badges, herdr: waiting.length } });
      for (const p of waiting.slice(0, 2))
        this.home.append(
          this.button('● ' + title(p) + ' · needs you', () => this.openPane(p), 'attention-preview')
        );
      if (!waiting.length)
        this.home.append(
          el(
            'div',
            'dashboard-muted',
            this.online
              ? 'No agents need your attention.'
              : this.snapshot
                ? 'Reconnect to see agent status.'
                : 'Connecting to Herd…'
          )
        );
    }
    eventKey(p) {
      return p.pane_id + ':' + p.state_change_seq + ':' + p.agent_status;
    }
    drawInbox() {
      const signature = JSON.stringify([
        this.online,
        this.muted,
        this.dismissed,
        this.panes().map(p => [this.eventKey(p), title(p)]),
      ]);
      if (signature === this.inboxSignature) return;
      this.inboxSignature = signature;
      const scroll = this.inbox.scrollTop;
      this.inbox.replaceChildren();
      const panes = this.panes().filter(
        p => group(p) === 'attention' && !this.dismissed.includes(this.eventKey(p))
      );
      const header = el('div', 'dashboard-line');
      header.append(
        el('span', '', `notifications · ${this.muted ? 0 : panes.length}`),
        this.button('clear all', () => {
          this.dismissed = [...this.dismissed, ...panes.map(p => this.eventKey(p))].slice(-500);
          save('omarchy-inbox-dismissed', this.dismissed);
          this.drawInbox();
        }),
        this.button('×', () => this.logic.set({ shade: null }))
      );
      this.inbox.append(header);
      const source = el('div', 'dashboard-line');
      source.append(
        el('span', 'dashboard-muted', 'HERD'),
        this.button(this.muted ? 'unmute' : 'mute', () => {
          this.muted = !this.muted;
          save('omarchy-inbox-muted', this.muted);
          this.drawInbox();
        })
      );
      this.inbox.append(source);
      if (!this.online)
        this.inbox.append(el('p', 'dashboard-muted', 'Disconnected · showing last known state.'));
      if (this.muted || !panes.length)
        this.inbox.append(
          el(
            'p',
            'dashboard-empty',
            this.muted ? 'Herd notifications are muted.' : 'You’re all caught up.'
          )
        );
      if (!this.muted)
        for (const p of panes) {
          const card = el('article', 'attention-card');
          card.append(
            el('div', 'dashboard-muted', title(p) + ' · ' + (p.agent || 'shell')),
            el('h3', '', 'waiting for you'),
            el(
              'p',
              'dashboard-muted',
              p.attention_kind === 'permission'
                ? 'Permission request · review in pane'
                : 'Open the pane to read and respond.'
            )
          );
          const actions = el('div', 'dashboard-actions');
          actions.append(
            this.button('open pane', () => this.openPane(p), 'primary'),
            this.button('dismiss', () => this.dismiss(p))
          );
          card.append(actions);
          let start;
          card.onpointerdown = e => (start = { x: e.clientX, y: e.clientY });
          card.onpointerup = e => {
            if (start && Math.abs(e.clientX - start.x) > 80 && Math.abs(e.clientY - start.y) < 40)
              this.dismiss(p);
            start = null;
          };
          this.inbox.append(card);
        }
      this.inbox.scrollTop = scroll;
    }
    dismiss(p) {
      this.dismissed.push(this.eventKey(p));
      this.dismissed = this.dismissed.slice(-500);
      save('omarchy-inbox-dismissed', this.dismissed);
      this.drawInbox();
    }
    buildLauncher() {
      const line = el('div', 'launcher-search-line');
      // The search is a prompt field: ❯ prefix, accent ring on focus, an `esc` keycap beside it.
      const field = el('div', 'prompt-field launcher-field');
      this.field = el('input', 'dashboard-search');
      this.field.type = 'search';
      this.field.setAttribute('aria-label', 'Search apps, panes and files');
      this.field.autocapitalize = 'none';
      this.field.autocomplete = 'off';
      this.field.spellcheck = false;
      this.field.setAttribute('autocorrect', 'off');
      field.append(el('span', 'prompt-prefix', '❯'), this.field);
      line.append(
        field,
        this.button('esc', () => this.logic.set({ launch: false, kb: false, query: '' }), 'keycap')
      );
      this.results = el('div', 'dashboard-results');
      this.hint = el('div', 'launcher-hint');
      for (const [prefix, label] of [
        ['/', 'files'],
        ['@', 'panes'],
        ['>', 'snippets'],
      ]) {
        const chip = this.button(
          '',
          () => {
            this.field.value = prefix;
            this.field.focus();
            this.field.oninput();
          },
          'keycap small launcher-scope'
        );
        chip.append(el('span', 'launcher-scope-prefix', prefix), label);
        chip.setAttribute('aria-label', `Search ${label}`);
        this.hint.append(chip);
      }
      this.hint.append(el('span', 'launcher-keys', '↑↓ · ⏎'));
      this.launch.append(line, this.results, this.hint);
      this.field.oninput = () => {
        ++this.seq;
        this.results.replaceChildren(el('p', 'dashboard-muted', 'Searching…'));
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.search(), 180);
      };
      this.field.onkeydown = e => {
        if (e.key === 'Escape') this.logic.set({ launch: false, kb: false });
        if (e.key === 'Enter') {
          e.preventDefault();
          this.results.querySelector('button')?.click();
        }
      };
      for (const root of [this.launch, this.inbox])
        for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend'])
          root.addEventListener(type, e => e.stopPropagation(), { passive: true });
    }
    async search() {
      const seq = (this.seq = (this.seq || 0) + 1);
      const raw = this.field.value.trim(),
        mode = raw[0],
        q = raw.replace(/^[@/>]\s*/, '').toLowerCase();
      this.results.replaceChildren();
      // Rows: a cursor bar marks the selection, a glyph carries the app's tile color,
      // and a kbd chip shows the SUPER binding (⏎ on the selected row).
      const add = (heading, items, limit = 6) => {
        if (!items.length) return;
        this.results.append(el('div', 'launcher-group', heading));
        for (const item of items.slice(0, limit)) {
          const b = this.button('', item.run, 'launcher-result');
          const body = el('div', 'launcher-body'),
            name = el('strong', '');
          if (item.glyph) {
            const g = el('span', 'nf launcher-glyph', item.glyph);
            g.style.color = item.color || '';
            name.append(g);
          }
          name.append(el('span', 'launcher-name', item.name));
          const detail = el('span', 'dashboard-muted');
          if (item.detail instanceof Node) detail.append(item.detail);
          else detail.textContent = item.detail;
          body.append(name, detail);
          b.append(el('i', 'launcher-mark'), body);
          const first = !this.results.querySelector('.launcher-result');
          b.append(el('span', 'kbd launcher-key', first ? '⏎' : item.key || ''));
          this.results.append(b);
        }
      };
      if (!['@', '/', '>'].includes(mode))
        add(
          'APPS',
          Object.entries(this.logic.APPS)
            .filter(
              ([k, a]) => !a.baseKey && (a.name + ' ' + a.description).toLowerCase().includes(q)
            )
            .map(([k, a]) => ({
              name: a.name,
              detail: k === 'herdr' ? this.herdrDetail(a.description) : a.description,
              glyph: a.icon || a.glyph,
              color: a.color,
              key: (k => (k ? 'super ' + k : ''))(a.superKeys.find(x => /^[a-z]$/.test(x))),
              run: () => this.logic.openApp(k),
            }))
        );
      if (!['@', '/', '>'].includes(mode))
        add('HOSTS', window.HyprlandHosts?.launcherItems(q) || [], 12);
      if (!['/', '>'].includes(mode))
        add(
          'PANES',
          this.panes()
            .filter(p => (title(p) + ' ' + p.agent + ' ' + p.cwd).toLowerCase().includes(q))
            .map(p => ({
              name: title(p),
              detail: (p.agent || 'shell') + ' · ' + p.agent_status,
              glyph: this.logic.APPS.herdr?.icon,
              color: this.logic.APPS.herdr?.color,
              run: () => this.openPane(p),
            }))
        );
      if (mode === '>') {
        const snippets = ['git status', 'systemctl --user status', 'df -h', 'uptime'];
        add(
          'SNIPPETS · INSERT INTO TERMINAL',
          snippets
            .filter(s => s.includes(q))
            .map(command => ({
              name: command,
              detail: 'Review and send',
              run: () => {
                this.navigate('terminal', () => {
                  this.logic.remote.keyboard();
                  const input = this.logic.remote.currentInput();
                  input.message = true;
                  input.draft = command;
                  input.configure();
                  input.focus();
                });
              },
            }))
        );
      }
      if (q.length >= 2 && !['@', '>'].includes(mode)) {
        try {
          const data = await this.api(
            'files/search?' +
              new URLSearchParams({
                path: '',
                query: q,
                mode: 'fuzzy',
                hidden: 'false',
                regex: 'false',
                sensitive: 'false',
                glob: '',
              })
          );
          if (seq !== this.seq || !this.logic.state.launch) return;
          add(
            'FILES',
            data.entries.map(e => ({
              name: e.name,
              detail: e.path,
              run: () => {
                this.navigate('files', () => this.logic.remote.app('files')?.open(e));
              },
            }))
          );
          if (data.truncated)
            this.results.append(
              el('p', 'dashboard-muted', 'Results limited · narrow your search.')
            );
        } catch {
          if (seq === this.seq)
            this.results.append(el('p', 'dashboard-muted', 'File search unavailable.'));
        }
      }
      if (seq === this.seq && !this.results.children.length)
        this.results.append(el('p', 'dashboard-empty', 'No matches.'));
    }
    // "agents · herdr · 2 running" with the running count in accent.
    herdrDetail(description) {
      const running = this.panes().filter(p =>
        /working|running|progress|busy/.test(p.agent_status || '')
      ).length;
      if (!running) return description;
      const frag = document.createDocumentFragment();
      frag.append(description + ' · ', el('em', 'launcher-running', running + ' running'));
      return frag;
    }
    update() {
      if (this.pending && this.logic.cur() === this.pending.key) {
        const { action } = this.pending;
        this.pending = null;
        action();
      }
      const open = this.logic.state.launch;
      mount('touch-shell').classList.toggle('dashboard-launch-open', open);
      if (open !== this.wasOpen) {
        this.wasOpen = open;
        if (open) {
          this.field.value = '';
          this.search();
          this.field.focus();
        } else {
          ++this.seq;
          this.field.blur();
        }
      }
    }
    dispose() {
      this.pinPanel?.remove();
      this.abort.abort();
      clearInterval(this.timer);
      clearTimeout(this.debounce);
      document.removeEventListener('visibilitychange', this.visibility);
    }
  }
  window.HyprlandDashboard = { attach: logic => new Dashboard(logic) };
})();
