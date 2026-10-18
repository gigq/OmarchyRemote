// Chat: conversations with a local agent (Claude Code) that need no project. The host keeps each
// conversation as a Markdown file in ~/Chats; this view lists them and streams replies.
(() => {
  const { node, button, storage, contextMenu, askText } = window.HyprlandUtil;
  const headers = { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' };

  const MAX_ATTACHMENTS = 20;

  async function call(base, path, body) {
    const response = await fetch(
      base + path,
      body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'The host did not respond.');
    return data;
  }
  // Replies are Markdown. DOMPurify removes anything that could run in the shell's page.
  function markdown(target, text) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = text;
      return;
    }
    target.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }));
    for (const link of target.querySelectorAll('a[href]')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  const ICONS = {
    compose: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
    back: 'm15 18-6-6 6-6',
    stop: 'M6 6h12v12H6Z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z',
    attach: 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m-6 12 9-9',
    file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Zm0 0v5h5',
    close: 'M18 6 6 18M6 6l12 12',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  function iconButton(name, label, fn, className) {
    const b = button('', fn, 'chat-icon-button ' + className);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    return b;
  }
  function ago(time) {
    const seconds = (Date.now() - Date.parse(time)) / 1000;
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
    return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // What differs between Chat and apps built on it, such as Canvas.
  const CHAT = {
    base: '/api/chat',
    prefix: 'omarchy-chat',
    title: 'Chats',
    emptyTitle: 'No chats yet',
    emptyText: 'Ask Claude anything. No project needed.',
    start: 'Start a chat',
  };
  class ChatApp {
    constructor(root, bridge, options = {}) {
      this.options = { ...CHAT, ...options };
      const { base, prefix } = this.options;
      this.base = base;
      this.keys = {
        open: prefix + '-open',
        settings: prefix + '-settings',
        attachments: prefix + '-attachments-v1',
        drafts: prefix + '-drafts-v1',
      };
      this.root = root;
      this.bridge = bridge;
      root.classList.add('chat-app');
      this.chat = null;
      this.chats = [];

      this.listView = node('section', 'chat-list-view');
      const listBar = node('div', 'chat-bar');
      this.heading = node('h2', 'chat-heading', this.options.title);
      this.selectButton = button('Select', () => this.select(true), 'chat-text-button');
      this.cancelSelect = button('Cancel', () => this.select(false), 'chat-text-button');
      this.cancelSelect.hidden = true;
      this.newButton = iconButton('compose', 'New chat', () => this.startNew(), 'chat-new');
      listBar.append(this.heading, this.selectButton, this.cancelSelect, this.newButton);
      // Selecting several chats offers Archive and Delete; Delete asks to confirm first.
      this.selected = new Set();
      this.actionBar = node('div', 'chat-actions');
      this.actionBar.hidden = true;
      this.actionText = node('span', 'chat-actions-text');
      this.archiveButton = button('Archive', () => this.archive(), 'remote-button');
      this.deleteButton = button(
        'Delete',
        () => this.confirmDelete(true),
        'remote-button chat-danger'
      );
      this.keepButton = button('Keep', () => this.confirmDelete(false), 'remote-button');
      this.confirmButton = button('Delete', () => this.remove(), 'remote-button chat-danger');
      this.confirmButton.setAttribute('aria-label', 'Delete permanently');
      this.actionBar.append(
        this.actionText,
        this.archiveButton,
        this.deleteButton,
        this.keepButton,
        this.confirmButton
      );
      this.list = node('div', 'chat-list');
      this.list.setAttribute('role', 'list');
      this.empty = node('div', 'chat-list-empty');
      this.empty.append(
        node('span', 'chat-list-empty-icon', '\uf086'),
        node('p', 'chat-list-empty-title', this.options.emptyTitle),
        node('p', 'chat-list-empty-text', this.options.emptyText),
        button(this.options.start, () => this.startNew(), 'remote-button chat-start')
      );
      this.empty.hidden = true;
      this.listStatus = node('p', 'remote-status chat-folder');
      this.listView.append(listBar, this.list, this.empty, this.actionBar, this.listStatus);

      this.threadView = node('section', 'chat-thread-view');
      this.threadView.hidden = true;
      const threadBar = node('div', 'chat-bar');
      this.backButton = iconButton('back', 'All chats', () => this.showList(), 'chat-back');
      this.title = node('h2', 'chat-title');
      this.stopButton = iconButton('stop', 'Stop', () => this.stop(), 'chat-stop');
      this.stopButton.hidden = true;
      this.threadNew = iconButton('compose', 'New chat', () => this.startNew(), 'chat-new');
      // Each chat is a folder; files Claude makes for it land there.
      this.folderButton = iconButton(
        'folder',
        'Open chat folder',
        () => this.openFolder(),
        'chat-folder-button'
      );
      this.settingsButton = button('', () => this.toggleSettings(), 'chat-settings');
      this.settingsButton.setAttribute('aria-expanded', 'false');
      threadBar.append(
        this.backButton,
        this.title,
        this.settingsButton,
        this.folderButton,
        this.stopButton,
        this.threadNew
      );
      this.settingsPanel = node('div', 'chat-settings-panel');
      this.settingsPanel.hidden = true;
      this.agents = [];
      this.messages = node('div', 'chat-messages');
      this.messages.setAttribute('role', 'log');
      this.messages.setAttribute('aria-live', 'polite');
      this.status = node('p', 'remote-status chat-status');
      this.status.setAttribute('role', 'status');
      this.promptRow = node('div', 'herdr-prompt-row chat-prompt-row');
      this.promptField = button('', () => bridge.keyboard());
      this.promptField.className = 'prompt-field herdr-prompt chat-prompt';
      this.promptField.setAttribute('aria-label', 'Write a message');
      this.promptField.append(node('span', 'chat-placeholder', 'Message Claude…'));
      // Like Herdr: the paperclip offers the photo library and Files; pasted files attach too.
      this.filePicker = node('input');
      this.filePicker.type = 'file';
      this.filePicker.multiple = true;
      this.filePicker.hidden = true;
      this.filePicker.onchange = () => {
        const files = [...this.filePicker.files];
        this.filePicker.value = '';
        this.upload(files);
      };
      this.attachButton = button(
        '',
        () => {
          this.nativeInput.field.blur();
          this.filePicker.click();
        },
        'herdr-attach keycap chat-attach'
      );
      this.attachButton.setAttribute('aria-label', 'Attach files');
      this.attachButton.title = 'Attach files';
      this.attachButton.append(icon('attach'));
      this.promptRow.append(this.attachButton, this.promptField, this.filePicker);
      // Uploaded files wait here until the message is sent.
      this.pending = new Map(Object.entries(storage.read(this.keys.attachments, {}) || {}));
      this.previews = new Map();
      this.uploads = [];
      this.uploadAbort = new AbortController();
      this.tray = node('div', 'chat-uploads');
      this.tray.setAttribute('aria-label', 'Attachments');
      this.tray.hidden = true;
      // Like Herdr's output, the conversation's stage holds Voice's floating controls.
      this.stage = node('div', 'herdr-output-stage chat-stage');
      this.voiceTools = node('div', 'herdr-output-tools chat-voice-tools');
      this.voiceTools.onpointerdown = e => e.preventDefault();
      this.voiceTools.onclick = e => e.stopPropagation();
      this.stage.append(this.messages, this.voiceTools);
      this.threadView.append(
        threadBar,
        this.settingsPanel,
        this.stage,
        this.status,
        this.tray,
        this.promptRow
      );
      root.append(this.listView, this.threadView);
      // The shell gives the composer focus only while this detail view is showing.
      this.detail = this.threadView;

      this.nativeInput = bridge.createInput(this.threadView, true, text => this.send(text), {
        compactControls: true,
        // Sending hides the keyboard so the reply has the whole screen.
        dismissOnSend: true,
        draftStore: this.keys.drafts,
      });
      this.nativeInput.field.addEventListener('paste', e => {
        const files = [...(e.clipboardData?.items || [])]
          .filter(i => i.kind === 'file')
          .map(i => i.getAsFile())
          .filter(Boolean);
        if (files.length) {
          e.preventDefault();
          this.upload(files);
        }
      });
      // Images in messages come from the host with the client header, so they load as blobs.
      this.images = new Map();
      // The microphone works as in Herdr: tap to talk and send, hold for replies read aloud.
      this.dictation = new HyprlandDictation(
        this.nativeInput,
        () => (this.chat && !this.threadView.hidden ? this.chat.id || 'new' : null),
        this.stage,
        this.voiceTools,
        {
          group: 'Chat',
          changed: () => this.voiceChanged(),
          speaking: state => this.speaking(state),
          endpoints: {
            latest: async (voice, id) =>
              id === 'new'
                ? { session: 'new', answer: null, updates: [], paragraphs: [] }
                : (await voice.request(`${this.base}/${encodeURIComponent(id)}/response`)).json(),
            speech: id => `${this.base}/${encodeURIComponent(id)}/speech`,
            // A recording sends like a typed message, with any files waiting to go.
            send: async (voice, id) => {
              const sent =
                id === (this.chat?.id || 'new') && this.send(voice.dictation.input.draft);
              if (!(await sent)) throw Error('Not sent');
            },
          },
        }
      );
      this.promptRow.append(this.dictation.control);
      this.voiceChanged();
      // Chat is always a message: no terminal keys, and tapping the conversation hides the
      // keyboard, so the composer needs no header row.
      this.nativeInput.header.hidden = true;
      this.messages.addEventListener('click', e => {
        if (
          window.__HYPRLAND_HARDWARE_KEYBOARD__ === true ||
          this.nativeInput.element.hidden ||
          e.target.closest('a, button') ||
          !getSelection().isCollapsed
        )
          return;
        this.nativeInput.dismiss();
      });
      this.fromBottom = 0;
      this.messages.onscroll = () => {
        const m = this.messages;
        this.fromBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
        this.following = this.fromBottom < 80;
      };
      // Like Herdr: when the keyboard or the message box changes the conversation's height, the
      // text above the bottom edge stays put, so raising the keyboard pushes it up.
      this.resized = new ResizeObserver(() => {
        const m = this.messages;
        m.scrollTop = m.scrollHeight - m.clientHeight - (this.following ? 0 : this.fromBottom);
      });
      this.resized.observe(this.messages);
    }
    request(path, body) {
      return call(this.base, path, body);
    }
    // What an app built on Chat adds to each message it sends.
    sendExtras() {
      return {};
    }
    connect() {
      this.socket();
      this.refresh();
      const open = storage.get(this.keys.open);
      if (open) this.open(open);
    }
    resume() {
      if (!this.ws || this.ws.readyState > 1) this.socket();
      this.refresh();
      if (this.chat?.id) this.open(this.chat.id);
    }
    socket() {
      clearTimeout(this.retry);
      const ws = new WebSocket(
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + this.base + '/ws'
      );
      this.ws = ws;
      ws.onmessage = e => this.event(JSON.parse(e.data));
      ws.onclose = () => {
        if (this.disposed || this.ws !== ws) return;
        this.retry = setTimeout(() => {
          this.socket();
          if (this.chat?.id) this.open(this.chat.id);
        }, 2000);
      };
    }
    event(e) {
      if (e.type === 'resync') {
        if (this.chat?.id) this.open(this.chat.id);
        return;
      }
      if (e.type !== 'delta') this.listChanged();
      if (e.type === 'removed') {
        for (const id of e.ids) this.selected.delete(id);
        if (this.chat?.id && e.ids.includes(this.chat.id)) this.showList();
        return;
      }
      // While a chat loads, its events wait so none is lost or applied twice.
      if (this.buffer) {
        this.buffer.push(e);
        return;
      }
      this.apply(e);
    }
    apply(e) {
      if (!this.chat || e.id !== this.chat.id || e.n <= this.chat.n) return;
      this.chat.n = e.n;
      if (e.type === 'entry') {
        this.chat.entries[e.index] = e.entry;
        if (e.entry.role === 'assistant') this.chat.partial = '';
        this.render();
      } else if (e.type === 'delta' && e.seq > this.chat.seq) {
        this.chat.seq = e.seq;
        this.chat.partial += e.text;
        this.renderPartial();
      } else if (e.type === 'renamed') {
        this.chat.title = e.title;
        this.render();
      } else if (e.type === 'busy') {
        this.chat.busy = true;
        this.chat.error = null;
        this.renderState();
      } else if (e.type === 'done') {
        this.chat.busy = false;
        this.chat.partial = '';
        this.chat.error = e.error;
        this.render();
      }
    }
    listChanged() {
      clearTimeout(this.listTimer);
      this.listTimer = setTimeout(() => this.refresh(), 400);
    }
    async refresh() {
      try {
        const data = await this.request('');
        this.chats = data.chats;
        this.folder = data.folder;
        this.available = data.available;
        // The agents installed on the host, each with its models and effort levels.
        this.agents = data.agents?.length
          ? data.agents
          : [
              {
                id: 'claude',
                label: 'Claude',
                models: data.models || [],
                efforts: data.efforts || [],
                defaults: data.defaults || {},
              },
            ];
        this.defaultAgent = data.agent || this.agents[0]?.id || 'claude';
        this.renderSettings();
        this.renderList();
      } catch (e) {
        this.listStatus.textContent = e.message;
      }
    }
    renderList() {
      this.list.replaceChildren(
        ...this.chats.map(chat => {
          const selecting = this.selecting;
          const row = button(
            '',
            () => (selecting ? this.toggle(chat.id) : this.open(chat.id)),
            'chat-row'
          );
          row.setAttribute('role', selecting ? 'checkbox' : 'listitem');
          if (selecting) {
            const checked = this.selected.has(chat.id);
            row.setAttribute('aria-checked', String(checked));
            row.classList.toggle('selected', checked);
            row.append(node('span', 'chat-check'));
          }
          const top = node('span', 'chat-row-top');
          top.append(
            node('span', 'chat-row-title', chat.title),
            // Which agent, where there is a choice and it is not the usual one.
            ...(this.agents.length > 1 && chat.agent && chat.agent !== 'claude'
              ? [node('span', 'chat-row-agent', this.agentName(chat))]
              : []),
            node('time', '', ago(chat.updated))
          );
          row.append(top, node('span', 'chat-row-preview', chat.preview || ''));
          if (chat.busy) row.classList.add('busy');
          // A right-click or a long press offers the chat's own actions.
          if (!selecting)
            contextMenu(row, () => ({
              title: chat.title,
              items: [
                { label: 'Rename', run: () => this.rename(chat) },
                { label: 'Archive', run: () => this.manage('archive', [chat.id]) },
                {
                  label: 'Delete',
                  danger: true,
                  confirm: `Delete “${chat.title}” permanently?`,
                  run: () => this.manage('delete', [chat.id]),
                },
              ],
            }));
          return row;
        })
      );
      this.empty.hidden = !!this.chats.length || this.available === false;
      this.listStatus.textContent =
        this.available === false
          ? `Neither Claude Code nor Codex is installed on ${HyprlandApps.host.name}.`
          : this.listError || `Saved in ${this.folder || '~/Chats'}`;
      this.listStatus.classList.toggle('error', !!this.listError);
      this.newButton.disabled = this.available === false;
      this.selectButton.hidden = this.selecting || !this.chats.length;
      this.renderActions();
    }
    select(on) {
      if (on) this.listError = '';
      this.selecting = on;
      this.selected.clear();
      this.confirming = false;
      this.renderList();
    }
    toggle(id) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.confirming = false;
      this.renderList();
    }
    confirmDelete(on) {
      this.confirming = on;
      this.renderActions();
    }
    renderActions() {
      const count = this.selected.size;
      const chats = count === 1 ? 'chat' : 'chats';
      this.heading.textContent = this.selecting ? `${count} selected` : this.options.title;
      this.cancelSelect.hidden = !this.selecting;
      this.newButton.hidden = !!this.selecting;
      this.actionBar.hidden = !this.selecting;
      this.actionBar.classList.toggle('confirming', !!this.confirming);
      this.actionText.textContent = this.confirming
        ? `Delete ${count} ${chats} permanently?`
        : count
          ? ''
          : 'Select chats';
      this.archiveButton.hidden = this.deleteButton.hidden = !!this.confirming;
      this.keepButton.hidden = this.confirmButton.hidden = !this.confirming;
      this.archiveButton.disabled = this.deleteButton.disabled = !count || this.working;
      this.confirmButton.disabled = this.working;
    }
    archive() {
      return this.manage('archive');
    }
    remove() {
      return this.manage('delete');
    }
    async manage(action, ids = [...this.selected]) {
      if (!ids.length) return;
      this.working = true;
      this.renderActions();
      try {
        const result = await this.request('/' + action, { ids });
        this.select(false);
        this.listError = result.failed.length
          ? `Could not ${action} ${result.failed.length}: ${result.failed[0].error}`
          : '';
      } catch (e) {
        this.listError = e.message;
      } finally {
        this.working = false;
        this.renderActions();
        this.refresh();
      }
    }
    async rename(chat) {
      const title = await askText('Rename', {
        value: chat.title,
        label: 'Title',
        action: 'Rename',
      });
      if (!title || title === chat.title) return;
      try {
        await this.request(`/${encodeURIComponent(chat.id)}/rename`, { title });
        this.listError = '';
      } catch (e) {
        this.listError = e.message;
        this.renderList();
      }
      this.refresh();
    }
    showList() {
      this.chat = null;
      storage.set(this.keys.open, null);
      this.nativeInput.dismiss();
      this.threadView.hidden = true;
      this.listView.hidden = false;
      this.followVoice();
      this.refresh();
    }
    // Voice mode stays on from chat to chat, following the one open; a new chat that the host
    // has just named is the same conversation.
    followVoice() {
      const target = this.dictation.getTarget();
      if (target === this.voiceTarget) return;
      const named = this.voiceTarget === 'new' && target && target === this.named;
      this.voiceTarget = target;
      if (named) this.dictation.voice.retarget(target);
      else this.dictation.voice.changeThread();
    }
    // What Voice reads aloud and how far along it is, or null; Chat's own messages show it.
    speaking() {}
    voiceChanged() {
      const voice = this.dictation?.voice;
      if (!voice) return;
      this.voiceTools.hidden = !voice.enabled && !voice.loading && voice.stop.hidden;
    }
    showThread() {
      this.toggleSettings(false);
      this.renderSettings();
      this.listView.hidden = true;
      this.threadView.hidden = false;
      this.nativeInput.select(this.chat.id || 'new');
      this.followVoice();
      this.renderLabels();
      this.following = true;
      this.uploadError = '';
      this.renderTray();
      this.render();
    }
    // A chat's agent; chats from before there was a choice ran Claude.
    agentOf(chat = this.chat) {
      return chat?.agent || 'claude';
    }
    agentSpec(chat = this.chat) {
      const id = this.agentOf(chat);
      return (
        this.agents.find(agent => agent.id === id) || {
          id,
          label: id === 'codex' ? 'Codex' : id === 'claudex' ? 'Claude X' : 'Claude',
          models: [],
          efforts: [],
          defaults: {},
        }
      );
    }
    agentName(chat = this.chat) {
      return this.agentSpec(chat).label;
    }
    startNew() {
      const settings = storage.read(this.keys.settings, {}) || {};
      // New chats start with the agent last used, while it is still installed.
      const agent = this.agents.some(a => a.id === settings.agent)
        ? settings.agent
        : this.defaultAgent;
      this.chat = {
        id: null,
        title: 'New chat',
        entries: [],
        partial: '',
        seq: 0,
        busy: false,
        agent,
        model: typeof settings.model === 'string' ? settings.model : '',
        effort: typeof settings.effort === 'string' ? settings.effort : '',
      };
      this.fitSettings();
      storage.set(this.keys.open, null);
      this.showThread();
      this.bridge.keyboard();
    }
    async open(id) {
      const opening = (this.opening = id);
      this.buffer ||= [];
      try {
        const chat = await this.request('/' + encodeURIComponent(id));
        if (this.opening !== opening) return;
        this.chat = { ...chat, error: null };
        storage.set(this.keys.open, id);
        this.showThread();
        // The loaded state includes events up to its number; apply only later ones.
        const buffered = this.buffer;
        this.buffer = null;
        for (const e of buffered) this.apply(e);
      } catch (e) {
        if (this.opening !== opening) return;
        this.buffer = null;
        storage.set(this.keys.open, null);
        if (this.chat?.id === id) this.status.textContent = e.message;
      }
    }
    send(text) {
      text = text.trim();
      if (!this.chat) return false;
      const chat = this.chat;
      const draft = chat.id || 'new';
      if (this.uploads.some(u => u.draft === draft)) {
        this.uploadError = 'Wait for the upload to finish.';
        this.renderTray();
        return false;
      }
      const files = this.pending.get(draft) || [];
      if (!text && !files.length) return false;
      if (!chat.id) this.named = null;
      this.setPending(draft, []);
      if (!chat.id) {
        // Events for the new chat arrive before its id does; hold them until it opens.
        this.buffer = [];
        chat.title = text.split('\n')[0] || files[0].name;
        chat.entries.push({
          role: 'user',
          text,
          time: new Date().toISOString(),
          attachments: files.map(f => 'attachments/' + f.name),
        });
        chat.busy = true;
        this.render();
      }
      return this.request('/send', {
        id: chat.id,
        text,
        attachments: files.map(f => f.path),
        agent: this.agentOf(chat),
        model: chat.model || '',
        effort: chat.effort || '',
        ...this.sendExtras(),
      })
        .then(({ id }) => {
          // A new chat learns its id here; its state so far comes from the host.
          if (!chat.id && this.chat === chat) {
            this.named = id;
            this.open(id);
          }
          return true;
        })
        .catch(e => {
          if (!chat.id) this.buffer = null;
          // Keep the message as a draft so nothing typed is lost.
          const input = this.nativeInput;
          if (input.id === draft) {
            input.draft = text;
            input.configure();
          }
          input.storeDraft(draft, text);
          this.setPending(draft, [...files, ...(this.pending.get(draft) || [])]);
          if (this.chat === chat) {
            if (!chat.id) chat.entries.pop();
            chat.busy = false;
            chat.error = e.message;
            this.render();
          }
          return false;
        });
    }
    setPending(draft, files) {
      if (files.length) this.pending.set(draft, files);
      else this.pending.delete(draft);
      storage.write(this.keys.attachments, Object.fromEntries(this.pending));
      this.renderTray();
    }
    async upload(files) {
      if (!this.chat || !files.length || this.disposed) return;
      const draft = this.chat.id || 'new';
      const errors = [];
      for (const file of files) {
        const name = file.name || 'file';
        const waiting = (this.pending.get(draft) || []).length;
        const sending = this.uploads.filter(u => u.draft === draft).length;
        if (waiting + sending >= MAX_ATTACHMENTS) {
          errors.push(`A message can carry ${MAX_ATTACHMENTS} files.`);
          break;
        }
        if (file.size > 100 * 1024 * 1024) {
          errors.push(name + ': larger than 100 MB');
          continue;
        }
        if (!file.size) {
          errors.push(name + ': empty file');
          continue;
        }
        const job = { draft, name };
        this.uploads.push(job);
        this.renderTray();
        try {
          const response = await fetch('/api/uploads/files?name=' + encodeURIComponent(name), {
            method: 'POST',
            headers: {
              'X-Hyprland-Client': '1',
              'Content-Type': file.type || 'application/octet-stream',
            },
            body: file,
            // Large files over Tailscale take a while; the limit is on bytes, not time.
            signal: AbortSignal.any([this.uploadAbort.signal, AbortSignal.timeout(600000)]),
          });
          if (response.status === 413) throw Error('File is larger than 100 MB');
          const result = await response.json().catch(() => ({}));
          if (!response.ok || typeof result.path !== 'string')
            throw Error(result.error || 'Upload failed');
          if (result.kind === 'image') this.previews.set(result.path, URL.createObjectURL(file));
          const upload = { path: result.path, name, kind: result.kind };
          this.setPending(draft, [...(this.pending.get(draft) || []), upload]);
        } catch (e) {
          if (this.disposed) return;
          errors.push(
            name + ': ' + (e.name === 'TimeoutError' ? 'Upload timed out. Try again.' : e.message)
          );
        } finally {
          this.uploads.splice(this.uploads.indexOf(job), 1);
        }
      }
      if (this.disposed) return;
      this.uploadError = errors.join(' · ');
      this.renderTray();
      // Back to the message, as after attaching in Herdr.
      if (this.pending.get(draft)?.length && this.bridge.logic.cur() === 'chat')
        this.bridge.keyboard();
    }
    removeUpload(draft, path) {
      const url = this.previews.get(path);
      if (url) URL.revokeObjectURL(url);
      this.previews.delete(path);
      this.setPending(
        draft,
        (this.pending.get(draft) || []).filter(f => f.path !== path)
      );
    }
    renderTray() {
      if (!this.chat) return;
      const draft = this.chat.id || 'new';
      const chips = (this.pending.get(draft) || []).map(file => {
        const chip = node('div', 'chat-upload');
        const preview = this.previews.get(file.path);
        if (preview) {
          const img = node('img');
          img.src = preview;
          img.alt = '';
          chip.append(img);
        } else chip.append(icon(file.kind === 'image' ? 'attach' : 'file'));
        chip.append(node('span', 'chat-upload-name', file.name));
        const remove = iconButton(
          'close',
          'Remove ' + file.name,
          () => this.removeUpload(draft, file.path),
          'chat-upload-remove'
        );
        chip.append(remove);
        return chip;
      });
      for (const job of this.uploads.filter(u => u.draft === draft)) {
        const chip = node('div', 'chat-upload uploading');
        chip.append(icon('attach'), node('span', 'chat-upload-name', `Uploading ${job.name}…`));
        chips.push(chip);
      }
      if (this.uploadError) chips.push(node('p', 'chat-upload-error', this.uploadError));
      this.tray.replaceChildren(...chips);
      this.tray.hidden = !chips.length;
    }
    // Model and effort apply from the next message; the host restarts the chat's agent for them.
    toggleSettings(open = this.settingsPanel.hidden) {
      this.settingsPanel.hidden = !open;
      this.settingsButton.setAttribute('aria-expanded', String(open));
      if (open) this.renderSettings();
    }
    choose(key, value) {
      if (!this.chat) return;
      this.chat[key] = value;
      if (key === 'agent') this.fitSettings();
      storage.write(this.keys.settings, {
        agent: this.agentOf(),
        model: this.chat.model || '',
        effort: this.chat.effort || '',
      });
      this.renderSettings();
      this.renderLabels();
    }
    // A model or effort another agent does not offer goes back to its default.
    fitSettings() {
      const spec = this.agentSpec();
      if (this.chat.model && !spec.models.some(m => m.id === this.chat.model)) this.chat.model = '';
      if (this.chat.effort && !spec.efforts.includes(this.chat.effort)) this.chat.effort = '';
    }
    // Text that names the chat's agent.
    renderLabels() {
      const name = this.agentName();
      this.promptField.querySelector('.chat-placeholder').textContent = `Message ${name}…`;
      this.nativeInput.field.placeholder = `Message ${name}…`;
    }
    renderSettings() {
      const chat = this.chat;
      if (!chat) return;
      const spec = this.agentSpec();
      const { models, efforts, defaults } = spec;
      const short = model => String(model || '').replace(/^claude-/, '');
      const model = models.find(m => m.id === chat.model)?.label || chat.model;
      const choice = this.agents.length > 1;
      this.settingsButton.textContent = [
        choice ? spec.label : '',
        model || short(defaults.model) || 'Default',
        chat.effort || defaults.effort || 'default',
      ]
        .filter(Boolean)
        .join(' · ');
      this.settingsButton.setAttribute(
        'aria-label',
        (choice ? 'Agent, model and effort: ' : 'Model and effort: ') +
          this.settingsButton.textContent
      );
      if (this.settingsPanel.hidden) return;
      const group = (label, key, choices, current = chat[key] || '') => {
        const row = node('div', 'chat-settings-row');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', label);
        row.append(node('span', 'chat-settings-label', label));
        for (const [value, text, disabled] of choices) {
          const option = button(text, () => this.choose(key, value), 'chat-option');
          option.setAttribute('aria-pressed', String(current === value));
          option.disabled = !!disabled;
          row.append(option);
        }
        return row;
      };
      // A chat that has started keeps its agent, except between Claude and Claude X, which share
      // their conversations.
      const family = id => (id === 'codex' ? 'codex' : 'claude');
      const agentRow = choice
        ? [
            group(
              'Agent',
              'agent',
              this.agents.map(agent => [
                agent.id,
                agent.label,
                chat.id && family(agent.id) !== family(this.agentOf()),
              ]),
              this.agentOf()
            ),
          ]
        : [];
      this.settingsPanel.replaceChildren(
        ...agentRow,
        group('Model', 'model', [
          ['', defaults.model ? `Default (${short(defaults.model)})` : 'Default'],
          ...models.map(m => [m.id, m.label]),
        ]),
        group('Effort', 'effort', [
          ['', defaults.effort ? `Default (${defaults.effort})` : 'Default'],
          ...efforts.map(e => [e, e]),
        ]),
        node(
          'p',
          'chat-settings-note',
          chat.id
            ? this.agentOf() === 'codex'
              ? 'Changes apply from your next message. A Codex chat stays with Codex.'
              : this.agents.some(agent => agent.id === 'codex')
                ? 'Changes apply from your next message. Codex needs a new chat.'
                : 'Changes apply from your next message.'
            : 'Applies to this new chat.'
        )
      );
    }
    openFolder() {
      const files = HyprlandApps.get('files')?.provider;
      if (this.chat?.folder && files?.openAt) files.openAt(this.bridge, this.chat.folder);
    }
    async stop() {
      if (!this.chat?.id) return;
      this.stopButton.disabled = true;
      try {
        await this.request(`/${encodeURIComponent(this.chat.id)}/stop`, {});
      } catch (e) {
        this.status.textContent = e.message;
      } finally {
        this.stopButton.disabled = false;
      }
    }
    render() {
      const chat = this.chat;
      if (!chat) return;
      this.title.textContent = chat.title || 'New chat';
      const nodes = chat.entries.filter(Boolean).map(entry => this.entry(entry));
      if (!nodes.length)
        nodes.push(
          node(
            'p',
            'chat-empty',
            `Ask anything. ${this.agentName()} runs on ${HyprlandApps.host.name}.`
          )
        );
      this.partialNode = node('div', 'chat-message assistant streaming');
      this.partialNode.hidden = true;
      this.messages.replaceChildren(...nodes, this.partialNode);
      this.renderPartial();
      this.renderState();
    }
    entry(entry) {
      if (entry.role === 'tool') {
        const tool = node('p', 'chat-tool');
        tool.append(icon('tool'), node('b', '', entry.name));
        if (entry.text) tool.append(' ', node('span', '', entry.text));
        tool.title = entry.text ? `${entry.name}: ${entry.text}` : entry.name;
        return tool;
      }
      const message = node('div', 'chat-message ' + entry.role);
      if (entry.role === 'assistant') markdown(message, entry.text);
      else {
        if (entry.attachments?.length) message.append(this.attachments(entry.attachments));
        if (entry.text) message.append(node('span', 'chat-message-text', entry.text));
      }
      return message;
    }
    // A message's files open in Files, in the chat's attachments folder.
    attachments(paths) {
      const list = node('div', 'chat-attachments');
      const chat = this.chat;
      const files = HyprlandApps.get('files')?.provider;
      for (const path of paths) {
        const name = path.split('/').pop();
        const item = button(
          '',
          () => {
            if (chat.folder && files?.openAt)
              files.openAt(this.bridge, chat.folder + '/attachments');
          },
          'chat-attachment'
        );
        item.title = name;
        item.setAttribute('aria-label', name);
        if (chat.id && /\.(png|jpe?g|gif|webp)$/i.test(name)) {
          item.classList.add('image');
          const img = node('img');
          img.alt = name;
          img.onload = () => this.scroll();
          item.append(img);
          this.image(chat.id, name)
            .then(url => (img.src = url))
            .catch(() => item.replaceChildren(icon('file'), node('span', '', name)));
        } else item.append(icon('file'), node('span', '', name));
        list.append(item);
      }
      return list;
    }
    image(id, name) {
      const key = id + '/' + name;
      if (!this.images.has(key)) {
        const url = fetch(
          `${this.base}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`,
          {
            headers: { 'X-Hyprland-Client': '1' },
          }
        )
          .then(response => {
            if (!response.ok) throw Error('Not found');
            return response.blob();
          })
          .then(blob => URL.createObjectURL(blob));
        url.catch(() => this.images.delete(key));
        this.images.set(key, url);
      }
      return this.images.get(key);
    }
    renderPartial() {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        const text = this.chat?.partial || '';
        this.partialNode.hidden = !text;
        if (text) markdown(this.partialNode, text);
        this.scroll();
      });
    }
    renderState() {
      const chat = this.chat;
      this.stopButton.hidden = !chat?.busy || !chat.id;
      this.folderButton.hidden = !chat?.folder || !HyprlandApps.get('files')?.provider?.openAt;
      this.status.classList.toggle('error', !!chat?.error);
      this.status.classList.toggle('thinking', !chat?.error && !!chat?.busy && !chat.partial);
      this.status.textContent = chat?.error
        ? chat.error
        : chat?.busy && !chat.partial
          ? `${this.agentName()} is thinking…`
          : '';
      this.scroll();
    }
    scroll() {
      if (this.following !== false) this.messages.scrollTop = this.messages.scrollHeight;
    }
    key() {}
    show(visible) {
      if (visible && this.chat) this.renderState();
    }
    // The composer replaces the prompt row and adopts the paperclip and microphone.
    placeLatest() {
      const composing = !this.nativeInput.element.hidden;
      this.promptRow.hidden = composing;
      if (composing) {
        this.nativeInput.row.insertBefore(this.attachButton, this.nativeInput.field);
        this.nativeInput.row.insertBefore(this.dictation.control, this.nativeInput.field);
      } else {
        this.promptRow.prepend(this.attachButton);
        this.promptRow.append(this.dictation.control);
      }
    }
    get actions() {
      return this.chat && !this.threadView.hidden ? this.dictation.actions : [];
    }
    dispose() {
      this.disposed = true;
      this.resized.disconnect();
      clearTimeout(this.retry);
      clearTimeout(this.listTimer);
      this.ws?.close();
      this.uploadAbort.abort();
      this.dictation.dispose();
      for (const url of this.previews.values()) URL.revokeObjectURL(url);
      for (const url of this.images.values())
        url.then(
          u => URL.revokeObjectURL(u),
          () => {}
        );
      this.nativeInput.dispose();
    }
  }
  window.HyprlandChatApp = ChatApp;
  window.HyprlandApps?.provide('chat', {
    create: (root, bridge) => new ChatApp(root, bridge),
  });
})();
