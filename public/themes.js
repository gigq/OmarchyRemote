/* Shared semantic colors for the shell, host adapters and ANSI renderer. */
(() => {
  const prototype = {
    id: 'prototype',
    name: 'Prototype',
    colors: {
      mode: 'dark',
      background: '#191724',
      dark_background: '#15131f',
      lighter_background: '#1f1d2e',
      darker_background: '#26233a',
      selection: '#403d52',
      foreground: '#e0def4',
      light_foreground: '#908caa',
      dark_foreground: '#6e6a86',
      accent: '#3e8fb0',
      red: '#eb6f92',
      yellow: '#f6c177',
      cyan: '#ebbcba',
      green: '#9ccfd8',
      magenta: '#c4a7e7',
      blue: '#31748f',
      bright_foreground: '#ffffff',
    },
  };
  // Backgrounds are generated per host by scripts/import-themes.py and may be absent.
  const wallpaperCatalog = window.OmarchyBackgroundCatalog || {};
  const catalog = [prototype, ...window.OmarchyThemeCatalog].map(theme => ({
    ...theme,
    backgrounds: wallpaperCatalog[theme.id] || [],
  }));
  const assetURL = path => (location.protocol === 'file:' ? '.' + path : path);
  let current = prototype;
  let wallpapers;
  try {
    wallpapers = JSON.parse(localStorage.getItem('omarchy-wallpapers') || '{}');
  } catch {}
  if (!wallpapers || typeof wallpapers !== 'object' || Array.isArray(wallpapers)) wallpapers = {};
  function background(id, persist = true) {
    const choices = current.backgrounds || [];
    const selected = id === 'none' ? null : choices.find(b => b.id === id) || choices[0];
    const value = selected?.id || 'none';
    document.documentElement.style.setProperty(
      '--theme-wallpaper',
      selected ? `url("${assetURL(selected.url)}")` : 'none'
    );
    document.documentElement.dataset.background = value;
    if (persist) {
      wallpapers[current.id] = value;
      try {
        HyprlandUtil.storage.write('omarchy-wallpapers', wallpapers);
      } catch {}
    }
    document.querySelectorAll('[data-background-choice]').forEach(b => {
      const on = b.dataset.backgroundChoice === value;
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.settings-check').textContent = on ? '✓' : '';
    });
  }
  function card(cls, name) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', name);
    const label = document.createElement('div');
    label.className = 'settings-card-label';
    const text = document.createElement('span');
    text.textContent = name;
    const check = document.createElement('span');
    check.className = 'settings-check';
    check.setAttribute('aria-hidden', 'true');
    label.append(text, check);
    return { button: b, label };
  }
  function legend(cls, title) {
    const panel = document.createElement('section');
    panel.className = cls + ' legend';
    const head = document.createElement('span');
    head.className = 'legend-title';
    head.textContent = title;
    const meta = document.createElement('span');
    meta.className = 'legend-meta';
    panel.append(head, meta);
    return { panel, meta };
  }
  function drawBackgrounds() {
    const grid = document.querySelector('.background-grid');
    if (!grid) return;
    grid.replaceChildren();
    for (const item of [{ id: 'none', name: 'Solid color' }, ...(current.backgrounds || [])]) {
      const { button: b, label } = card('background-choice', item.name);
      b.dataset.backgroundChoice = item.id;
      const preview = document.createElement(item.thumbnail ? 'img' : 'span');
      if (item.thumbnail) {
        preview.src = assetURL(item.thumbnail);
        preview.alt = '';
        preview.loading = 'lazy';
      } else preview.className = 'background-swatch';
      b.append(preview, label);
      b.onclick = () => background(item.id);
      grid.append(b);
    }
    background(wallpapers[current.id], false);
  }
  const ansiKeys = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ];
  function terminalTheme() {
    const c = current.colors,
      result = {
        background: c.dark_background || c.background,
        foreground: c.foreground,
        cursor: c.accent,
        selectionBackground: c.selection,
        black: c.darker_background || c.background,
        white: c.foreground,
        brightBlack: c.dark_foreground,
        brightWhite: c.bright_foreground || c.foreground,
      };
    for (const key of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
      result[key] = c[key];
      result['bright' + key[0].toUpperCase() + key.slice(1)] = c['bright_' + key] || c[key];
    }
    if (current === prototype)
      Object.assign(result, {
        cyan: '#9ccfd8',
        cursor: '#ebbcba',
        brightRed: '#ff0000',
        brightGreen: '#00ff00',
        brightYellow: '#ffff00',
        brightBlue: '#0000ff',
        brightMagenta: '#ff00ff',
        brightCyan: '#00ffff',
      });
    return result;
  }
  function apply(id, persist = true) {
    current = catalog.find(t => t.id === id) || prototype;
    const c = current.colors,
      vars = {
        background: c.background,
        terminal: c.dark_background || c.background,
        surface: c.lighter_background || c.background,
        'surface-raised': c.darker_background || c.selection,
        border: c.selection,
        foreground: c.foreground,
        secondary: c.light_foreground || c.foreground,
        dim: c.dark_foreground || c.foreground,
        red: c.red,
        yellow: c.yellow,
        rose: c.cyan,
        green: c.green,
        magenta: c.magenta,
        accent: c.accent,
        blue: c.blue,
        cyan: c.cyan,
        mode: c.mode || 'dark',
      };
    if (current === prototype) vars.cyan = '#56949f';
    for (const [name, value] of Object.entries(vars))
      document.documentElement.style.setProperty('--theme-' + name, value);
    document.documentElement.dataset.theme = current.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.background);
    if (persist)
      try {
        HyprlandUtil.storage.set('omarchy-theme', current.id);
      } catch {}
    background(wallpapers[current.id], false);
    drawBackgrounds();
    refresh();
    window.dispatchEvent(new Event('hyprland-theme-change'));
  }
  function refresh() {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', current.colors.background);
    document
      .querySelectorAll('[data-theme-for]')
      .forEach(n => (n.textContent = 'for ' + current.name));
    document.querySelectorAll('[data-theme-choice]').forEach(b => {
      const selected = b.dataset.themeChoice === current.id;
      b.setAttribute('aria-pressed', String(selected));
      b.querySelector('.settings-check').textContent = selected ? '✓' : '';
    });
  }
  function attach(host) {
    host = host || [...document.querySelectorAll('#theme-settings')].find(n => !n.closest('x-dc'));
    if (!host || host.childElementCount) return;
    const head = document.createElement('header');
    head.className = 'settings-head';
    const title = document.createElement('h2');
    title.textContent = 'Settings';
    const hostName = document.createElement('span');
    hostName.className = 'settings-host';
    const paintHost = () => (hostName.textContent = window.HyprlandApps?.host?.name || '');
    document.addEventListener('hyprland-host', paintHost);
    paintHost();
    head.append(title, hostName);
    const themes = legend('theme-panel', 'theme');
    themes.meta.dataset.themeName = '';
    themes.meta.classList.add('settings-current');
    const grid = document.createElement('div');
    grid.className = 'theme-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Choose a theme');
    themes.panel.append(grid);
    for (const t of catalog) {
      const c = t.colors,
        { button: b, label } = card('theme-choice', t.name);
      b.dataset.themeChoice = t.id;
      b.style.setProperty('--preview-bg', c.background);
      b.style.setProperty('--preview-fg', c.foreground);
      b.style.setProperty('--preview-accent', c.accent);
      const preview = document.createElement('div');
      preview.className = 'theme-preview';
      const prompt = document.createElement('span');
      prompt.className = 'theme-prompt';
      prompt.textContent = '~ ❯ hello';
      preview.append(prompt);
      const bars = document.createElement('div');
      bars.className = 'theme-swatches';
      for (const key of ['red', 'yellow', 'green', 'blue', 'magenta', 'cyan']) {
        const swatch = document.createElement('i');
        swatch.style.background = c[key];
        bars.append(swatch);
      }
      preview.append(bars);
      b.append(preview, label);
      b.onclick = e => {
        e.stopPropagation();
        apply(t.id);
      };
      grid.append(b);
    }
    const picker = legend('background-picker', 'background');
    picker.meta.dataset.themeFor = '';
    const backgrounds = document.createElement('div');
    backgrounds.className = 'background-grid';
    backgrounds.setAttribute('role', 'group');
    backgrounds.setAttribute('aria-label', 'Choose a background');
    picker.panel.append(backgrounds);
    host.append(head, themes.panel, picker.panel);
    window.HyprlandPreferences?.settings(host);
    window.HyprlandSolo?.settings(host);
    drawBackgrounds();
    // Let native scrolling own this surface without triggering workspace swipes.
    for (const type of ['pointerdown', 'touchstart', 'touchmove', 'touchend'])
      host.addEventListener(type, e => e.stopPropagation(), { passive: true });
    refresh();
  }
  window.HyprlandApps?.provide('settings', {
    create: root => {
      attach(root);
      return {};
    },
  });
  window.HyprlandThemes = {
    restore: () => {
      wallpapers = HyprlandUtil.storage.read('omarchy-wallpapers', {}) || {};
      apply(HyprlandUtil.storage.get('omarchy-theme'), false);
    },
    apply,
    background,
    attach,
    catalog,
    windowOpacity: active => (active ? 0.95 : 0.92),
    backgroundRGB: () =>
      current.colors.background
        .slice(1)
        .match(/../g)
        .map(x => parseInt(x, 16)),
    terminalTheme,
    palette: () => {
      const t = terminalTheme();
      return ansiKeys.map(k => t[k]);
    },
  };
  let saved;
  try {
    saved = localStorage.getItem('omarchy-theme');
  } catch {}
  apply(saved, false);
})();
