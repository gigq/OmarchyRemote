/* Omarchy Remote for Linux, macOS and Windows. Each window loads a host's /native/ shell with the
   same bridges the iOS and Android apps provide: the full shell, or one app on its own
   (`--app=<key>`, loaded as /native/?app=<key>) without the shell around it. */
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell as desktop,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, seed } from './hosts.js';
import { register } from './keys.js';
import * as launchers from './launchers.js';
import { Pages, website } from './pages.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'omarchy-app';
const BUNDLE = `${SCHEME}://bundle`;
const PICKER = BUNDLE + '/hosts.html';
// The packaged app carries the host picker and Dark Reader; development reads them in place.
const webRoot =
  process.env.OMARCHY_WEB_ROOT ||
  (app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(here, '../../ios/Generated/Web'));
const icon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.resolve(here, '../../public/icons/icon-512.png');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (process.env.OMARCHY_USER_DATA) app.setPath('userData', process.env.OMARCHY_USER_DATA);

const origin = url => {
  try {
    const parsed = new URL(url);
    // Node reports "null" as the origin of custom schemes such as the bundled picker.
    return parsed.protocol === SCHEME + ':' ? `${SCHEME}://${parsed.host}` : parsed.origin;
  } catch {
    return '';
  }
};
const argument = (argv, name) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/* One window: the full shell (key '') or a single app. */
class ShellWindow {
  constructor(desktopApp, key) {
    this.desktop = desktopApp;
    this.key = key;
    this.commands = [];
    const saved = desktopApp.store.bounds(key);
    const visible =
      saved &&
      screen.getAllDisplays().some(d => {
        const a = d.workArea;
        return (
          saved.x < a.x + a.width &&
          saved.y < a.y + a.height &&
          saved.x + saved.width > a.x &&
          saved.y + saved.height > a.y
        );
      });
    this.window = new BrowserWindow({
      ...(key ? { width: 900, height: 820 } : { width: 1280, height: 860 }),
      ...(visible ? saved : {}),
      minWidth: 360,
      minHeight: 420,
      title: 'Omarchy Remote',
      icon,
      backgroundColor: '#191724',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        session: desktopApp.shellSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    this.contents = this.window.webContents;
    this.window.once('ready-to-show', () => this.window.show());
    // The full shell is titled by host; an app window takes the app's name from its page.
    this.window.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (this.key && origin(this.contents.getURL()) !== BUNDLE) this.window.setTitle(title);
    });
    this.window.on('close', () => desktopApp.store.saveBounds(key, this.window.getNormalBounds()));
    this.window.on('closed', () => desktopApp.windows.delete(key));
    this.pages = new Pages({
      window: this.window,
      shell: this.contents,
      session: desktopApp.pageSession,
      store: desktopApp.store,
      commands: () => this.commands,
      webRoot,
      findPage: path.join(here, 'find.html'),
      findPreload: path.join(here, 'find-preload.cjs'),
      contextMenu: (contents, params, isWebsite) => this.contextMenu(contents, params, isWebsite),
      openExternal: url => desktopApp.openExternal(url),
    });
    this.guardNavigation();
    this.contents.on('context-menu', (event, params) =>
      this.contextMenu(this.contents, params, false)
    );
    if (process.env.OMARCHY_DEVTOOLS === '1') this.contents.openDevTools({ mode: 'detach' });
    this.load();
  }
  get selected() {
    return this.desktop.selected;
  }
  allowed(url) {
    return this.desktop.allowed(url);
  }
  target() {
    if (!this.selected) return PICKER;
    const url = new URL(this.selected);
    if (this.key) url.searchParams.set('app', this.key);
    return url.href;
  }
  load() {
    this.pages.closeAll();
    this.commands = [];
    this.pickerError = null;
    const host = this.desktop.store.directory.hosts.find(h => h.id === this.selected)?.name;
    this.window.setTitle(host ? 'Omarchy Remote · ' + host : 'Omarchy Remote');
    this.contents.loadURL(this.target()).catch(() => {});
  }
  guardNavigation() {
    const contents = this.contents;
    const guard = event => {
      if (!event.isMainFrame || this.allowed(event.url)) return;
      event.preventDefault();
      if (website(event.url)) this.desktop.openExternal(event.url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      if (website(url)) this.desktop.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument) this.pages.closeAll();
    });
    // An unreachable or failing host returns to the picker with the reason.
    contents.on('did-fail-load', (event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3 && origin(url) !== BUNDLE)
        this.showPicker(`Could not reach ${new URL(url).host}: ${description}.`);
    });
    contents.on('did-navigate', (event, url, status) => {
      if (status >= 400 && origin(url) !== BUNDLE)
        this.showPicker(`${new URL(url).host} answered with HTTP ${status}.`);
    });
    contents.on('did-finish-load', () => {
      if (!this.pickerError || origin(contents.getURL()) !== BUNDLE) return;
      contents
        .executeJavaScript(
          `document.querySelector('#host-error').textContent = ${JSON.stringify(this.pickerError)}`
        )
        .catch(() => {});
    });
    contents.on('render-process-gone', () => this.load());
  }
  showPicker(error) {
    this.pages.closeAll();
    this.pickerError = error;
    this.contents.loadURL(PICKER).catch(() => {});
  }
  device() {
    const scope = this.selected || '';
    return {
      id: this.desktop.store.data.deviceId,
      name: os.hostname(),
      scope,
      hosts: this.desktop.store.directory,
      snapshot: scope ? this.desktop.store.snapshot(scope) : {},
      window: this.key || null,
    };
  }
  async dispatch(channel, body) {
    switch (channel) {
      case 'shellStorage':
        return this.desktop.store.saveSnapshot(body?.scope, body?.values);
      case 'shellHosts':
        return this.desktop.hosts(body || {});
      case 'shellKeyboard':
        if (body && Array.isArray(body.commands))
          this.commands = register(body.commands) || this.commands;
        return true;
      case 'shellFiles':
        return this.saveFile(body || {});
      case 'shellWindows':
        return this.desktop.windowAction(body || {});
      case 'weatherDevice':
        if (body?.action === 'locale') {
          const locale = app.getLocale();
          let region = '';
          try {
            region = new Intl.Locale(app.getSystemLocale() || locale).maximize().region || '';
          } catch {}
          return {
            unit: ['BS', 'BZ', 'KY', 'PR', 'PW', 'US'].includes(region) ? 'f' : 'c',
            locale,
          };
        }
        if (body?.action === 'location')
          return { error: 'Location is unavailable on desktop. Choose a city instead.' };
        throw new Error('Unknown weather action');
      case 'browserDevice':
        return this.pages.command(body || {});
      default:
        throw new Error('Unsupported bridge');
    }
  }
  async saveFile({ name, bytes }) {
    const fileName = path.basename(String(name || 'download')).slice(0, 255) || 'download';
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes))
      throw new Error('Nothing to save');
    const { canceled, filePath } = await dialog.showSaveDialog(this.window, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
    });
    if (canceled || !filePath) return { cancelled: true };
    await fs.promises.writeFile(filePath, Buffer.from(bytes));
    return { saved: true };
  }
  focus() {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }
  contextMenu(contents, params, isWebsite) {
    const items = [];
    if (params.linkURL && website(params.linkURL))
      items.push(
        { label: 'Open Link in Browser', click: () => this.desktop.openExternal(params.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    if (params.isEditable)
      items.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      );
    else if (params.selectionText) items.push({ role: 'copy' });
    if (isWebsite && !params.isEditable)
      items.push(
        ...(items.length ? [{ type: 'separator' }] : []),
        {
          label: 'Back',
          enabled: contents.navigationHistory.canGoBack(),
          click: () => contents.navigationHistory.goBack(),
        },
        { label: 'Reload', click: () => contents.reload() },
        {
          label: 'Open Page in Browser',
          click: () => this.desktop.openExternal(contents.getURL()),
        }
      );
    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: this.window });
  }
}

