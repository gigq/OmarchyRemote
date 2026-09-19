/* Local preferences are immediate; the host keeps one versioned backup per device. */
(() => {
  const { storage, node, button } = HyprlandUtil;
  const keys = [
    'omarchy-theme',
    'omarchy-wallpapers',
    'omarchy-home-pins',
    'omarchy-widgets',
    'omarchy-widget-current',
    'omarchy-weather-location',
    'omarchy-weather-unit-mode',
    'omarchy-codexbar-provider',
    'omarchy-herdr-fit',
    'omarchy-files-mode',
    'omarchy-inbox-dismissed',
    'omarchy-inbox-muted',
    'omarchy-layout-phone',
    'omarchy-layout-desk',
    'omarchy-focus-follows-pointer',
  ];
  const snapshot = () =>
    Object.fromEntries(keys.map(k => [k, storage.get(k)]).filter(([, v]) => v !== null));
  const initial = snapshot();
  const id =
    storage.get('omarchy-device-id') || window.__OMARCHY_DEVICE__?.id || crypto.randomUUID();
  storage.set('omarchy-device-id', id);
  const defaultName =
    window.__OMARCHY_DEVICE__?.name ||
    (/iPhone/.test(navigator.userAgent)
      ? 'iPhone'
      : /iPad/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ? 'iPad'
        : 'Browser');
  const hadName = !!storage.get('omarchy-device-name');
  let name = storage.get('omarchy-device-name') || defaultName;
  storage.set('omarchy-device-name', name);
  let inFlight = null;
  let ack = storage.read('omarchy-preferences-ack'),
    busy = false,
    applying = false,
    started = false,
    timer,
    logic,
    status = 'Waiting to back up',
    lastError = '',
    readyResolve;
  const ready = new Promise(resolve => (readyResolve = resolve));
  if (ack || Object.keys(initial).length) {
    started = true;
    readyResolve();
  }
  const request = async (path, body) => {
    if (location.protocol === 'file:') throw Error('Connect to the host to sync');
    const r = await fetch('/api/state' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Hyprland-Client': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });
    const v = await r.json();
    if (!r.ok) throw Error(v.error || 'Sync unavailable');
    return v;
  };
  const notify = () => window.dispatchEvent(new Event('hyprland-sync-status'));
  const changed = (current, base) =>
    Object.fromEntries(
      keys.filter(k => (current[k] ?? null) !== (base[k] ?? null)).map(k => [k, current[k] ?? null])
    );
  const writeValues = values => {
    applying = true;
    for (const k of keys) storage.set(k, typeof values[k] === 'string' ? values[k] : null);
    applying = false;
  };
  function sync() {
    if (inFlight) return inFlight;
    inFlight = performSync().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  async function performSync() {
    busy = true;
    try {
      const remote = await request('/devices/' + id);
      if (!remote.values || !Number.isInteger(remote.revision))
        throw Error('Settings backup unavailable');
      const current = snapshot(),
        base = ack?.values || {};
      // On a first launch, existing local choices migrate. Empty devices recover their own backup.
      const edits = changed(current, base);
      if (!ack && !started)
        for (const k of keys) if (!(k in initial) && !(k in current)) delete edits[k];
      let values = { ...remote.values };
      for (const [k, v] of Object.entries(edits)) {
        if (v === null) delete values[k];
        else values[k] = v;
      }
      const patch = changed(values, remote.values);
      const sentName =
        remote.name && ((!ack && !hadName) || (ack && name === ack.name)) ? remote.name : name;
      const saved =
        Object.keys(patch).length || !remote.revision || sentName !== remote.name
          ? await request('/devices/' + id, {
              name: sentName,
              revision: remote.revision,
              changes: patch,
            })
          : remote;
      // Preserve edits made during the request; they will be sent on the next pass.
      const during = changed(snapshot(), current);
      values = { ...saved.values };
      for (const [k, v] of Object.entries(during)) {
        if (v === null) delete values[k];
        else values[k] = v;
      }
      const different = Object.keys(changed(values, snapshot())).length > 0;
      writeValues(values);
      if (name === sentName || name === ack?.name || (!ack && !hadName)) {
        name = saved.name;
        storage.set('omarchy-device-name', name);
      }
      ack = {
        values: saved.values,
        name: saved.name,
        revision: saved.revision,
        updated_at: saved.updated_at,
      };
      storage.write('omarchy-preferences-ack', ack);
      status = Object.keys(during).length ? 'Changes waiting to back up' : 'Backed up';
      lastError = '';
      // Remote changes to this device are unusual (e.g. another window); apply them on next launch.
      if (different && started) {
        status = 'Backup restored · reload to apply';
        window.dispatchEvent(new Event('hyprland-preferences-restored'));
      }
    } catch (e) {
      status = 'Saved on this device · backup pending';
      lastError = e.message;
    } finally {
      busy = false;
      started = true;
      readyResolve();
      notify();
    }
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, 350);
  };
  window.addEventListener('hyprland-storage', e => {
    if (!applying && keys.includes(e.detail?.key)) {
      status = 'Changes waiting to back up';
      notify();
      schedule();
    }
  });
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
    else sync();
  });
  setInterval(() => {
    if (!document.hidden) sync();
  }, 10000);
  function layout(state) {
    const key = state.desk ? 'omarchy-layout-desk' : 'omarchy-layout-phone';
    const saved = storage.read(key);
    if (!saved || !Array.isArray(saved.open)) return {};
    const open = [
      'home',
      ...new Set(saved.open.filter(k => k !== 'home' && HyprlandApps.get(k))),
    ].slice(0, 10);
    const tiles = Object.fromEntries(
      open
        .filter(k => k !== 'home')
        .map((k, i) => [
          k,
          Number.isInteger(saved.tiles?.[k]) && saved.tiles[k] > 0 && saved.tiles[k] < 10
            ? saved.tiles[k]
            : i + 1,
        ])
    );
    const ws = Math.max(
      0,
      Math.min(
        Number.isInteger(saved.ws) ? saved.ws : 0,
        state.desk ? new Set(Object.values(tiles)).size : open.length - 1
      )
    );
    return {
      open,
      tiles,
      ws,
      focus: open.includes(saved.focus) ? saved.focus : null,
      full: Array.isArray(saved.full) ? saved.full.filter(k => open.includes(k)) : [],
    };
  }
  function bind(value) {
    logic = value;
    HyprlandThemes.restore?.();
    logic.set(layout(logic.state));
  }
  function update(value) {
    if (!started || !logic) return;
    const s = value.state;
    storage.write(s.desk ? 'omarchy-layout-desk' : 'omarchy-layout-phone', {
      open: s.open,
      tiles: s.tiles,
      ws: s.ws,
      focus: s.focus,
      full: s.full,
    });
  }
  function key(label, fn, aria, icon, cls = '') {
    const b = button(label, fn, 'keycap ' + cls);
    if (icon) {
      const glyph = node('span', 'nf', icon);
      glyph.setAttribute('aria-hidden', 'true');
      b.prepend(glyph);
    }
    b.setAttribute('aria-label', aria || label);
    return b;
  }
  function settings(root) {
    const section = node('section', 'device-settings legend');
    section.setAttribute('aria-label', 'Device settings');
    const state = node('span', 'legend-meta device-state');
    state.setAttribute('role', 'status');
    section.append(node('span', 'legend-title', 'this device'), state);
    const row = node('form', 'device-name-form'),
      field = node('label', 'prompt-field device-field'),
      input = node('input');
    input.value = name;
    input.maxLength = 80;
    input.required = true;
    input.setAttribute('aria-label', 'Device name');
    const save = key('save', () => {}, 'Save', null, 'small');
    save.type = 'submit';
    field.append(node('span', 'prompt-label', 'name'), input, save);
    row.append(field);
    row.onsubmit = e => {
      e.preventDefault();
      if (!input.value.trim()) return;
      name = input.value.trim();
      storage.set('omarchy-device-name', name);
      sync();
    };
    const problem = node('p', 'theme-note device-problem');
    const paint = () => {
      state.textContent = status.toLowerCase();
      state.classList.toggle('device-ok', status === 'Backed up');
      problem.textContent = lastError;
    };
    window.addEventListener('hyprland-sync-status', paint);
    paint();
    const actions = node('div', 'device-actions'),
      backups = node('div', 'device-backups');
    actions.append(
      key('back up now', sync, 'Back up now', '\uf093'),
      key('reload saved', () => location.reload(), 'Reload saved settings', '\uf021'),
      key(
        'restore…',
        async () => {
          backups.replaceChildren(node('p', 'theme-note', 'Loading backups…'));
          try {
            const data = await request('/devices');
            backups.replaceChildren();
            for (const d of data.devices) {
              const date = new Date(d.updated_at * 1000).toLocaleString();
              backups.append(
                key(
                  `${d.name} · ${date}`,
                  () => confirmRestore(d),
                  null,
                  null,
                  'small device-backup'
                )
              );
            }
            if (!data.devices.length) backups.append(node('p', 'theme-note', 'No backups yet.'));
          } catch (e) {
            backups.replaceChildren(node('p', 'theme-note', e.message));
          }
        },
        'Restore a device backup',
        '\uf019'
      )
    );
    function confirmRestore(d) {
      backups.replaceChildren(
        node(
          'p',
          'theme-note',
          `Replace this device’s appearance, Home layout, widgets and window arrangement with “${d.name}”? Shared apps and website logins stay as they are.`
        )
      );
      const choice = node('div', 'device-confirm');
      choice.append(
        key('cancel', () => backups.replaceChildren(), 'Cancel', null, 'small'),
        key(
          'restore and reload',
          async () => {
            try {
              const data = await request('/devices/' + d.id);
              if (!data.revision) throw Error('Backup no longer exists');
              writeValues(data.values);
              await sync();
              if (Object.keys(changed(snapshot(), ack?.values || {})).length) await sync();
              if (lastError) throw Error(lastError);
              location.reload();
            } catch (e) {
              problem.textContent = e.message;
            }
          },
          'Restore and reload',
          null,
          'small accent'
        )
      );
      backups.append(choice);
    }
    const focusRow = node('label', 'device-focus-option');
    const focusInput = node('input');
    focusInput.type = 'checkbox';
    focusInput.checked = storage.get('omarchy-focus-follows-pointer') === 'true';
    focusInput.onchange = () =>
      storage.set('omarchy-focus-follows-pointer', String(focusInput.checked));
    focusRow.append(focusInput, node('span', '', 'Focus follows pointer'));
    section.append(
      row,
      focusRow,
      node(
        'p',
        'theme-note',
        'Mouse or trackpad movement focuses the window underneath in desk mode. Saved for this device.'
      ),
      problem,
      actions,
      backups
    );
    root.append(section);
  }
  window.HyprlandPreferences = {
    ready,
    request,
    keys,
    id,
    bind,
    update,
    settings,
    sync,
    get status() {
      return status;
    },
  };
  sync();
})();
