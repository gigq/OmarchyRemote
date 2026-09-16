/* App catalog: the one list the shell reads for workspaces, Home pins, the launcher,
   Expo cards, desk tiles and SUPER bindings. To add an app, `define` it here and give it
   behaviour with `HyprlandApps.provide(key, {...})` from its own module (see CONTRIBUTING.md).
   The key doubles as the host app id the backend knows. */
(() => {
  const catalog = {};
  // surface: 'terminal' cards use the terminal background, 'page' cards the app background.
  // mount: id of the element the app renders into (default remote-<key>-app, class remote-app).
  // native: the touch keyboard and hardware keys are sent to the app (its instance implements key()).
  // offline: the app works without the host backend, so no "connect to the host" placeholder.
  // typing: keyboard status label while the app has focus (defaults to the app name).
  // glyph: two-letter fallback shown where the Nerd Font is unavailable; icon: the Nerd Font
  //   codepoint (public/assets/nerd-symbols.woff2 is a subset; add glyphs there when adding one).
  // superKeys: phone SUPER-keyboard keys that open the app; superLabel is the key caption.
  // deskKeys: desk-mode bindings ({keys, code, label, shift?, alt?, browserOnly?}) that open the
  //   app, or call the instance's reopen() when reopen: true and the app is already in front.
  const define = (key, spec) => {
    catalog[key] = {
      key,
      mount: 'remote-' + key + '-app',
      mountClass: 'remote-app',
      surface: 'page',
      icon: '',
      native: false,
      offline: false,
      typing: null,
      superKeys: [],
      superLabel: null,
      deskKeys: [],
      provider: null,
      ...spec,
    };
    return catalog[key];
  };
  define('home', {
    name: 'home',
    color: 'var(--theme-rose)',
    glyph: 'hm',
    icon: '\uf015',
    description: 'launcher',
    offline: true,
  });
  define('terminal', {
    name: 'terminal',
    color: 'var(--theme-green)',
    glyph: '>_',
    icon: '\uf120',
    description: 'live host shell',
    surface: 'terminal',
    native: true,
    superKeys: ['t', '⏎'],
    superLabel: 'term',
    deskKeys: [
      { keys: 'T', code: /^KeyT$/, label: 'Terminal / new terminal tab', reopen: true },
      { keys: '↩', code: /^(Enter|NumpadEnter)$/, label: 'Terminal' },
    ],
  });
  define('files', {
    name: 'files',
    color: 'var(--theme-red)',
    glyph: 'fm',
    icon: '\uf07b',
    description: 'files on the host',
    superKeys: ['e'],
    deskKeys: [{ keys: '⇧ F', shift: true, code: /^KeyF$/, label: 'Files' }],
  });
  define('browser', {
    name: 'browser',
    color: 'var(--theme-blue)',
    glyph: 'br',
    icon: '\uf0ac',
    description: 'desktop browser tabs',
    deskKeys: [
      {
        browserOnly: true,
        keys: '⇧ ↩',
        shift: true,
        code: /^(Enter|NumpadEnter)$/,
        label: 'Browser',
      },
      { keys: '⇧ B', shift: true, code: /^KeyB$/, label: 'Browser' },
    ],
  });
  define('herdr', {
    name: 'herdr',
    color: 'var(--theme-cyan)',
    glyph: 'hd',
    icon: '\u{f06a9}',
    description: 'agents · herdr',
    native: true,
    typing: 'selected Herdr pane',
    superKeys: ['a'],
    deskKeys: [{ keys: '⇧ A', shift: true, code: /^KeyA$/, label: 'Herd agents' }],
  });
  define('btop', {
    name: 'btop',
    color: 'var(--theme-green)',
    glyph: 'bt',
    icon: '\uf080',
    description: 'host system monitor',
    surface: 'terminal',
    native: true,
  });
  define('services', {
    name: 'services',
    color: 'var(--theme-yellow)',
    glyph: 'sv',
    icon: '\uf085',
    description: 'systemd services · logs',
    surface: 'terminal',
    native: true,
  });
  define('lazydocker', {
    name: 'lazydocker',
    color: 'var(--theme-blue)',
    glyph: 'dk',
    icon: '\uf308',
    description: 'containers · docker',
    surface: 'terminal',
    native: true,
    deskKeys: [{ keys: '⇧ D', shift: true, code: /^KeyD$/, label: 'lazydocker' }],
  });
  define('dua', {
    name: 'dua',
    color: 'var(--theme-yellow)',
    glyph: 'du',
    icon: '\uf0a0',
    description: 'disk usage · cleanup',
    surface: 'terminal',
    native: true,
  });
  define('lnav', {
    name: 'lnav',
    color: 'var(--theme-cyan)',
    glyph: 'lg',
    icon: '\uf15c',
    description: 'host logs · search',
    surface: 'terminal',
    native: true,
  });
  define('settings', {
    name: 'settings',
    color: 'var(--theme-accent)',
    glyph: 'st',
    icon: '\uf013',
    description: 'appearance · themes · this device',
    mount: 'theme-settings',
    mountClass: 'theme-settings',
    offline: true,
    superKeys: ['s'],
    deskKeys: [{ keys: ',', code: /^Comma$/, label: 'Settings' }],
  });
  // A provider is {create(root, bridge) → instance, close?(instance|null, bridge)}. Instances may
  // implement connect, resume, resize, show(visible), blur, key(input), nativeInput, stopTouchScroll,
  // placeLatest and dispose; the bridge calls whichever exist. In desk mode the front app's
  // shortcut(event) sees hardware keys before the shell bindings, its shortcuts ([keys, text] pairs)
  // fill the shortcut sheet, and reopen() runs for bindings marked reopen: true while it is in front.
  const provide = (key, provider) => {
    const app = catalog[key];
    if (!app) throw Error('Unknown app: ' + key);
    app.provider = provider;
    return app;
  };
  const defineWebApp = app =>
    define(app.id, {
      name: app.name,
      glyph: app.name.slice(0, 2).toLowerCase(),
      icon: '\uf0ac',
      color: 'var(--theme-accent)',
      description: new URL(app.url).hostname,
      offline: true,
      mountClass: 'remote-app webapp-app',
    });
  const DEFAULT_PINS = [
    'terminal',
    'files',
    'browser',
    'herdr',
    'btop',
    'services',
    'lazydocker',
    'dua',
    'lnav',
    'settings',
  ];
  // The connected host, filled from /api/capabilities by the bridge; `hyprland-host` fires on
  // document when it changes so status lines can repaint.
  const host = { name: 'host', home: '' };
  const setHost = caps => {
    if (caps?.host) host.name = caps.host;
    if (caps?.home) host.home = caps.home;
    document.dispatchEvent(new CustomEvent('hyprland-host', { detail: host }));
  };
  const tilde = path =>
    host.home && path && (path === host.home || path.startsWith(host.home + '/'))
      ? '~' + path.slice(host.home.length)
      : path || '';
  window.HyprlandApps = {
    catalog,
    define,
    defineWebApp,
    provide,
    get: key => catalog[key] || null,
    keys: () => Object.keys(catalog),
    DEFAULT_PINS,
    host,
    setHost,
    tilde,
  };
})();
