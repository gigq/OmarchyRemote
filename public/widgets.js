(() => {
  const { node, mount } = window.HyprlandUtil;
  const storage = { get: window.HyprlandUtil.storage.read, set: window.HyprlandUtil.storage.write };
  const number = n => typeof n === 'number' && Number.isFinite(n);
  const percent = n => (number(n) ? Math.round(n) + '%' : '—');
  const bytes = n =>
    !number(n)
      ? '—'
      : n >= 1024 ** 4
        ? (n / 1024 ** 4).toFixed(1) + 'T'
        : n >= 1024 ** 3
          ? (n / 1024 ** 3).toFixed(1) + 'G'
          : n >= 1024 ** 2
            ? (n / 1024 ** 2).toFixed(1) + 'M'
            : n >= 1024
              ? (n / 1024).toFixed(0) + 'K'
              : Math.round(n) + 'B';
  const stamp = n =>
    number(n)
      ? new Date(n * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';
  const condition = c =>
    c === 0
      ? 'Clear'
      : c <= 3
        ? 'Cloudy'
        : [45, 48].includes(c)
          ? 'Fog'
          : c >= 95
            ? 'Thunderstorms'
            : (c >= 71 && c <= 77) || c === 85 || c === 86
              ? 'Snow'
              : (c >= 51 && c <= 67) || (c >= 80 && c <= 82)
                ? 'Rain'
                : 'Weather';
  class Widgets {
    constructor(logic) {
      this.logic = logic;
      this.roots = Object.fromEntries(
        ['weather', 'metrics', 'tailscale', 'codexbar'].map(k => {
          const root = node('div', 'home-widget widget-' + k);
          root.id = 'widget-' + k;
          return [k, root];
        })
      );
      this.deck = new HyprlandWidgetDeck(mount('home-widgets'), this.roots);
      this.location = storage.get('omarchy-weather-location');
      this.unitMode = storage.get('omarchy-weather-unit-mode') || 'auto';
      this.localeUnit = this.browserUnit();
      this.unit = this.unitMode === 'auto' ? this.localeUnit : this.unitMode;
      this.abort = new AbortController();
      this.clock = () => {
        const now = new Date();
        document.querySelectorAll('[data-live-time]').forEach(
          n =>
            (n.textContent = now.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }))
        );
        document.querySelectorAll('[data-live-date]').forEach(
          n =>
            (n.textContent = now.toLocaleDateString([], {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }))
        );
      };
      this.clock();
      this.refreshLocale();
      this.clockTimer = setInterval(this.clock, 1000);
      this.roots.codexbar.textContent = 'Reading CodexBar…';
      this.provider = storage.get('omarchy-codexbar-provider') || 'codex';
      this.roots.metrics.textContent = 'Connecting to host…';
      this.roots.tailscale.textContent = 'Reading Tailscale…';
      this.renderWeather();
      this.foreground = () => {
        this.clock();
        if (!document.hidden) {
          this.refreshLocale();
          this.poll();
        }
      };
      document.addEventListener('visibilitychange', this.foreground);
      window.addEventListener('online', this.foreground);
      // A host backup restored by persistence.js lands in storage; adopt it without a reload.
      this.restored = e => {
        const key = e.detail?.key;
        if (key === 'omarchy-weather-location') {
          const next = storage.get(key);
          if (JSON.stringify(next) === JSON.stringify(this.location)) return;
          this.location = next;
          this.weather = null;
          this.weatherError = null;
          this.nextWeather = 0;
          this.renderWeather();
          if (next) this.loadWeather();
        } else if (key === 'omarchy-weather-unit-mode') {
          const mode = storage.get(key) || 'auto';
          if (mode === this.unitMode) return;
          this.unitMode = mode;
          this.unit = mode === 'auto' ? this.localeUnit : mode;
          this.renderWeather();
        }
      };
      window.addEventListener('hyprland-storage', this.restored);
      this.poll();
      this.timer = setInterval(() => this.poll(), 3000);
    }
    update() {
      if (this.deck.panel && (this.logic.cur() !== 'home' || this.logic.state.ov))
        this.deck.close();
    }
    browserUnit() {
      try {
        const region = new Intl.Locale(navigator.language).maximize().region;
        return ['BS', 'BZ', 'KY', 'PR', 'PW', 'US'].includes(region) ? 'f' : 'c';
      } catch {
        return 'c';
      }
    }
    async refreshLocale() {
      const bridge = window.webkit?.messageHandlers?.weatherDevice;
      if (bridge)
        try {
          const result = await bridge.postMessage({ action: 'locale' });
          if (['c', 'f'].includes(result.unit)) this.localeUnit = result.unit;
        } catch {}
      else this.localeUnit = this.browserUnit();
      if (this.unitMode === 'auto' && this.unit !== this.localeUnit) {
        this.unit = this.localeUnit;
        this.renderWeather();
      }
    }
    setUnit(mode) {
      this.unitMode = mode;
      storage.set('omarchy-weather-unit-mode', mode);
      this.unit = mode === 'auto' ? this.localeUnit : mode;
      this.renderWeather();
    }
    async phoneLocation(requestPermission) {
      const bridge = window.webkit?.messageHandlers?.weatherDevice;
      if (bridge) return bridge.postMessage({ action: 'location', requestPermission });
      if (window.__HYPRLAND_NATIVE__) throw Error('Update the iPhone app to enable location.');
      if (!navigator.geolocation) throw Error('Location is unavailable. Choose a city instead.');
      if (!requestPermission) {
        const permission = await navigator.permissions?.query({ name: 'geolocation' });
        if (permission?.state !== 'granted') throw Error('Tap the location icon to enable access.');
      }
      return new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(
          p =>
            resolve({
              lat: Math.round(p.coords.latitude * 100) / 100,
              lon: Math.round(p.coords.longitude * 100) / 100,
              name: 'Current location',
            }),
          e =>
            reject(
              Error(
                e.code === 1
                  ? 'Location access is off. Allow it in Settings or choose a city.'
                  : 'Location unavailable. Try again or choose a city.'
              )
            ),
          { enableHighAccuracy: false, maximumAge: 300000, timeout: 15000 }
        )
      );
    }
    async api(path) {
      const response = await fetch('/api/' + path, {
        headers: { 'X-Hyprland-Client': '1' },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Unavailable');
      return data;
    }
    async poll() {
      if (this.busy || document.hidden || this.logic.cur() !== 'home' || this.logic.state.ov)
        return;
      this.busy = true;
      try {
        const data = await this.api('widgets');
        this.renderMetrics(data.metrics);
        this.renderTailscale(data.tailscale);
        this.renderCodexbar(data.codexbar);
        this.deck.refresh();
      } catch {
        for (const k of ['metrics', 'tailscale', 'codexbar']) {
          this.header(this.roots[k], k === 'metrics' ? 'btop' : k, '');
          this.roots[k].append(
            node('p', 'widget-muted', HyprlandApps.host.name + ' unavailable · reconnecting…')
          );
        }
      } finally {
        this.busy = false;
      }
      if (this.location && Date.now() > (this.nextWeather || 0)) this.loadWeather();
    }
    // Legend header: the title sits on the panel border, the detail (or a control) at the right.
    header(root, title, detail) {
      root.replaceChildren();
      const h = node('div', 'widget-line widget-legend');
      h.append(node('strong', '', title), node('span', 'widget-muted widget-truncate', detail));
      root.append(h);
    }
    renderCodexbar(data) {
      this.codexbar = data;
      const root = this.roots.codexbar;
      const p = data?.providers?.find(p => p.id === this.provider);
      this.header(root, 'CodexBar', '');
      root.firstChild.lastChild.replaceWith(
        this.button(this.provider === 'codex' ? 'Codex' : 'Claude', () => {
          this.provider = this.provider === 'codex' ? 'claude' : 'codex';
          storage.set('omarchy-codexbar-provider', this.provider);
          this.renderCodexbar(this.codexbar);
        })
      );
      if (!p) {
        root.append(node('p', 'widget-muted', 'Loading usage…'));
        return;
      }
      if (!p.windows?.length) {
        root.append(node('p', 'widget-muted', p.error || 'No usage limits reported'));
        return;
      }
      const list = node('div', 'codexbar-windows');
      for (const w of p.windows) {
        const row = node('div', 'codexbar-window');
        const reset = Date.parse(w.resets_at),
          minutes = Math.max(0, Math.ceil((reset - Date.now()) / 60000));
        const used = w.used_percent;
        const line = node('div', 'widget-line');
        const usage = node('span', 'codexbar-usage');
        usage.append(
          node('strong', '', percent(used)),
          node(
            'span',
            'widget-muted codexbar-reset',
            ' used · ' +
              (Number.isFinite(reset)
                ? 'resets ' +
                  (minutes >= 1440
                    ? Math.floor(minutes / 1440) + 'd ' + Math.floor((minutes % 1440) / 60) + 'h'
                    : minutes >= 60
                      ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'
                      : minutes + 'm')
                : 'reset —')
          )
        );
        line.append(node('span', 'widget-truncate', w.label.replace(/^Codex /, '')), usage);
        const track = node('div', 'metric-track'),
          bar = node('i');
        bar.style.width = Math.max(0, Math.min(100, used)) + '%';
        bar.style.background =
          used >= 90
            ? 'var(--theme-red)'
            : used >= 75
              ? 'var(--theme-yellow)'
              : 'var(--theme-accent)';
        track.append(bar);
        row.append(line, track);
        list.append(row);
      }
      for (const type of ['pointerdown', 'touchstart', 'touchmove', 'touchend'])
        list.addEventListener(type, e => e.stopPropagation(), { passive: true });
      root.append(list);
      root.append(
        node(
          'div',
          'widget-muted',
          (p.error ? 'Unavailable · last update ' : 'Updated ') +
            (p.updated_at ? stamp(Date.parse(p.updated_at) / 1000) : '—')
        )
      );
    }
    renderMetrics(m) {
      const root = this.roots.metrics;
      this.header(root, 'btop', m?.host || HyprlandApps.host.name);
      if (!m || m.error) {
        root.append(node('p', 'widget-muted', m?.error || 'Unavailable'));
        return;
      }
      const up = Math.floor(m.uptime / 3600);
      const uptime =
        up >= 24
          ? Math.floor(up / 24) + 'd ' + (up % 24) + 'h'
          : up + 'h ' + (Math.floor(m.uptime / 60) % 60) + 'm';
      const info = `${m.cores} cores${number(m.temperature) ? ' · ' + Math.round(m.temperature) + '°C' : ''} · up ${uptime}`;
      root.append(node('div', 'widget-muted', info));
      for (const [name, value, label, color] of [
        ['cpu', m.cpu_percent, percent(m.cpu_percent), 'green'],
        [
          'mem',
          (100 * m.memory_used) / m.memory_total,
          bytes(m.memory_used) + ' / ' + bytes(m.memory_total),
          'magenta',
        ],
        [
          'disk',
          (100 * m.disk_used) / m.disk_total,
          bytes(m.disk_used) + ' / ' + bytes(m.disk_total),
          'red',
        ],
      ]) {
        const row = node('div', 'metric-row');
        const track = node('div', 'metric-track'),
          fill = node('i');
        fill.style.width = (number(value) ? Math.min(100, Math.max(0, value)) : 0) + '%';
        fill.style.background = `var(--theme-${color})`;
        track.append(fill);
        row.append(node('span', '', name), track, node('span', 'metric-value', label));
        root.append(row);
      }
      const foot = node('div', 'widget-line widget-muted');
      foot.append(
        node('span', '', `↓${bytes(m.rx_bps)}/s ↑${bytes(m.tx_bps)}/s`),
        node('span', '', `${m.processes ?? '—'} procs · ${stamp(m.updated_at)}`)
      );
      root.append(foot);
    }
    renderTailscale(t) {
      const root = this.roots.tailscale;
      const scroll = root.querySelector('.tailscale-peers')?.scrollTop || 0;
      this.header(
        root,
        'tailscale',
        t?.error ? 'Unavailable' : t?.state === 'Running' ? 'connected' : t?.state || 'unknown'
      );
      if (!t || t.error) {
        root.append(node('p', 'widget-muted', t?.error || 'Unavailable'));
        return;
      }
      root.append(
        node(
          'div',
          'widget-muted widget-truncate',
          `${t.host || HyprlandApps.host.name} · ${t.ip || 'No address'}`
        )
      );
      const peers = node('div', 'tailscale-peers');
      for (const p of t.peers || []) {
        const row = node('div', 'tailscale-peer');
        const dot = node('i');
        dot.style.background = p.online ? 'var(--theme-green)' : 'var(--theme-dim)';
        row.append(
          dot,
          node('span', 'widget-truncate', p.name),
          node('span', 'widget-muted', p.online ? 'online' : 'offline')
        );
        peers.append(row);
      }
      if (!t.peers?.length) peers.append(node('span', 'widget-muted', 'No peers'));
      for (const type of ['pointerdown', 'touchstart', 'touchmove', 'touchend'])
        peers.addEventListener(type, e => e.stopPropagation(), { passive: true });
      root.append(peers);
      peers.scrollTop = scroll;
      root.append(
        node(
          'div',
          'widget-muted',
          `${(t.peers || []).filter(p => p.online).length}/${t.peers?.length || 0} online · DNS ${t.magic_dns ? 'on' : 'off'} · exit ${t.exit_node || 'none'}`
        )
      );
    }
    temp(n) {
      return number(n) ? Math.round(this.unit === 'f' ? (n * 9) / 5 + 32 : n) + '°' : '—';
    }
    button(label, fn) {
      const b = node('button', 'widget-button', label);
      b.type = 'button';
      b.onclick = e => {
        e.stopPropagation();
        fn();
      };
      b.onpointerdown = e => e.stopPropagation();
      return b;
    }
    renderWeather() {
      const root = this.roots.weather,
        w = this.weather;
      root.replaceChildren();
      if (w) {
        const top = node('div', 'weather-top');
        const current = node('div', 'weather-current');
        current.append(
          node('span', 'weather-temperature', this.temp(w.current?.temperature_2m)),
          this.button(this.unit === 'c' ? '°C' : '°F', () => {
            this.setUnit(this.unit === 'c' ? 'f' : 'c');
          }),
          node('span', 'weather-condition', condition(w.current?.weather_code))
        );
        const place = node('div', 'weather-place');
        const city = this.button(
          (this.location.source === 'phone' ? '⌖ ' : '') + this.location.name,
          () => this.chooseCity()
        );
        city.classList.add('weather-city');
        city.setAttribute('aria-label', 'Change city');
        place.append(
          city,
          node(
            'span',
            'widget-muted',
            `↑ ${this.temp(w.daily?.temperature_2m_max?.[0])} · ↓ ${this.temp(w.daily?.temperature_2m_min?.[0])}`
          )
        );
        top.append(current, place);
        root.append(top);
        const hours = node('div', 'weather-hours');
        const times = w.hourly?.time || [];
        const next = times.findIndex(t => t >= Date.now() / 1000),
          start = next < 0 ? times.length : next;
        const low = w.daily?.temperature_2m_min?.[0],
          high = w.daily?.temperature_2m_max?.[0];
        for (
          let i = start;
          i < Math.min(times.length, start + (this.logic?.state?.desk ? 12 : 6));
          i++
        ) {
          const temperature = w.hourly.temperature_2m[i],
            h = node('div', 'weather-hour');
          const track = node('div', 'weather-bar'),
            fill = node('i');
          const ratio =
            number(temperature) && number(low) && number(high)
              ? Math.max(0, Math.min(1, (temperature - low) / Math.max(1, high - low)))
              : 0;
          fill.style.height = 20 + ratio * 80 + '%';
          fill.style.background =
            ratio > 0.6
              ? 'var(--theme-yellow)'
              : ratio < 0.3
                ? 'var(--theme-green)'
                : 'var(--theme-secondary)';
          track.append(fill);
          h.append(
            node(
              'span',
              'widget-muted',
              new Date(times[i] * 1000).toLocaleTimeString([], {
                hour: 'numeric',
                timeZone: w.timezone,
              })
            ),
            track,
            node('strong', '', this.temp(temperature))
          );
          hours.append(h);
        }
        root.append(hours);
      } else {
        this.header(root, 'weather', this.location?.name || 'Choose a location');
        root.append(
          node(
            'p',
            'widget-muted',
            this.weatherError ||
              (this.location ? 'Loading forecast…' : 'Set your city for a live forecast.')
          )
        );
      }
      const foot = node('div', 'widget-line');
      const link = node(
        'a',
        'widget-muted',
        this.weatherError && w
          ? 'Offline · ' + stamp(w.fetched_at)
          : 'Open-Meteo' + (w ? ' · ' + stamp(w.fetched_at) : '')
      );
      link.href = 'https://open-meteo.com/';
      link.target = '_blank';
      link.rel = 'noopener';
      foot.append(link);
      if (w) {
        const probability = w.hourly?.precipitation_probability?.find(
          (_, i) => w.hourly.time[i] >= Date.now() / 1000
        );
        foot.append(
          node(
            'span',
            'widget-muted',
            `wind ${Math.round(w.current?.wind_speed_10m || 0)} km/h${number(probability) ? ' · rain ' + probability + '%' : ''}`
          )
        );
      } else
        foot.append(
          this.button(this.location ? 'Change city' : 'Choose city', () => this.chooseCity())
        );
      root.append(foot);
    }
    async loadWeather() {
      if (this.weatherBusy || !this.location) return;
      this.weatherBusy = true;
      const location = this.location;
      this.nextWeather = Date.now() + 60000;
      try {
        if (location.source === 'phone' && Date.now() - (location.locatedAt || 0) > 15 * 60000) {
          // Refreshing the fix is best effort: a saved location keeps its forecast when the
          // device declines a silent request (permission pending, no signal). Only the
          // picker's own button asks for access again.
          try {
            const fix = await this.phoneLocation(false);
            if (this.location !== location) return;
            Object.assign(location, fix, { locatedAt: Date.now() });
            storage.set('omarchy-weather-location', location);
          } catch {
            if (this.location !== location) return;
          }
        }
        const w = await this.api(
          `widgets/weather?lat=${encodeURIComponent(location.lat)}&lon=${encodeURIComponent(location.lon)}`
        );
        if (this.location !== location) return;
        this.weather = w;
        this.weatherError = null;
        this.nextWeather = Date.now() + 15 * 60000;
      } catch {
        this.weatherError = 'Weather unavailable · retrying…';
      } finally {
        this.weatherBusy = false;
        this.renderWeather();
      }
    }
    chooseCity() {
      this.picker?.remove();
      const panel = node('section', 'weather-picker');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Weather location');
      this.picker = panel;
      const header = node('div', 'widget-line');
      header.append(
        node('strong', '', 'Weather location'),
        this.button('Done', () => panel.remove())
      );
      panel.append(header);
      const form = node('form', 'weather-search');
      const input = node('input');
      input.placeholder = 'City name';
      input.setAttribute('aria-label', 'City name');
      input.autocomplete = 'off';
      const submit = node('button', 'widget-button', 'Search');
      submit.type = 'submit';
      const locate = this.button('', async () => {
        input.blur();
        locate.disabled = true;
        results.textContent = 'Finding your location…';
        try {
          const fix = await this.phoneLocation(true);
          if (!panel.isConnected) return;
          this.location = { ...fix, source: 'phone', locatedAt: Date.now() };
          storage.set('omarchy-weather-location', this.location);
          this.weather = null;
          this.weatherError = null;
          this.nextWeather = 0;
          panel.remove();
          this.renderWeather();
          this.loadWeather();
        } catch (e) {
          results.textContent = String(e.message || e);
        } finally {
          locate.disabled = false;
        }
      });
      locate.classList.add('weather-locate');
      locate.setAttribute('aria-label', 'Use phone location');
      locate.title = 'Use phone location';
      locate.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></svg>';
      form.append(input, locate, submit);
      panel.append(form);
      const units = node('label', 'weather-units', 'Temperature');
      const select = node('select');
      select.setAttribute('aria-label', 'Temperature units');
      for (const [value, label] of [
        ['auto', 'Automatic (' + (this.localeUnit === 'f' ? '°F' : '°C') + ')'],
        ['c', 'Celsius'],
        ['f', 'Fahrenheit'],
      ]) {
        const option = node('option', '', label);
        option.value = value;
        select.append(option);
      }
      select.value = this.unitMode;
      select.onchange = () => this.setUnit(select.value);
      units.append(select);
      panel.append(units);
      const results = node('div', 'weather-results');
      results.setAttribute('aria-live', 'polite');
      panel.append(results);
      form.onsubmit = async e => {
        e.preventDefault();
        const name = input.value.trim();
        if (name.length < 2) return;
        input.blur();
        submit.disabled = true;
        results.textContent = 'Searching…';
        try {
          const data = await this.api('widgets/cities?name=' + encodeURIComponent(name));
          results.replaceChildren();
          for (const c of data.results) {
            const label = [c.name, c.admin1, c.country].filter(Boolean).join(', ');
            results.append(
              this.button(label, () => {
                this.location = { name: c.name, lat: c.latitude, lon: c.longitude, source: 'city' };
                storage.set('omarchy-weather-location', this.location);
                this.weather = null;
                this.weatherError = null;
                this.nextWeather = 0;
                panel.remove();
                this.renderWeather();
                this.loadWeather();
              })
            );
          }
          if (!data.results.length) results.textContent = 'No cities found. Try a nearby city.';
        } catch {
          results.textContent = 'Search unavailable. Try again.';
        } finally {
          submit.disabled = false;
        }
      };
      for (const type of [
        'pointerdown',
        'pointerup',
        'touchstart',
        'touchmove',
        'touchend',
        'click',
      ])
        panel.addEventListener(type, e => e.stopPropagation());
      mount('touch-shell').append(panel);
    }
    dispose() {
      this.deck.dispose();
      this.abort.abort();
      clearInterval(this.clockTimer);
      clearInterval(this.timer);
      document.removeEventListener('visibilitychange', this.foreground);
      window.removeEventListener('online', this.foreground);
      window.removeEventListener('hyprland-storage', this.restored);
      this.picker?.remove();
    }
  }
  window.HyprlandWidgets = { attach: logic => new Widgets(logic) };
})();
