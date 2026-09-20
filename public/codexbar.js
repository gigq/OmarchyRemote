/* CodexBar owns both its full app and its compact Home widget. */
(() => {
  const { node, button, storage } = HyprlandUtil;
  const selected = () => {
    const value = storage.get('omarchy-codexbar-provider');
    return ['codex', 'claude'].includes(value) ? value : 'codex';
  };
  const name = id => ({ codex: 'Codex', claude: 'Claude' })[id] || id;
  const label = text =>
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .replace(/^./, c => c.toUpperCase());
  const date = value =>
    Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not reported';
  const until = value => {
    const delta = Date.parse(value) - Date.now();
    if (!Number.isFinite(delta)) return 'Not reported';
    if (delta <= 0) return 'Due now';
    const minutes = Math.ceil(delta / 60000);
    return minutes >= 1440
      ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
  };
  function windows(root, rows, compact = false) {
    const list = node('div', compact ? 'codexbar-windows' : 'usage-windows');
    if (!rows?.length) list.append(node('p', 'widget-muted', 'No usage limits reported'));
    for (const w of rows || []) {
      const row = node('section', compact ? 'codexbar-window' : 'usage-card');
      const line = node('div', 'widget-line');
      line.append(
        node('span', 'widget-truncate', w.label || 'Usage'),
        node(
          'strong',
          '',
          Number.isFinite(w.used_percent) ? Math.round(w.used_percent) + '% used' : 'Unavailable'
        )
      );
      const bar = node('progress');
      bar.max = 100;
      bar.value = Number.isFinite(w.used_percent) ? w.used_percent : 0;
      bar.hidden = !Number.isFinite(w.used_percent);
      bar.setAttribute('aria-label', (w.label || 'Usage') + ' used');
      row.append(line, bar, node('small', 'widget-muted', 'Resets ' + until(w.resets_at)));
      if (!compact && w.resets_at) row.append(node('small', 'widget-muted', date(w.resets_at)));
      list.append(row);
    }
    root.append(list);
  }
  const bank = provider => provider?.details?.usage?.codexResetCredits;
  function widget(root, data, { error } = {}) {
    const providers = data?.providers || [];
    const id = selected();
    const p = providers.find(p => p.id === id);
    root.replaceChildren();
    const head = node('div', 'widget-line widget-legend');
    const toggle = button(
      name(id),
      () => {
        const choices = providers.length ? providers.map(p => p.id) : ['codex', 'claude'];
        storage.set(
          'omarchy-codexbar-provider',
          choices[(choices.indexOf(id) + 1) % choices.length]
        );
        widget(root, data);
      },
      'widget-button'
    );
    head.append(node('strong', '', 'CodexBar'), toggle);
    root.append(head);
    if (!p) {
      root.append(node('p', 'widget-muted', error || 'Loading usage…'));
      return;
    }
    windows(root, p.windows, true);
    if (bank(p))
      root.append(node('small', 'widget-muted', bank(p).availableCount + ' banked resets'));
    root.append(
      node(
        'small',
        'widget-muted',
        p.error ? 'Unavailable · showing last known data' : 'Updated ' + date(p.updated_at)
      )
    );
  }
  // Expandable telemetry retains secondary fields without turning the main screen into JSON.
  function fields(value, title, depth = 0) {
    const group = node('details', 'usage-details');
    group.append(node('summary', '', title));
    if (depth === 0) group.open = true;
    for (const [key, item] of Object.entries(value || {})) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'object') {
        if (Object.keys(item).length)
          group.append(
            fields(item, Array.isArray(value) ? `Item ${Number(key) + 1}` : label(key), depth + 1)
          );
      } else {
        const row = node('div', 'usage-field');
        const formatted =
          typeof item === 'boolean'
            ? item
              ? 'Yes'
              : 'No'
            : typeof item === 'number'
              ? item.toLocaleString()
              : item;
        row.append(node('span', '', label(key)), node('span', '', formatted));
        group.append(row);
      }
    }
    return group;
  }
  class CodexBar {
    constructor(root) {
      this.root = root;
      root.classList.add('codexbar-app');
      this.abort = new AbortController();
      this.bar = node('div', 'usage-toolbar');
      this.select = node('select');
      this.select.setAttribute('aria-label', 'Usage provider');
      for (const id of ['codex', 'claude']) {
        const option = node('option', '', name(id));
        option.value = id;
        this.select.append(option);
      }
      this.select.value = selected();
      this.select.onchange = () => {
        storage.set('omarchy-codexbar-provider', this.select.value);
        this.draw();
      };
      this.refresh = button('Refresh', () => this.poll(), 'remote-button');
      this.status = node('span', 'widget-muted');
      this.status.setAttribute('role', 'status');
      this.bar.append(this.select, this.status, this.refresh);
      this.body = node('div', 'usage-body');
      root.append(this.bar, this.body);
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend'])
        root.addEventListener(type, e => e.stopPropagation(), {
          passive: true,
          signal: this.abort.signal,
        });
      this.timer = setInterval(() => {
        if (this.visible && !document.hidden) this.poll();
      }, 30000);
      this.clock = setInterval(() => {
        if (this.visible && !document.hidden) this.draw();
      }, 60000);
    }
    connect() {
      this.poll();
    }
    resume() {
      this.poll();
    }
    show(visible) {
      if (visible && !this.visible) {
        this.select.value = selected();
        this.poll();
      }
      this.visible = visible;
    }
    async poll() {
      if (this.busy) return;
      this.busy = true;
      this.refresh.disabled = true;
      this.status.textContent = 'Refreshing…';
      try {
        const response = await fetch('/api/codexbar', {
          headers: { 'X-Hyprland-Client': '1' },
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw Error('Host unavailable');
        this.data = await response.json();
        this.error = null;
      } catch {
        if (this.abort.signal.aborted) return;
        this.error = 'Host unavailable · retrying';
      } finally {
        this.busy = false;
        this.refresh.disabled = false;
      }
      this.draw();
    }
    draw() {
      const p = this.data?.providers?.find(p => p.id === this.select.value);
      this.status.textContent =
        this.error || (p?.error ? 'Showing last known data' : 'Host checks every 5 min');
      const scroll = this.body.scrollTop;
      const expanded = new Map(
        [...this.body.querySelectorAll('details')].map(n => [n.firstChild.textContent, n.open])
      );
      this.body.replaceChildren();
      if (!p) {
        this.body.append(
          node('p', 'widget-muted', this.error || 'Waiting for the host’s first CodexBar sample…')
        );
        return;
      }
      if (p.error)
        this.body.append(
          node('p', 'usage-warning', p.error + ' · last update ' + date(p.updated_at))
        );
      windows(this.body, p.windows);
      const resets = bank(p);
      if (resets) {
        const section = node('section', 'usage-card usage-resets');
        section.append(
          node('h2', '', 'Banked resets'),
          node('strong', 'usage-total', `${resets.availableCount ?? '—'} reported available`)
        );
        for (const credit of resets.credits || []) {
          const row = node('article', 'usage-reset');
          const expired = credit.expires_at && Date.parse(credit.expires_at) <= Date.now();
          row.append(
            node('h3', '', credit.title || label(credit.reset_type || 'Reset')),
            node(
              'span',
              'usage-badge',
              expired && credit.status === 'available'
                ? 'Expired'
                : label(credit.status || 'Unknown')
            )
          );
          if (credit.description) row.append(node('p', 'widget-muted', credit.description));
          row.append(
            node(
              'p',
              '',
              credit.expires_at
                ? (expired ? 'Expired ' : 'Expires in ' + until(credit.expires_at) + ' · ') +
                    date(credit.expires_at)
                : 'No expiry reported'
            )
          );
          if (credit.granted_at)
            row.append(node('small', 'widget-muted', 'Granted ' + date(credit.granted_at)));
          section.append(row);
        }
        section.append(
          node('small', 'widget-muted', 'Reported ' + date(resets.updatedAt) + ' · read-only')
        );
        this.body.append(section);
      } else
        this.body.append(node('p', 'widget-muted', 'Banked resets not reported by this provider.'));
      const details = p.details || {};
      if (details.credits) {
        const card = node('section', 'usage-card');
        card.append(
          node('h2', '', 'Credits'),
          node(
            'strong',
            'usage-total',
            details.credits.balanceReadSucceeded === false || details.credits.remaining == null
              ? 'Balance unavailable'
              : details.credits.remaining.toLocaleString() + ' remaining'
          )
        );
        card.append(fields(details.credits, 'Credit details'));
        this.body.append(card);
      }
      if (details.status) this.body.append(fields(details.status, 'Service status'));
      if (details.pace) this.body.append(fields(details.pace, 'Usage pace'));
      if (details.usage) this.body.append(fields(details.usage, 'All usage details'));
      const cost = this.data?.costs?.find(c => c.provider === p.id);
      if (this.data?.cost_error || cost?.error)
        this.body.append(
          node(
            'p',
            'usage-warning',
            (this.data.cost_error || cost.error) + (cost ? ' · last known history below' : '')
          )
        );
      if (cost) this.body.append(fields(cost, 'Token costs · local estimates'));
      else this.body.append(node('p', 'widget-muted', 'Cost history not yet available.'));
      this.body.append(
        node(
          'p',
          'widget-muted',
          [details.source, details.version, 'Updated ' + date(p.updated_at)]
            .filter(Boolean)
            .join(' · ')
        )
      );
      for (const detail of this.body.querySelectorAll('details'))
        if (expanded.has(detail.firstChild.textContent))
          detail.open = expanded.get(detail.firstChild.textContent);
      this.body.scrollTop = scroll;
    }
    dispose() {
      this.abort.abort();
      clearInterval(this.timer);
      clearInterval(this.clock);
    }
  }
  HyprlandApps.provide('codexbar', {
    create: root => new CodexBar(root),
    widgets: [{ key: 'codexbar', name: 'CodexBar', source: 'codexbar', render: widget }],
  });
})();