/* Device-wide state shared by every window: saved hosts, sessions, and the window registry. */
class DesktopApp {
  constructor(store) {
    this.store = store;
    this.windows = new Map();
    this.shellSession = session.fromPartition('persist:shell');
    this.pageSession = session.fromPartition('persist:websites');
    this.serveBundle(this.shellSession);
    this.guardPermissions();
  }
  get selected() {
    const { selected, disconnected } = this.store.directory;
    return disconnected ? null : selected;
  }
  allowed(url) {
    const target = origin(url);
    return target === BUNDLE || (!!this.selected && target === origin(this.selected));
  }
  /* Opens or focuses the full shell ('') or one app's window. */
  open(key = '') {
    if (key && !launchers.APP_KEY.test(key)) throw new Error('Unsupported app');
    const existing = this.windows.get(key);
    if (existing) {
      existing.focus();
      return existing;
    }
    const created = new ShellWindow(this, key);
    this.windows.set(key, created);
    return created;
  }
  owner(event) {
    if (event.senderFrame?.parent) return null;
    const owner = [...this.windows.values()].find(w => w.contents === event.sender);
    return owner && this.allowed(event.sender.getURL()) ? owner : null;
  }
  hosts(body) {
    // Host navigation replaces the shell before its debounced mirror is sent; keep this one.
    if (this.selected && body.values) this.store.saveSnapshot(body.scope, body.values);
    if (body.action === 'prompt') return this.store.directory;
    const { directory, navigate } = apply(this.store.directory, body.action, body);
    this.store.directory = directory;
    // The selected host is device-wide, so every window follows it.
    if (navigate) setImmediate(() => this.windows.forEach(w => w.load()));
    return this.store.directory;
  }
  windowAction(body) {
    const key = String(body.app || '');
    if (!launchers.APP_KEY.test(key)) throw new Error('Unsupported app');
    if (body.action === 'open') {
      this.open(key);
      return { ok: true };
    }
    if (body.action === 'status')
      return { launcher: launchers.installed(key), launchers: process.platform === 'linux' };
    if (body.action === 'install') {
      const host = this.store.directory.hosts.find(h => h.id === this.selected);
      launchers.install({
        key,
        name: String(body.name || key),
        host: host?.name || 'your host',
        command: this.command(),
        icon,
      });
      return { launcher: true };
    }
    if (body.action === 'remove') {
      launchers.remove(key);
      return { launcher: false };
    }
    throw new Error('Unsupported window action');
  }
  /* How a launcher entry starts this client again. */
  command() {
    if (process.env.APPIMAGE) return [process.env.APPIMAGE];
    return app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
  }
  serveBundle(target) {
    const root = path.resolve(webRoot);
    target.protocol.handle(SCHEME, request => {
      const url = new URL(request.url);
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (url.host !== 'bundle' || !file.startsWith(root + path.sep) || !fs.existsSync(file))
        return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    });
  }
  guardPermissions() {
    const shellAllowed = ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'];
    this.shellSession.setPermissionRequestHandler((contents, permission, done, details) =>
      done(shellAllowed.includes(permission) && this.allowed(details.requestingUrl))
    );
    this.shellSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin) =>
        shellAllowed.includes(permission) && this.allowed(requestingOrigin)
    );
    // Websites get harmless capabilities; anything personal asks first, like a browser.
    const ask = ['media', 'geolocation', 'notifications', 'clipboard-read'];
    this.pageSession.setPermissionRequestHandler((contents, permission, done, details) => {
      if (['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission))
        return done(true);
      if (!ask.includes(permission)) return done(false);
      const host = origin(details.requestingUrl) || 'This website';
      const what =
        permission === 'media'
          ? (details.mediaTypes || []).join(' and ') || 'camera or microphone'
          : permission.replace('-', ' ');
      const parent = BrowserWindow.fromWebContents(contents.hostWebContents || contents);
      dialog
        .showMessageBox(parent || undefined, {
          type: 'question',
          buttons: ['Block', 'Allow'],
          defaultId: 0,
          cancelId: 0,
          message: `${host} wants to use your ${what}.`,
        })
        .then(({ response }) => done(response === 1))
        .catch(() => done(false));
    });
    this.pageSession.setUserAgent(
      this.pageSession.getUserAgent().replace(/ (Electron|omarchy-remote-desktop)\/\S+/g, '')
    );
  }
  openExternal(url) {
    if (website(url) || url.startsWith('mailto:')) desktop.openExternal(url).catch(() => {});
  }
}

