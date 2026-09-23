/* Websites for Browser tabs and pinned web apps. Each page is its own WebContentsView laid over
   the tile the shell reserves for it (the browserDevice bridge); pages get no host bridges. */
import { WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { match } from './keys.js';

export const website = raw => {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
};

const FIND_WIDTH = 340;
const FIND_HEIGHT = 46;

export class Pages {
  constructor({
    window,
    shell,
    session,
    store,
    commands,
    webRoot,
    findPage,
    findPreload,
    contextMenu,
    openExternal,
  }) {
    this.window = window;
    this.shell = shell;
    this.session = session;
    this.store = store;
    this.commands = commands;
    this.webRoot = webRoot;
    this.findPage = findPage;
    this.findPreload = findPreload;
    this.contextMenu = contextMenu;
    this.openExternal = openExternal;
    this.pages = new Map();
  }
  capabilities(id) {
    const page = this.pages.get(id);
    return {
      embedded: true,
      webApps: true,
      darkMode: true,
      dark: page ? page.dark : this.store.forceDark,
      nativeFind: true,
      shortcuts: true,
    };
  }
  command(body) {
    const action = String(body?.action || '');
    const id = String(body?.appID || 'browser').slice(0, 200);
    if (action === 'capabilities') return this.capabilities(id);
    let page = this.pages.get(id);
    if (action === 'open') {
      const url = website(body.url);
      if (!url) throw new Error('Unsupported website URL');
      if (!page) page = this.create(id);
      page.view.webContents.loadURL(url.href).catch(() => {});
      return { ok: true };
    }
    if (!page) return { ok: true };
    const contents = page.view.webContents;
    const history = contents.navigationHistory;
    switch (action) {
      case 'layout':
        this.layout(page, body);
        break;
      case 'back':
        if (history.canGoBack()) history.goBack();
        break;
      case 'forward':
        if (history.canGoForward()) history.goForward();
        break;
      case 'reload':
        contents.reload();
        break;
      case 'stop':
        contents.stop();
        break;
      case 'focus':
        if (body.active === false) this.shell.focus();
        else contents.focus();
        break;
      case 'close':
        this.close(id);
        break;
      case 'zoom': {
        const value = Number(body.value);
        if (Number.isFinite(value)) contents.setZoomFactor(Math.max(0.25, Math.min(5, value)));
        break;
      }
      case 'dark':
        page.dark = !!body.enabled;
        this.store.forceDark = page.dark;
        this.applyDark(page);
        return { dark: page.dark };
      case 'findOpen':
        this.openFind(page);
        break;
      case 'findNext':
        if (!page.find) this.openFind(page);
        else if (page.query)
          contents.findInPage(page.query, { forward: !body.backwards, findNext: false });
        break;
      case 'findClose':
        return { closed: this.closeFind(page) };
      case 'snapshot':
        this.snapshot(page);
        break;
      default:
        break;
    }
    return { ok: true };
  }
  create(id) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    // Unstyled websites use a white canvas behind their default black text.
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const page = {
      id,
      view,
      dark: this.store.forceDark,
      loading: false,
      focused: false,
      hoverAt: 0,
    };
    this.pages.set(id, page);
    const contents = view.webContents;
    const publish = () =>
      this.emit(page, {
        url: contents.getURL(),
        title: contents.getTitle(),
        loading: page.loading,
        back: contents.navigationHistory.canGoBack(),
        forward: contents.navigationHistory.canGoForward(),
      });
    contents.on('did-start-loading', () => {
      page.loading = true;
      publish();
    });
    contents.on('did-stop-loading', () => {
      page.loading = false;
      publish();
    });
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);
    contents.on('did-finish-load', () => {
      if (page.dark) this.applyDark(page);
    });
    contents.on('did-fail-load', (event, code, description, url, mainFrame) => {
      // -3 is an aborted load, which a following navigation already replaces.
      if (mainFrame && code !== -3)
        this.emit(page, { error: description || 'Could not open page', loading: false });
    });
    contents.on('focus', () => this.emit(page, { focused: true }));
    contents.on('input-event', (event, input) => {
      if (input.type !== 'mouseMove' || page.focused) return;
      const now = Date.now();
      if (now - page.hoverAt < 100) return;
      page.hoverAt = now;
      // The shell owns the hover-focus preference and its overlay/focus guards.
      this.emit(page, { hovered: true });
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // A focused website is always treated as editing, so arrow-key bindings stay with it.
      const action = match(this.commands(), input, true);
      if (!action) return;
      event.preventDefault();
      if (action.focusShell) this.shell.focus();
      this.shell
        .executeJavaScript(`window.HyprlandDesk?.nativeKey(${JSON.stringify(action)})`)
        .catch(() => {});
    });
    contents.on('found-in-page', (event, result) => {
      page.find?.webContents.send('find:result', {
        index: result.activeMatchOrdinal,
        total: result.matches,
      });
    });
    contents.on('will-navigate', event => {
      if (!website(event.url)) {
        event.preventDefault();
        if (event.url.startsWith('mailto:')) this.openExternal(event.url);
      }
    });
    // Links that open a new window stay in this page, as on iPhone and Android.
    contents.setWindowOpenHandler(({ url }) => {
      if (website(url)) contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('context-menu', (event, params) => this.contextMenu(contents, params, true));
    return page;
  }
  layout(page, body) {
    const { view } = page;
    if (!body.visible) {
      if (view.webContents.isFocused()) this.shell.focus();
      page.focused = false;
      view.setVisible(false);
      this.closeFind(page);
      return;
    }
    const rect = body.rect;
    const viewport = Number(body.viewport);
    if (!Array.isArray(rect) || rect.length !== 4 || !(viewport > 0)) return;
    const content = this.window.getContentBounds();
    const scale = content.width / viewport;
    const [x, y, width, height] = rect.map(v => Number(v) * scale);
    if (![x, y, width, height].every(Number.isFinite)) return;
    if (width > content.width * 4 || height > content.height * 4) return;
    page.bounds = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
    view.setBounds(page.bounds);
    view.setBorderRadius(Math.max(0, Math.round((Number(body.radius) || 0) * scale)));
    view.setVisible(true);
    this.placeFind(page);
    const focused = !!body.focused;
    // Layout frames must not steal focus back from page controls or dialogs.
    if (focused && !page.focused) view.webContents.focus();
    else if (!focused && view.webContents.isFocused()) this.shell.focus();
    page.focused = focused;
  }
  applyDark(page) {
    const contents = page.view.webContents;
    if (!page.dark) {
      contents.executeJavaScript('window.DarkReader?.disable()').catch(() => {});
      return;
    }
    const source = path.join(this.webRoot, 'vendor/darkreader/darkreader.js');
    fs.promises
      .readFile(source, 'utf8')
      .then(script =>
        contents.executeJavaScript(
          `if (typeof window.DarkReader === 'undefined') {${script}\n}\nwindow.DarkReader.enable({ brightness: 100, contrast: 100 });`
        )
      )
      .catch(() => {});
  }
  async snapshot(page) {
    const { view } = page;
    if (!view.getVisible() || !page.bounds) return;
    try {
      let image = await view.webContents.capturePage();
      const size = image.getSize();
      if (!size.width || !size.height) return;
      const ratio = Math.min(1, 600 / size.width, 900 / size.height);
      if (ratio < 1)
        image = image.resize({
          width: Math.round(size.width * ratio),
          height: Math.round(size.height * ratio),
        });
      this.emit(page, { preview: 'data:image/jpeg;base64,' + image.toJPEG(65).toString('base64') });
    } catch {}
  }
  openFind(page) {
    if (!page.view.getVisible()) return;
    if (page.find) {
      page.find.webContents.focus();
      return;
    }
    const find = new WebContentsView({
      webPreferences: {
        preload: this.findPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    find.setBackgroundColor('#00000000');
    page.find = find;
    this.window.contentView.addChildView(find);
    this.placeFind(page);
    find.webContents.loadFile(this.findPage, { query: { q: page.query || '' } }).then(() => {
      if (page.find === find) find.webContents.focus();
    });
  }
  placeFind(page) {
    if (!page.find || !page.bounds) return;
    const { x, y, width } = page.bounds;
    const findWidth = Math.min(FIND_WIDTH, width);
    page.find.setBounds({
      x: x + width - findWidth - 8,
      y: y + 8,
      width: findWidth - 8,
      height: FIND_HEIGHT,
    });
    // Re-adding moves the bar above its page.
    this.window.contentView.addChildView(page.find);
  }
  closeFind(page) {
    if (!page.find) return false;
    const { find } = page;
    page.find = null;
    page.view.webContents.stopFindInPage('clearSelection');
    this.window.contentView.removeChildView(find);
    find.webContents.close();
    return true;
  }
  /* Messages from a find bar, identified by the web contents that sent them. */
  findMessage(sender, message) {
    const page = [...this.pages.values()].find(p => p.find?.webContents === sender);
    if (!page) return;
    const contents = page.view.webContents;
    if (message.action === 'close') {
      this.closeFind(page);
      contents.focus();
      return;
    }
    const query = String(message.query || '').slice(0, 1000);
    page.query = query;
    if (!query) {
      contents.stopFindInPage('clearSelection');
      sender.send('find:result', { index: 0, total: 0 });
      return;
    }
    // Electron's findNext means "start a new session": true for a changed query only.
    contents.findInPage(query, {
      forward: !message.backwards,
      findNext: message.action !== 'next',
    });
  }
  emit(page, data) {
    if (page.id !== 'browser') data.appID = page.id;
    this.shell
      .executeJavaScript(
        `window.dispatchEvent(new CustomEvent('host-browser-state', { detail: ${JSON.stringify(data)} }))`
      )
      .catch(() => {});
  }
  close(id) {
    const page = this.pages.get(id);
    if (!page) return;
    this.closeFind(page);
    this.pages.delete(id);
    this.window.contentView.removeChildView(page.view);
    page.view.webContents.close();
  }
  closeAll() {
    for (const id of [...this.pages.keys()]) this.close(id);
  }
}
