/* Corral: a Slack-style workspace for the person and their agents. A sidebar of channels and
   direct messages beside the open conversation (one at a time on a phone). Agents are made here:
   a name, a home folder, Claude, Claude X, or Codex with a model and effort, and standing
   instructions. A direct message, an @mention, or @here wakes an agent. */
(() => {
  const { node, button, storage, contextMenu } = window.HyprlandUtil;
  const headers = { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' };
  const OPEN = 'omarchy-corral-open';
  // Folders whose agents the sidebar shows collapsed.
  const COLLAPSED = 'omarchy-corral-collapsed';
  async function request(path, body) {
    const response = await fetch(
      '/api/corral' + path,
      body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'The host did not respond.');
    return data;
  }
  const COLORS = ['blue', 'green', 'magenta', 'cyan', 'yellow', 'red'];
  const colorOf = name => {
    let hash = 0;
    for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return `var(--theme-${COLORS[hash % COLORS.length]})`;
  };
  function time(ts) {
    const d = new Date(ts);
    return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  // Messages are Markdown; DOMPurify removes anything that could run in the shell's page.
  // Links open in the browser window, and @mentions stand out.
  function markdown(target, text, names) {
    if (window.marked && window.DOMPurify)
      target.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
    else target.textContent = text;
    for (const link of target.querySelectorAll('a[href]')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.onclick = e => {
        if (window.HyprlandLinks?.open(link.href)) e.preventDefault();
      };
    }
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode())
      if (!walker.currentNode.parentElement.closest('code, a')) texts.push(walker.currentNode);
    for (const t of texts) {
      const parts = t.data.split(/(@[a-zA-Z][a-zA-Z0-9-]*)/);
      if (parts.length < 2) continue;
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        const name = part.startsWith('@') && part.slice(1).toLowerCase();
        if (name && names.has(name)) fragment.append(node('span', 'corral-mention', part));
        else fragment.append(part);
      }
      t.replaceWith(fragment);
    }
  }
  function avatar(name, label) {
    const a = node('span', 'corral-avatar', (label || name).slice(0, 1).toUpperCase());
    a.style.background = colorOf(name);
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  class CorralApp {
    constructor(root, bridge) {
      this.root = root;
      this.bridge = bridge;
      root.classList.add('corral-app');
      this.data = { agents: [], conversations: [], engines: [], person: 'you' };
      this.working = new Map();
      this.messages = [];
      // Agents' pictures, loaded once per version, as blob URLs.
      this.pictures = new Map();
      // The sidebar: channels, then a direct message with each agent.
      this.side = node('section', 'corral-side');
      const sideBar = node('div', 'corral-bar');
      sideBar.append(node('h2', 'corral-heading', 'Corral'));
      this.channelList = node('div', 'corral-list');
      this.channelList.setAttribute('role', 'list');
      this.agentList = node('div', 'corral-list');
      this.agentList.setAttribute('role', 'list');
      const section = (title, label, add, list) => {
        const head = node('div', 'corral-section');
        const plus = button('+', add, 'corral-add');
        plus.setAttribute('aria-label', label);
        plus.title = label;
        head.append(node('span', '', title), plus);
        return [head, list];
      };
      this.sideStatus = node('p', 'remote-status corral-folder');
      const scroll = node('div', 'corral-side-scroll');
      scroll.append(
        ...section('Channels', 'New channel', () => this.channelForm(), this.channelList),
        ...section('Direct messages', 'New agent', () => this.agentForm(), this.agentList)
      );
      this.side.append(sideBar, scroll, this.sideStatus);
      // The open conversation.
      this.main = node('section', 'corral-main');
      const bar = node('div', 'corral-bar');
      this.backKey = button(
        '‹',
        () => (this.threadId ? this.closeThread() : this.close()),
        'keycap corral-back'
      );
      this.backKey.setAttribute('aria-label', 'All conversations');
      this.title = node('h2', 'corral-title');
      this.subtitle = node('span', 'corral-subtitle');
      const titles = node('div', 'corral-titles');
      titles.append(this.title, this.subtitle);
      this.settingsKey = button('', () => this.editOpen(), 'keycap corral-settings');
      this.settingsKey.textContent = '⋯';
      bar.append(this.backKey, titles, this.settingsKey);
      this.list = node('div', 'corral-messages');
      // At the latest message, the list stays there as it changes size: when a working line
      // appears under it, a message arrives, or the keyboard comes and goes.
      this.pinned = true;
      this.list.addEventListener(
        'scroll',
        () => {
          this.pinned = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
        },
        { passive: true }
      );
      this.list.setAttribute('role', 'log');
      this.workingLine = node('div', 'corral-working');
      this.workingText = node('span', '');
      this.stopKey = button('Stop', () => this.stop(), 'keycap small');
      this.workingLine.append(this.workingText, this.stopKey);
      this.workingLine.hidden = true;
      this.suggestions = node('div', 'corral-suggest');
      this.choices = [];
      this.cycle = null;
      this.suggestions.hidden = true;
      this.promptRow = node('div', 'herdr-prompt-row corral-prompt-row');
      this.promptField = button('', () => bridge.keyboard());
      this.promptField.className = 'prompt-field herdr-prompt corral-prompt';
      this.promptField.setAttribute('aria-label', 'Write a message');
      this.placeholder = node('span', 'corral-placeholder', 'Message');
      this.promptField.append(this.placeholder);
      this.promptRow.append(this.promptField);
      this.main.append(bar, this.list, this.workingLine, this.suggestions, this.promptRow);
      this.main.hidden = true;
      this.sheet = node('section', 'corral-sheet');
      this.sheet.hidden = true;
      root.append(this.side, this.main, this.sheet);
      // The shell gives the composer focus only while a conversation shows.
      this.detail = this.main;
      this.nativeInput = bridge.createInput(this.main, true, text => this.send(text), {
        compactControls: true,
        draftStore: 'omarchy-corral-drafts',
      });
      this.nativeInput.field.addEventListener('input', () => this.suggest());
      // Ahead of the composer's own keys, which would send Tab and Escape on.
      this.nativeInput.field.addEventListener('keydown', e => this.mentionKeys(e), true);
      this.resized = new ResizeObserver(() => {
        this.root.classList.toggle('corral-wide', this.root.clientWidth >= 700);
        this.layout();
      });
      this.resized.observe(root);
      this.listResized = new ResizeObserver(() => this.pin());
      this.listResized.observe(this.list);
    }
    connect() {
      this.socket();
      this.refresh().then(() => {
        const open = storage.get(OPEN);
        if (open && this.conversation(open)) this.open(open);
      });
    }
    resume() {
      if (!this.ws || this.ws.readyState > 1) this.socket();
      this.refresh();
      if (this.openId) this.open(this.openId);
    }
    socket() {
      clearTimeout(this.retry);
      const ws = new WebSocket(
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/corral/ws'
      );
      this.ws = ws;
      ws.onmessage = e => this.event(JSON.parse(e.data));
      ws.onclose = () => {
        if (this.disposed || this.ws !== ws) return;
        this.retry = setTimeout(() => this.resume(), 2000);
      };
    }
    event(e) {
      if (e.type === 'message') {
        const summary = this.conversation(e.conversation);
        if (summary) summary.last = e.message;
        if (e.conversation === this.openId && !this.messages.some(m => m.id === e.message.id)) {
          this.messages.push(e.message);
          this.renderMessages(true);
        }
        this.renderSide();
      } else if (e.type === 'status') {
        const key = [e.conversation, e.agent, e.thread || ''].join(' ');
        if (e.status) this.working.set(key, e.status);
        else this.working.delete(key);
        this.renderWorking();
        this.renderSide();
      } else if (e.type === 'resync') {
        this.resume();
      } else if (e.type === 'removed' && e.conversation === this.openId) {
        this.close();
        this.refresh();
      } else this.later();
    }
    // Several changes at once refresh the workspace once.
    later() {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh(), 200);
    }
    async refresh() {
      try {
        this.data = await request('');
        this.working = new Map();
        for (const c of this.data.conversations)
          for (const w of c.working || [])
            this.working.set([c.id, w.agent, w.thread || ''].join(' '), w.status);
        this.error = '';
      } catch (e) {
        this.error = e.message;
      }
      this.renderSide();
      if (this.openId) this.renderHeader();
      this.renderWorking();
    }
    conversation(id) {
      return this.data.conversations.find(c => c.id === id) || null;
    }
    agent(id) {
      return this.data.agents.find(a => a.id === id) || null;
    }
    // A message's author as people see it: the person, an agent's @name, or Corral.
    author(id) {
      if (id === 'you') return this.data.person || 'you';
      if (id === 'corral') return 'Corral';
      const a = this.agent(id);
      return a ? a.name : 'removed agent';
    }
    names() {
      // Lowercased: mentions ignore case.
      return new Set(['you', 'here', ...this.data.agents.map(a => a.name.toLowerCase())]);
    }
    label(c) {
      if (c.kind === 'channel') return '#' + c.name;
      return '@' + (this.agent(c.members[0])?.name || 'removed');
    }
    renderSide() {
      const rows = [];
      for (const c of this.data.conversations.filter(c => c.kind === 'channel')) {
        const row = button('', () => this.open(c.id), 'corral-row');
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-current', String(c.id === this.openId));
        row.append(node('span', 'corral-hash', '#'), node('span', 'corral-row-name', c.name));
        if ([...this.working.keys()].some(k => k.startsWith(c.id + ' ')))
          row.append(node('span', 'corral-busy', ''));
        contextMenu(row, () => ({
          title: '#' + c.name,
          items: [
            { label: 'Edit channel', run: () => this.channelForm(c) },
            {
              label: 'Delete channel',
              danger: true,
              confirm: `Delete #${c.name} and its messages?`,
              run: () => this.remove(c.id),
            },
          ],
        }));
        rows.push(row);
      }
      if (!rows.length) rows.push(node('p', 'corral-empty', 'No channels yet.'));
      this.channelList.replaceChildren(...rows);
      const agentRows = new Map();
      for (const a of this.data.agents) {
        const dm = this.data.conversations.find(c => c.kind === 'dm' && c.members[0] === a.id);
        const row = button('', () => this.direct(a.id), 'corral-row corral-agent-row');
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-current', String(!!dm && dm.id === this.openId));
        const busy = [...this.working.keys()].filter(k => k.split(' ')[1] === a.id);
        const where = busy.map(k => this.conversation(k.split(' ')[0])).filter(Boolean);
        const status = where.length
          ? 'working in ' + where.map(c => this.label(c)).join(', ')
          : [this.engineLabel(a.engine), a.model].filter(Boolean).join(' · ');
        const text = node('span', 'corral-row-text');
        text.append(
          node('span', 'corral-row-name', a.name),
          node('span', 'corral-row-status', status)
        );
        row.append(this.face(a), text);
        if (where.length) row.append(node('span', 'corral-busy', ''));
        contextMenu(row, () => ({
          title: '@' + a.name,
          items: [
            { label: 'Edit agent', run: () => this.agentForm(a) },
            {
              label: 'Delete agent',
              danger: true,
              confirm: `Delete @${a.name}, its direct messages, and its memory?`,
              run: () => this.deleteAgent(a),
            },
          ],
        }));
        agentRows.set(a.id, { row, busy: where.length > 0 });
      }
      // Agents whose home folders share a parent group under it, collapsible; the rest stand alone.
      const parent = a => a.home.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
      const groups = new Map();
      for (const a of this.data.agents)
        groups.set(parent(a), [...(groups.get(parent(a)) || []), a]);
      const collapsed = new Set(storage.read(COLLAPSED, []) || []);
      const agents = [];
      for (const a of this.data.agents) {
        const members = groups.get(parent(a));
        if (members.length < 2) {
          agents.push(agentRows.get(a.id).row);
          continue;
        }
        if (members[0] !== a) continue;
        const folder = parent(a);
        const shut = collapsed.has(folder);
        const head = button(
          '',
          () => {
            const next = new Set(storage.read(COLLAPSED, []) || []);
            if (next.has(folder)) next.delete(folder);
            else next.add(folder);
            storage.write(COLLAPSED, [...next]);
            this.renderSide();
          },
          'corral-group-head'
        );
        head.setAttribute('aria-expanded', String(!shut));
        head.title = window.HyprlandApps.tilde(folder);
        head.append(
          node('span', 'corral-caret', '›'),
          node('span', 'corral-row-name', folder.split('/').pop() || folder),
          node('span', 'corral-count', String(members.length))
        );
        if (shut && members.some(m => agentRows.get(m.id).busy))
          head.append(node('span', 'corral-busy', ''));
        const group = node('div', 'corral-folder-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', folder.split('/').pop() || folder);
        group.append(head);
        if (!shut) for (const m of members) group.append(agentRows.get(m.id).row);
        agents.push(group);
      }
      if (!agents.length)
        agents.push(node('p', 'corral-empty', 'Make an agent with + to start talking.'));
      this.agentList.replaceChildren(...agents);
      this.sideStatus.textContent = this.error || `Saved in ${this.data.folder || '~/Corral'}`;
      this.sideStatus.classList.toggle('error', !!this.error);
    }
    // An agent's picture, which it sets by saving avatar.png in its folder, or its initial.
    face(agent, name = agent?.name || '', label = name) {
      const face = avatar(name, label);
      if (!agent?.avatar) return face;
      const key = agent.id + ':' + agent.avatar;
      if (!this.pictures.has(key))
        this.pictures.set(
          key,
          fetch(`/api/corral/agents/${encodeURIComponent(agent.id)}/avatar?v=${agent.avatar}`, {
            headers,
          })
            .then(r => (r.ok ? r.blob() : Promise.reject()))
            .then(blob => URL.createObjectURL(blob))
        );
      this.pictures.get(key).then(
        url => {
          const img = node('img');
          img.src = url;
          img.alt = '';
          face.replaceChildren(img);
          face.classList.add('picture');
        },
        () => {}
      );
      return face;
    }
    engineLabel(id) {
      return this.data.engines.find(e => e.id === id)?.label || id;
    }
    async direct(agent) {
      try {
        const dm = await request('/dm', { agent });
        if (!this.conversation(dm.id)) this.data.conversations.push(dm);
        this.open(dm.id);
      } catch (e) {
        this.sideStatus.textContent = e.message;
      }
    }
    async open(id) {
      this.closeSheet();
      this.threadId = null;
      this.openId = id;
      storage.set(OPEN, id);
      this.nativeInput.select('corral:' + id);
      this.messages = [];
      this.layout();
      this.renderHeader();
      this.renderMessages();
      this.renderSide();
      try {
        const data = await request('/conversations/' + encodeURIComponent(id));
        if (this.openId !== id) return;
        this.messages = data.messages;
        for (const w of data.working || [])
          this.working.set([id, w.agent, w.thread || ''].join(' '), w.status);
        this.renderMessages();
        this.renderWorking();
      } catch (e) {
        if (this.openId === id) this.list.replaceChildren(node('p', 'corral-empty', e.message));
      }
    }
    // A thread replaces the conversation's messages until its back key; the composer replies in it.
    openThread(id) {
      if (!this.messages.some(m => m.id === id && !m.thread)) return;
      this.threadId = id;
      this.nativeInput.select('corral:' + this.openId + '/' + id);
      this.layout();
      this.renderHeader();
      this.renderMessages();
      this.renderWorking();
    }
    closeThread() {
      this.threadId = null;
      this.nativeInput.select('corral:' + this.openId);
      this.layout();
      this.renderHeader();
      this.renderMessages();
      this.renderWorking();
    }
    close() {
      this.threadId = null;
      this.openId = null;
      storage.set(OPEN, null);
      this.nativeInput.dismiss();
      this.layout();
      this.renderSide();
    }
    // One view at a time on a phone; both side by side when there is room.
    layout() {
      const wide = this.root.classList.contains('corral-wide');
      this.main.hidden = !this.openId || !this.sheet.hidden;
      this.side.hidden = !wide && (!!this.openId || !this.sheet.hidden);
      this.backKey.hidden = wide && !this.threadId;
    }
    renderHeader() {
      const c = this.conversation(this.openId);
      if (!c) return;
      this.backKey.setAttribute(
        'aria-label',
        this.threadId ? 'Back to ' + this.label(c) : 'All conversations'
      );
      if (this.threadId) {
        this.title.textContent = 'Thread';
        this.subtitle.textContent = this.label(c);
        this.subtitle.title = '';
        this.placeholder.textContent = 'Reply in thread';
        return;
      }
      this.title.textContent = this.label(c);
      if (c.kind === 'channel') {
        const members = c.members.map(id => '@' + this.author(id));
        this.subtitle.textContent = c.topic || `${members.length + 1} members`;
        this.subtitle.title = ['@you', ...members].join(', ');
        this.placeholder.textContent = `Message #${c.name} · @mention an agent`;
        this.settingsKey.setAttribute('aria-label', 'Channel settings');
      } else {
        const a = this.agent(c.members[0]);
        this.subtitle.textContent = a
          ? [this.engineLabel(a.engine), a.model, window.HyprlandApps.tilde(a.home)]
              .filter(Boolean)
              .join(' · ')
          : '';
        this.placeholder.textContent = `Message @${a?.name || 'agent'}`;
        this.settingsKey.setAttribute('aria-label', 'Agent settings');
      }
      this.settingsKey.title = this.settingsKey.getAttribute('aria-label');
    }
    renderMessages(append = false) {
      const names = this.names();
      const items = [];
      let last = null;
      const thread = this.threadId;
      // A thread shows its message and the replies; the conversation, the messages outside
      // threads, each with how many replies it has.
      const shown = thread
        ? this.messages.filter(m => m.id === thread || m.thread === thread)
        : this.messages.filter(m => !m.thread);
      const replies = new Map();
      for (const m of this.messages)
        if (m.thread) replies.set(m.thread, [...(replies.get(m.thread) || []), m]);
      for (const m of shown) {
        if (m.author === 'corral') {
          const note = node('div', 'corral-note');
          markdown(note, m.text, names);
          items.push(note);
          last = null;
          continue;
        }
        const gap = last && Date.parse(m.ts) - Date.parse(last.ts) < 5 * 60 * 1000;
        if (!gap || last.author !== m.author) {
          const group = node('div', 'corral-group');
          const name = this.author(m.author);
          const head = node('div', 'corral-head');
          head.append(node('span', 'corral-name', name), node('time', '', time(m.ts)));
          const body = node('div', 'corral-bodies');
          body.append(head);
          group.append(
            this.face(this.agent(m.author), m.author === 'you' ? 'you' : name, name),
            body
          );
          items.push(group);
          last = { ...m, body };
        } else last.ts = m.ts;
        const text = node('div', 'corral-text');
        markdown(text, m.text, names);
        last.body.append(text);
        last.author = m.author;
        if (!thread) {
          // Reply in thread: on hover, or from the message's menu.
          const answer = button('Reply', () => this.openThread(m.id), 'corral-reply-key');
          answer.setAttribute('aria-label', 'Reply in thread');
          text.append(answer);
          contextMenu(text, () => ({
            title: this.author(m.author),
            items: [{ label: 'Reply in thread', run: () => this.openThread(m.id) }],
          }));
          const these = replies.get(m.id);
          if (these) {
            const more = button('', () => this.openThread(m.id), 'corral-replies');
            more.textContent = `${these.length} ${these.length === 1 ? 'reply' : 'replies'}`;
            more.append(node('time', '', 'last ' + time(these.at(-1).ts)));
            last.body.append(more);
            last = null;
          }
        } else if (m.id === thread) {
          const count = replies.get(thread)?.length || 0;
          items.push(
            node(
              'div',
              'corral-divider',
              count ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'No replies yet'
            )
          );
          last = null;
        }
      }
      if (!shown.length) {
        const c = this.conversation(this.openId);
        items.push(
          node(
            'p',
            'corral-empty',
            c?.kind === 'channel'
              ? `This is the start of #${c.name}. Mention an agent with @ to bring it in.`
              : 'This is the start of your direct messages.'
          )
        );
      }
      this.list.replaceChildren(...items);
      if (!append) this.pinned = true;
      this.pin();
    }
    // Keeps the latest message in view while the list is pinned to it.
    pin() {
      if (this.pinned) this.list.scrollTop = this.list.scrollHeight;
    }
    // What agents are doing here: in the thread when one is open, or in the conversation, where
    // work in its threads is marked as such.
    renderWorking() {
      const busy = [...this.working.entries()]
        .map(([k, status]) => [...k.split(' '), status])
        .filter(([c, , t]) => c === this.openId && (!this.threadId || t === this.threadId));
      this.workingLine.hidden = !this.openId || !busy.length;
      this.workingText.textContent = busy
        .map(([, agent, t, status]) => {
          const name = '@' + this.author(agent) + (t && !this.threadId ? ' in a thread' : '');
          return status === 'thinking' ? `${name} is thinking…` : `${name} · ${status}`;
        })
        .join('   ');
    }
    // Names to mention, offered while an @word is being typed.
    suggest() {
      this.cycle = null;
      const field = this.nativeInput.field;
      const before = field.value.slice(0, field.selectionStart);
      const m = before.match(/(?:^|\s)@([a-zA-Z0-9-]*)$/);
      const c = this.conversation(this.openId);
      if (!m || !c) {
        this.suggestions.hidden = true;
        this.choices = [];
        return;
      }
      const q = m[1].toLowerCase();
      this.choices = [
        ...this.data.agents.map(a => a.name),
        ...(c.kind === 'channel' ? ['here'] : []),
      ]
        .filter(n => n.toLowerCase().startsWith(q))
        .slice(0, 8);
      // Where the @word starts, which a chosen name replaces up to the caret.
      this.mentionAt = field.selectionStart - m[1].length - 1;
      this.renderSuggestions();
    }
    renderSuggestions(active = -1) {
      const field = this.nativeInput.field;
      this.suggestions.hidden = !this.choices.length;
      this.suggestions.replaceChildren(
        ...this.choices.map((name, i) => {
          const b = button(
            '@' + name,
            () => {
              this.complete(name);
              this.accept();
              field.focus();
            },
            'keycap small corral-suggestion'
          );
          b.classList.toggle('active', i === active);
          b.setAttribute('aria-pressed', String(i === active));
          b.onpointerdown = e => e.preventDefault();
          return b;
        })
      );
    }
    // Puts @name in place of the @word being typed, or of the name Tab put there.
    complete(name) {
      const field = this.nativeInput.field;
      field.setRangeText('@' + name, this.mentionAt, field.selectionStart, 'end');
      this.nativeInput.saveDraft();
    }
    // Keeps the name, with a space after it, and closes the suggestions.
    accept() {
      const field = this.nativeInput.field;
      field.setRangeText(' ', field.selectionStart, field.selectionEnd, 'end');
      this.nativeInput.saveDraft();
      this.cycle = null;
      this.choices = [];
      this.suggestions.hidden = true;
    }
    // Tab and Shift-Tab step through the names, each put in place as it is reached; Return
    // keeps the one there, and Escape closes the suggestions.
    mentionKeys(e) {
      if (this.suggestions.hidden || !this.choices?.length || e.isComposing) return;
      if (e.key === 'Tab') {
        const step = e.shiftKey ? -1 : 1;
        const n = this.choices.length;
        this.cycle = this.cycle === null ? (step > 0 ? 0 : n - 1) : (this.cycle + step + n) % n;
        this.complete(this.choices[this.cycle]);
        this.renderSuggestions(this.cycle);
      } else if (e.key === 'Enter' && this.cycle !== null && !e.shiftKey) {
        this.accept();
      } else if (e.key === 'Escape') {
        this.cycle = null;
        this.choices = [];
        this.suggestions.hidden = true;
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    send(text) {
      text = text.trim();
      const id = this.openId;
      if (!text || !id) return false;
      this.suggestions.hidden = true;
      this.cycle = null;
      // What you send is what you want to see.
      this.pinned = true;
      const thread = this.threadId || '';
      return request(`/conversations/${encodeURIComponent(id)}/messages`, { text, thread }).then(
        message => {
          if (this.openId === id && !this.messages.some(m => m.id === message.id)) {
            this.messages.push(message);
            this.renderMessages();
          }
          return true;
        },
        e => {
          this.workingText.textContent = e.message;
          this.workingLine.hidden = false;
          return false;
        }
      );
    }
    async stop() {
      if (this.openId) await request(`/conversations/${encodeURIComponent(this.openId)}/stop`, {});
    }
    async remove(id) {
      try {
        await request(`/conversations/${encodeURIComponent(id)}/delete`, {});
        if (this.openId === id) this.close();
        this.refresh();
      } catch (e) {
        this.sideStatus.textContent = e.message;
      }
    }
    async deleteAgent(a) {
      try {
        await request(`/agents/${encodeURIComponent(a.id)}/delete`, {});
        const dm = this.data.conversations.find(c => c.kind === 'dm' && c.members[0] === a.id);
        if (dm && dm.id === this.openId) this.close();
        this.closeSheet();
        this.refresh();
      } catch (e) {
        this.sideStatus.textContent = e.message;
      }
    }
    editOpen() {
      const c = this.conversation(this.openId);
      if (!c) return;
      if (c.kind === 'channel') this.channelForm(c);
      else if (this.agent(c.members[0])) this.agentForm(this.agent(c.members[0]));
    }
    // Forms take the place of the conversation until saved or cancelled.
    showSheet(title, build) {
      this.nativeInput.dismiss();
      const form = node('form', 'corral-form');
      const bar = node('div', 'corral-bar');
      const cancel = button('Cancel', () => this.closeSheet(), 'chat-text-button');
      bar.append(node('h2', 'corral-heading', title), cancel);
      this.formError = node('p', 'corral-form-error');
      this.formError.setAttribute('role', 'alert');
      build(form);
      this.sheet.replaceChildren(bar, form);
      form.append(this.formError);
      this.sheet.hidden = false;
      this.layout();
      form.querySelector('input,textarea,select')?.focus({ preventScroll: true });
      return form;
    }
    closeSheet() {
      if (this.sheet.hidden) return;
      this.folderPicker?.dispose();
      this.folderPicker = null;
      this.sheet.hidden = true;
      this.sheet.replaceChildren();
      this.layout();
    }
    field(form, label, control, note) {
      const wrap = node('label', 'corral-field');
      wrap.append(node('span', 'corral-label', label), control);
      if (note) wrap.append(node('span', 'corral-note-text', note));
      form.append(wrap);
      return control;
    }
    input(value = '', placeholder = '') {
      const i = node('input', 'corral-input');
      i.value = value;
      i.placeholder = placeholder;
      i.autocapitalize = 'none';
      i.autocomplete = 'off';
      i.spellcheck = false;
      return i;
    }
    select(options, value) {
      const s = node('select', 'corral-input');
      for (const [id, label] of options) {
        const o = node('option', '', label);
        o.value = id;
        s.append(o);
      }
      s.value = options.some(([id]) => id === value) ? value : options[0]?.[0] || '';
      return s;
    }
    agentForm(a = null) {
      const engines = this.data.engines;
      this.showSheet(a ? 'Edit @' + a.name : 'New agent', form => {
        const name = this.field(
          form,
          'Name',
          this.input(a?.name || '', 'AsBuilt'),
          'Mention it as @name, in any case.'
        );
        const engine = this.field(
          form,
          'Agent',
          this.select(
            engines.map(e => [e.id, e.label]),
            a?.engine || engines[0]?.id
          )
        );
        const model = this.field(form, 'Model', this.select([['', 'Default']], ''));
        const effort = this.field(form, 'Effort', this.select([['', 'Default']], ''));
        const fill = () => {
          const spec = engines.find(e => e.id === engine.value) || { models: [], efforts: [] };
          const keep = [model.value || a?.model || '', effort.value || a?.effort || ''];
          model.replaceChildren(
            ...[['', 'Default'], ...spec.models.map(m => [m.id, m.label])].map(([id, label]) => {
              const o = node('option', '', label);
              o.value = id;
              return o;
            })
          );
          effort.replaceChildren(
            ...[['', 'Default'], ...spec.efforts.map(e => [e, e])].map(([id, label]) => {
              const o = node('option', '', label);
              o.value = id;
              return o;
            })
          );
          model.value = spec.models.some(m => m.id === keep[0]) ? keep[0] : '';
          effort.value = spec.efforts.includes(keep[1]) ? keep[1] : '';
        };
        engine.onchange = fill;
        fill();
        const home = this.input(a?.home || '', '~/git/project');
        const homeRow = node('div', 'corral-home');
        const choose = button('Choose…', () => this.chooseHome(home), 'keycap small');
        homeRow.append(home, choose);
        this.field(form, 'Home folder', homeRow, 'Where its sessions start.');
        const instructions = node('textarea', 'corral-input corral-instructions');
        instructions.rows = 5;
        instructions.value = a?.instructions || '';
        instructions.placeholder = 'What this agent is for and how it should work.';
        this.field(form, 'Instructions', instructions, 'Given to it in every conversation.');
        const actions = node('div', 'corral-actions');
        const save = button(a ? 'Save' : 'Create agent', () => {}, 'remote-button corral-save');
        save.type = 'submit';
        actions.append(save);
        if (a) {
          const del = button(
            'Delete agent',
            () => {
              if (del.dataset.armed) return this.deleteAgent(a);
              del.dataset.armed = '1';
              del.textContent = `Delete @${a.name} for good?`;
            },
            'remote-button chat-danger'
          );
          actions.append(del);
        }
        form.append(actions);
        form.onsubmit = async e => {
          e.preventDefault();
          save.disabled = true;
          try {
            const body = {
              name: name.value,
              engine: engine.value,
              model: model.value,
              effort: effort.value,
              home: home.value,
              instructions: instructions.value,
            };
            const saved = await request(
              a ? '/agents/' + encodeURIComponent(a.id) : '/agents',
              body
            );
            this.closeSheet();
            await this.refresh();
            if (!a) this.direct(saved.id);
            else if (this.openId) this.renderHeader();
          } catch (err) {
            this.formError.textContent = err.message;
          } finally {
            save.disabled = false;
          }
        };
      });
    }
    // The Files app picks the home folder, as Herdr's new pane does.
    chooseHome(input) {
      if (this.folderPicker || !window.HostFilesApp) return;
      const overlay = node('div', 'herdr-folder-picker corral-folder-picker');
      this.root.append(overlay);
      const close = () => {
        this.folderPicker?.dispose();
        this.folderPicker = null;
        overlay.remove();
      };
      this.folderPicker = new window.HostFilesApp(overlay, null, 'corral-folder', {
        path: input.value || undefined,
        pick: {
          title: 'Home folder',
          label: 'use this folder',
          cancel: close,
          choose: path => {
            input.value = window.HyprlandApps.tilde(path);
            close();
          },
        },
      });
    }
    channelForm(c = null) {
      this.showSheet(c ? 'Edit #' + c.name : 'New channel', form => {
        const name = this.field(form, 'Name', this.input(c?.name || '', 'infra'));
        const topic = this.field(form, 'Topic', this.input(c?.topic || '', 'What it is for'));
        const members = node('div', 'corral-members');
        const boxes = this.data.agents.map(a => {
          const label = node('label', 'corral-member');
          const box = node('input');
          box.type = 'checkbox';
          box.value = a.id;
          box.checked = !!c?.members.includes(a.id);
          label.append(box, this.face(a), node('span', '', '@' + a.name));
          members.append(label);
          return box;
        });
        if (!boxes.length) members.append(node('p', 'corral-empty', 'No agents yet.'));
        this.field(form, 'Members', members, 'Mentioning an agent also brings it in.');
        const actions = node('div', 'corral-actions');
        const save = button(c ? 'Save' : 'Create channel', () => {}, 'remote-button corral-save');
        save.type = 'submit';
        actions.append(save);
        if (c) {
          const del = button(
            'Delete channel',
            () => {
              if (del.dataset.armed) return this.remove(c.id).then(() => this.closeSheet());
              del.dataset.armed = '1';
              del.textContent = `Delete #${c.name} for good?`;
            },
            'remote-button chat-danger'
          );
          actions.append(del);
        }
        form.append(actions);
        form.onsubmit = async e => {
          e.preventDefault();
          save.disabled = true;
          try {
            const body = {
              name: name.value,
              topic: topic.value,
              members: boxes.filter(b => b.checked).map(b => b.value),
            };
            const saved = await request(
              c ? '/conversations/' + encodeURIComponent(c.id) : '/channels',
              body
            );
            this.closeSheet();
            await this.refresh();
            this.open(saved.id);
          } catch (err) {
            this.formError.textContent = err.message;
          } finally {
            save.disabled = false;
          }
        };
      });
    }
    navigateBack() {
      if (this.folderPicker) {
        this.folderPicker.dispose();
        this.folderPicker = null;
        this.root.querySelector('.corral-folder-picker')?.remove();
        return true;
      }
      if (!this.sheet.hidden) {
        this.closeSheet();
        return true;
      }
      if (this.threadId) {
        this.closeThread();
        return true;
      }
      if (this.openId && !this.root.classList.contains('corral-wide')) {
        this.close();
        return true;
      }
      return false;
    }
    hostChanged() {
      this.renderSide();
    }
    // While the composer is open it stands in for the prompt row, as in Chat.
    placeLatest() {
      this.promptRow.hidden = !this.nativeInput.element.hidden;
    }
    key() {}
    dispose() {
      this.disposed = true;
      clearTimeout(this.retry);
      clearTimeout(this.refreshTimer);
      this.ws?.close();
      this.resized.disconnect();
      this.listResized.disconnect();
      for (const url of this.pictures.values())
        url.then(
          u => URL.revokeObjectURL(u),
          () => {}
        );
      this.folderPicker?.dispose();
      this.nativeInput.dispose();
    }
  }
  window.HyprlandApps?.provide('corral', { create: (root, bridge) => new CorralApp(root, bridge) });
})();