// macOS needs a menu for Quit, Hide and the editing keys; elsewhere every key goes to the shell.
function applicationMenu() {
  if (process.platform !== 'darwin') return null;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }],
    },
  ]);
}

const requestedApp = argv => {
  const key = argument(argv, 'app') || '';
  return !key || launchers.APP_KEY.test(key) ? key : '';
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let desktopApp;
  // Launching again, from a terminal or a launcher entry, opens that window in this process.
  app.on('second-instance', (event, argv) => desktopApp?.open(requestedApp(argv)));
  app.whenReady().then(() => {
    Menu.setApplicationMenu(applicationMenu());
    const store = new Store(app.getPath('userData'));
    const requested = argument(process.argv, 'host') || process.env.OMARCHY_REMOTE_URL;
    try {
      store.directory = seed(store.directory, requested);
    } catch (error) {
      console.error(`Ignoring host ${requested}: ${error.message}`);
    }
    desktopApp = new DesktopApp(store);
    ipcMain.on('omarchy:device', event => {
      event.returnValue = desktopApp.owner(event)?.device() || null;
    });
    ipcMain.handle('omarchy:bridge', async (event, channel, body) => {
      const owner = desktopApp.owner(event);
      if (!owner) throw new Error('Bridge unavailable');
      try {
        return await owner.dispatch(String(channel), body);
      } catch (error) {
        return { error: error.message || 'Native request failed' };
      }
    });
    ipcMain.on('omarchy:find', (event, message) => {
      for (const window of desktopApp.windows.values())
        window.pages.findMessage(event.sender, message || {});
    });
    desktopApp.open(requestedApp(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
