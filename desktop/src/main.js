/* Omarchy Remote for Linux, macOS and Windows: one window that loads a host's /native/ shell,
   with the same bridges the iOS and Android apps provide. */
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell as desktop,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, seed } from './hosts.js';
import { register } from './keys.js';
import { Pages, website } from './pages.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEME = 'omarchy-app';
const BUNDLE = `${SCHEME}://bundle`;
const PICKER = BUNDLE + '/hosts.html';
// The packaged app carries the generated native web bundle; development reads it in place.
const webRoot =
  process.env.OMARCHY_WEB_ROOT ||
  (app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(here, '../../ios/Generated/Web'));

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

class DesktopShell {
  constructor(store) {
    this.store = store;
    this.commands = [];
    this.shellSession = session.fromPartition('persist:shell');
    this.pageSession = session.fromPartition('persist:websites');
    this.serveBundle(this.shellSession);
    this.guardPermissions();
    this.window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 360,
      minHeight: 480,
      title: 'Omarchy Remote',
      backgroundColor: '#191724',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        session: this.shellSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    this.contents = this.window.webContents;
    this.window.once('ready-to-show', () => this.window.show());
    // The title names the connected host rather than the shell page.
    this.window.on('page-title-updated', event => event.preventDefault());
    this.pages = new Pages({
      window: this.window,
      shell: this.contents,
      session: this.pageSession,
      store,
      commands: () => this.commands,
      webRoot,
      findPage: path.join(here, 'find.html'),
      findPreload: path.join(here, 'find-preload.cjs'),
      contextMenu: (contents, params, website) => this.contextMenu(contents, params, website),
      openExternal: url => this.openExternal(url),
    });
    this.guardNavigation();
    this.contents.on('context-menu', (event, params) =>
      this.contextMenu(this.contents, params, false)
    );
    if (process.env.OMARCHY_DEVTOOLS === '1') this.contents.openDevTools({ mode: 'detach' });
    this.load();
  }
  get selected() {
    const { selected, disconnected } = this.store.directory;
    return disconnected ? null : selected;
  }
  allowed(url) {
    const target = origin(url);
    return target === BUNDLE || (!!this.selected && target === origin(this.selected));
  }
  load({ error } = {}) {
    this.pages.closeAll();
    this.commands = [];
    const target = this.selected || PICKER;
    this.pickerError = target === PICKER ? error : null;
    this.window.setTitle(
      this.selected
        ? 'Omarchy Remote · ' +
            (this.store.directory.hosts.find(h => h.id === this.selected)?.name || '')
        : 'Omarchy Remote'
    );
    this.contents.loadURL(target).catch(() => {});
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
  guardNavigation() {
    const contents = this.contents;
    const guard = event => {
      if (!event.isMainFrame || this.allowed(event.url)) return;
      event.preventDefault();
      if (website(event.url)) this.openExternal(event.url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      if (website(url)) this.openExternal(url);
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
      dialog
        .showMessageBox(this.window, {
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
  device(sender) {
    const url = sender.getURL();
    if (sender !== this.contents || !this.allowed(url)) return null;
    const scope = this.selected || '';
    return {
      id: this.store.data.deviceId,
      name: os.hostname(),
      scope,
      hosts: this.store.directory,
      snapshot: scope ? this.store.snapshot(scope) : {},
    };
  }
  async dispatch(channel, body) {
    switch (channel) {
      case 'shellStorage':
        return this.store.saveSnapshot(body?.scope, body?.values);
      case 'shellHosts':
        return this.hosts(body || {});
      case 'shellKeyboard':
        if (body && Array.isArray(body.commands))
          this.commands = register(body.commands) || this.commands;
        return true;
      case 'shellFiles':
        return this.saveFile(body || {});
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
  hosts(body) {
    // Host navigation replaces the shell before its debounced mirror is sent; keep this one.
    if (this.selected && body.values) this.store.saveSnapshot(body.scope, body.values);
    if (body.action === 'prompt') return this.store.directory;
    const { directory, navigate } = apply(this.store.directory, body.action, body);
    this.store.directory = directory;
    if (navigate) setImmediate(() => this.load());
    return this.store.directory;
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
  openExternal(url) {
    if (website(url) || url.startsWith('mailto:')) desktop.openExternal(url).catch(() => {});
  }
  contextMenu(contents, params, isWebsite) {
    const items = [];
    if (params.linkURL && website(params.linkURL))
      items.push(
        { label: 'Open Link in Browser', click: () => this.openExternal(params.linkURL) },
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
        { label: 'Open Page in Browser', click: () => this.openExternal(contents.getURL()) }
      );
    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: this.window });
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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let desktopShell;
  app.on('second-instance', () => {
    const window = desktopShell?.window;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(applicationMenu());
    const store = new Store(app.getPath('userData'));
    const requested =
      process.argv.find(a => a.startsWith('--host='))?.slice(7) || process.env.OMARCHY_REMOTE_URL;
    try {
      store.directory = seed(store.directory, requested);
    } catch (error) {
      console.error(`Ignoring host ${requested}: ${error.message}`);
    }
    desktopShell = new DesktopShell(store);
    ipcMain.on('omarchy:device', event => {
      event.returnValue = event.senderFrame?.parent ? null : desktopShell.device(event.sender);
    });
    ipcMain.handle('omarchy:bridge', async (event, channel, body) => {
      if (event.senderFrame?.parent || !desktopShell.device(event.sender))
        throw new Error('Bridge unavailable');
      try {
        return await desktopShell.dispatch(String(channel), body);
      } catch (error) {
        return { error: error.message || 'Native request failed' };
      }
    });
    ipcMain.on('omarchy:find', (event, message) =>
      desktopShell.pages.findMessage(event.sender, message || {})
    );
  });
  app.on('window-all-closed', () => app.quit());
}
