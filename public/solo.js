/* Solo windows: `?app=<key>` shows one catalog app on its own, filling the window without the
   top bar, Home, workspaces, frames, Expo, launcher, gestures or shell shortcuts. The app keeps
   its normal provider and bridge. The desktop client opens these as separate windows; a browser
   can open the same address. A solo window never reads or writes the saved shell layout. */
(() => {
  const requested = new URLSearchParams(location.search).get('app');
  const key =
    requested && requested !== 'home' && /^[A-Za-z0-9][\w.-]{0,127}$/.test(requested)
      ? requested
      : null;
  const windows = () => window.webkit?.messageHandlers?.shellWindows;
  if (key) {
    document.documentElement.classList.add('solo-mode');
    // Only this app's card is shown, filling the window.
    const style = document.createElement('style');
    const card = `[data-workspace="${CSS.escape(key)}"]`;
    style.textContent = `.solo-mode [data-workspace]:not(${card}) { display: none !important; }
.solo-mode ${card} { inset: 0 !important; width: 100% !important; height: 100% !important; transform: none !important; border: 0 !important; border-radius: 0 !important; opacity: 1 !important; visibility: visible !important; background: var(--theme-background) !important; }`;
    document.head.append(style);
  }

  /* Opens an app in its own window: a desktop window, or a browser tab elsewhere. */
  function open(app) {
    if (!app || app === 'home') return;
    const bridge = windows();
    if (bridge) {
      bridge.postMessage({ action: 'open', app }).catch(() => {});
      return;
    }
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('app', app);
    window.open(url.href, '_blank', 'noopener');
  }

  function missing(name) {
    const note = document.createElement('p');
    note.className = 'solo-missing';
    note.setAttribute('role', 'alert');
    note.textContent = `This host has no app called “${name}”.`;
    document.body.append(note);
  }

  /* Called by preferences in place of restoring the saved layout. Returns true when solo. */
  function bind(logic, saved) {
    if (!key) return false;
    const spec = HyprlandApps.get(key);
    if (!spec?.provider) {
      document.title = 'Omarchy Remote';
      missing(key);
      return true;
    }
    document.title = spec.name;
    const set = logic.set.bind(logic);
    // Workspace, Expo, launcher and map changes do not exist here; the app stays open and in front.
    logic.set = (patch, ...rest) => {
      if (patch && typeof patch === 'object') {
        patch = { ...patch };
        for (const field of ['ov', 'launch', 'map']) if (patch[field]) patch[field] = false;
        if ('ws' in patch) patch.ws = 1;
        if ('open' in patch) patch.open = ['home', key];
      }
      return set(patch, ...rest);
    };
    logic.go = () => {};
    logic.openLauncher = () => {};
    const focusApp = logic.focusApp?.bind(logic);
    logic.focusApp = app => (app === key ? focusApp?.(app) : open(app));
    logic.openApp = app => (app === key ? focusApp?.(app) : open(app));
    // Closing this app, for example when its shell exits, closes the window.
    logic.closeApp = app => {
      if (app === key) window.close();
    };
    set({
      open: ['home', key],
      ws: 1,
      tiles: { [key]: 1 },
      focus: key,
      full: [],
      floating: {},
      groups: {},
      ov: false,
      launch: false,
      ...(saved?.keyBindings ? { keyBindings: saved.keyBindings } : {}),
    });
    return true;
  }

  /* Settings section for the desktop client: open any app in its own window, and add Linux
     launcher entries that start it directly. */
  function settings(host) {
    const bridge = windows();
    if (!bridge || key) return;
    const { node } = HyprlandUtil;
    const section = node('section', 'solo-settings legend');
    section.setAttribute('aria-label', 'App windows');
    section.append(
      node('span', 'legend-title', 'app windows'),
      node('p', 'theme-note', 'Open an app in its own desktop window, without the shell around it.')
    );
    const list = node('div', 'solo-app-list');
    const apps = Object.values(HyprlandApps.catalog).filter(
      spec => spec.key !== 'home' && !spec.baseKey && spec.provider
    );
    for (const spec of apps) {
      const row = node('div', 'solo-app');
      const name = node('span', 'solo-app-name', spec.name);
      const openKey = node('button', 'keycap small', 'open');
      openKey.type = 'button';
      openKey.setAttribute('aria-label', `Open ${spec.name} in its own window`);
      openKey.onclick = () => open(spec.key);
      row.append(name, openKey);
      const launcher = node('button', 'keycap small', 'launcher');
      launcher.type = 'button';
      launcher.hidden = true;
      const paint = installed => {
        launcher.setAttribute('aria-pressed', String(installed));
        launcher.setAttribute(
          'aria-label',
          `${installed ? 'Remove' : 'Add'} ${spec.name} ${installed ? 'from' : 'to'} the app launcher`
        );
      };
      launcher.onclick = async () => {
        launcher.disabled = true;
        try {
          const result = await bridge.postMessage({
            action: launcher.getAttribute('aria-pressed') === 'true' ? 'remove' : 'install',
            app: spec.key,
            name: spec.name,
          });
          paint(!!result.launcher);
        } catch (e) {
          status.textContent = e.message;
        }
        launcher.disabled = false;
      };
      bridge
        .postMessage({ action: 'status', app: spec.key })
        .then(result => {
          launcher.hidden = !result.launchers;
          paint(!!result.launcher);
        })
        .catch(() => {});
      row.append(launcher);
      list.append(row);
    }
    const status = node('p', 'theme-note');
    status.setAttribute('role', 'status');
    section.append(list, status);
    host.append(section);
  }

  window.HyprlandSolo = { key, bind, open, settings };
})();
