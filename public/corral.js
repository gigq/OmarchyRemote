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
  // Whether the details panel is open, and when each place was last looked at, on this device.
  const DETAILS = 'omarchy-corral-details';
  const SEEN = 'omarchy-corral-seen';
  // What Activity is narrowed to: an agent, or a room's agents.
  const FILTER = 'omarchy-corral-activity-filter';
  // Which panel the details panel shows: Activity or Search.
  const PANEL = 'omarchy-corral-panel';
  // Whether an agent's direct message shows the messages or the agent's work everywhere.
  const MODE = 'omarchy-corral-dm-mode';
  const PANELS = [
    ['activity', 'Activity'],
    ['search', 'Search'],
    ['renders', 'Renders'],
  ];
  const FILTER_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>';
  const PANEL_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4z" fill="currentColor" stroke="none"/></svg>';
  // An agent at work: green for a turn under way, amber for work it left running in the background.
  function dot(background = false) {
    const d = node('span', background ? 'corral-busy background' : 'corral-busy');
    d.title = background ? 'Running in the background' : 'Working';
    return d;
  }
  // When a message was sent: the time today, otherwise the day.
  function when(ts) {
    const d = new Date(ts);
    if (Number.isNaN(+d)) return '';
    return d.toDateString() === new Date().toDateString()
      ? time(ts)
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  async function request(path, body) {
    const response = await fetch(
      '/api/corral' + path,
      body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'The host did not respond.');
    return data;
  }
  // Reactions, as the host lists them: a message's menu offers all but 👀, which agents use to say
  // they have taken a message on.
  const REACTIONS = [
    ['\u{1F44D}', 'thumbs up'],
    ['\u{1F44E}', 'thumbs down'],
    ['\u{1F44C}', 'OK, noted'],
    ['\u{1F680}', 'do it'],
    ['\u{1F440}', 'on it'],
    ['\u2753', 'please explain'],
  ];
  const OFFERED = REACTIONS.filter(([e]) => e !== '\u{1F440}');
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

  // Dictation hears names as words: "at as built" for @AsBuilt, "hash moving records" for
  // #MovingRecords. This second pass turns what sounds close to a real agent or channel into its
  // mention, and a message that opens by addressing an agent ("As built, …") mentions it.
  const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  function distance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++)
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
      row = next;
    }
    return row[b.length];
  }
  // How far a heard name may be from the real one: not at all for a short name, more for a long.
  function closeness(heard, name) {
    const d = distance(heard, name);
    return d <= (name.length <= 4 ? 0 : name.length <= 8 ? 1 : 2) ? d : null;
  }
  const AT = new Set(['at', '@']);
  const HASH = new Set(['hash', 'hashtag', 'pound', '#']);
  const GREETINGS = new Set(['hey', 'hi', 'ok', 'okay', 'yo']);
  function spokenMentions(text, agents, channels) {
    const words = [...text.matchAll(/[@#]|[A-Za-z0-9][A-Za-z0-9'’_-]*/g)].map(m => ({
      word: m[0],
      start: m.index,
      end: m.index + m[0].length,
    }));
    const gap = (i, j) => text.slice(words[i].end, words[j].start);
    // The closest name heard in up to four words from `from`; a tie goes to the longer name, and
    // a possessive keeps its 's.
    const heardName = (from, names) => {
      let found = null;
      let heard = '';
      for (let i = from; i < Math.min(words.length, from + 4); i++) {
        if (i > from && !/^\s+$/.test(gap(i - 1, i))) break;
        const word = words[i].word;
        if (word === '@' || word === '#') break;
        const tries = [[heard + squash(word), '']];
        if (/['’]s$/i.test(word)) tries.push([heard + squash(word.slice(0, -2)), word.slice(-2)]);
        heard += squash(word);
        for (const [sound, suffix] of tries)
          for (const name of names) {
            const d = closeness(sound, squash(name));
            if (
              d !== null &&
              (!found || d < found.d || (d === found.d && name.length >= found.name.length))
            )
              found = { name, suffix, end: i, d };
          }
      }
      return found;
    };
    const marks = [];
    const mark = (start, found, sign) =>
      marks.push({ start, end: words[found.end].end, text: sign + found.name + found.suffix });
    const first = words[0] && GREETINGS.has(words[0].word.toLowerCase()) ? 1 : 0;
    const opening = words[first] && heardName(first, agents);
    let i = 0;
    if (opening && /^\s*[,:.!?]/.test(text.slice(words[opening.end].end))) {
      mark(words[first].start, opening, '@');
      i = opening.end + 1;
    }
    for (; i < words.length - 1; i++) {
      const word = words[i].word.toLowerCase();
      const sign = AT.has(word) ? '@' : HASH.has(word) ? '#' : '';
      if (!sign || !/^\s*$/.test(gap(i, i + 1))) continue;
      const found = heardName(i + 1, sign === '@' ? [...agents, 'here', 'everyone'] : channels);
      if (!found) continue;
      mark(words[i].start, found, sign);
      i = found.end;
    }
    for (const m of marks.reverse()) text = text.slice(0, m.start) + m.text + text.slice(m.end);
    return text;
  }
  window.HyprlandCorral = { spokenMentions };

  class CorralApp {
    constructor(root, bridge) {
      this.root = root;
      this.bridge = bridge;
      root.classList.add('corral-app');
      this.data = { agents: [], conversations: [], engines: [], person: 'you' };
      this.working = new Map();
      // What agents left running after their turns, by `conversation agent thread`.
      this.background = new Map();
      // Messages waiting for an agent at work, by id: the agents they wait for.
      this.queued = new Map();
      this.messages = [];
      // Agents' pictures, loaded once per version, as blob URLs.
      this.pictures = new Map();
      // The sidebar: channels, then a direct message with each agent.
      this.side = node('section', 'corral-side');
      const sideBar = node('div', 'corral-bar');
      // The panel key lives in the conversation's bar, beside the panel it opens; the sidebar
      // has one only while no conversation shows.
      this.sidePanelKey = this.panelKey();
      sideBar.append(node('h2', 'corral-heading', 'Corral'), this.sidePanelKey);
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
      this.mainPanelKey = this.panelKey();
      bar.append(this.backKey, titles, this.mainPanelKey, this.settingsKey);
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
      // As in Chat, the conversation's stage holds Voice's floating controls.
      this.stage = node('div', 'herdr-output-stage corral-stage');
      this.voiceTools = node('div', 'herdr-output-tools corral-voice-tools');
      this.voiceTools.onpointerdown = e => e.preventDefault();
      this.voiceTools.onclick = e => e.stopPropagation();
      // An agent's direct message has a second view: what it is doing and has said everywhere.
      this.dmMode = storage.read(MODE) === 'work' ? 'work' : 'messages';
      this.modeTabs = node('div', 'corral-tabs corral-modes');
      this.modeTabs.setAttribute('role', 'tablist');
      this.modeTabs.setAttribute('aria-label', 'View');
      for (const [id, label] of [
        ['messages', 'Messages'],
        ['work', 'Work'],
      ]) {
        const tab = button(label, () => this.setMode(id), 'corral-tab');
        tab.setAttribute('role', 'tab');
        tab.dataset.mode = id;
        this.modeTabs.append(tab);
      }
      this.workList = node('div', 'corral-work');
      this.workList.setAttribute('role', 'list');
      this.workList.setAttribute('aria-label', 'Work');
      this.recent = [];
      this.stage.append(this.list, this.workList, this.voiceTools);
      this.main.append(
        bar,
        this.modeTabs,
        this.stage,
        this.workingLine,
        this.suggestions,
        this.promptRow
      );
      this.main.hidden = true;
      this.sheet = node('section', 'corral-sheet');
      this.sheet.hidden = true;
      // The details panel, on the right as in an editor: for now, Activity, every place a
      // conversation is going with its latest message, newest first.
      this.details = node('section', 'corral-details');
      const detailsBar = node('div', 'corral-bar');
      const shut = button('×', () => this.toggleDetails(false), 'keycap corral-back');
      shut.setAttribute('aria-label', 'Close the panel');
      // Its panels, one at a time.
      this.tabs = node('div', 'corral-tabs');
      this.tabs.setAttribute('role', 'tablist');
      this.tabs.setAttribute('aria-label', 'Panel');
      for (const [id, label] of PANELS) {
        const tab = button(label, () => this.showPanel(id), 'corral-tab');
        tab.setAttribute('role', 'tab');
        tab.dataset.panel = id;
        this.tabs.append(tab);
      }
      // Narrows Activity to the agent or room open when it is pressed, until pressed again.
      this.filterKey = button(
        '',
        () => this.toggleFilter(),
        'keycap corral-back corral-filter-key'
      );
      this.filterKey.innerHTML = FILTER_ICON;
      this.filterKey.setAttribute('aria-label', 'Filter to the agent or room open');
      detailsBar.append(this.tabs, this.filterKey, shut);
      this.filterNote = node('p', 'corral-filter-note');
      this.activityList = node('div', 'corral-side-scroll corral-activity');
      this.activityList.setAttribute('role', 'list');
      this.activityList.setAttribute('aria-label', 'Activity');
      // Search: every message, narrowed as you type.
      this.searchField = node('input', 'corral-input corral-search');
      this.searchField.type = 'search';
      this.searchField.placeholder = 'Search messages';
      this.searchField.setAttribute('aria-label', 'Search messages');
      this.searchField.autocapitalize = 'none';
      this.searchField.spellcheck = false;
      this.searchField.addEventListener('input', () => this.searchLater());
      this.searchList = node('div', 'corral-side-scroll corral-activity');
      this.searchList.setAttribute('role', 'list');
      this.searchList.setAttribute('aria-label', 'Search results');
      this.results = [];
      // Renders: each machine's render queue.
      this.renderList = node('div', 'corral-side-scroll corral-activity corral-renders');
      this.renderList.setAttribute('role', 'list');
      this.renderList.setAttribute('aria-label', 'Render queues');
      this.details.append(
        detailsBar,
        this.searchField,
        this.filterNote,
        this.activityList,
        this.searchList,
        this.renderList
      );
      this.panel = PANELS.some(([id]) => id === storage.read(PANEL, ''))
        ? storage.read(PANEL)
        : 'activity';
      this.filter = storage.read(FILTER, null);
      this.activity = [];
      this.detailsOpen = !!storage.read(DETAILS, false);
      this.showPanel(this.panel, false);
      this.seen = storage.read(SEEN, {}) || {};
      root.append(this.side, this.main, this.sheet, this.details);
      // The shell gives the composer focus only while a conversation shows.
      this.detail = this.main;
      this.nativeInput = bridge.createInput(this.main, true, text => this.send(text), {
        compactControls: true,
        draftStore: 'omarchy-corral-drafts',
      });
      this.nativeInput.field.addEventListener('input', () => this.suggest());
      // Ahead of the composer's own keys, which would send Tab and Escape on.
      this.nativeInput.field.addEventListener('keydown', e => this.mentionKeys(e), true);
      // The microphone works as in Chat: tap to talk and send, hold for replies read aloud. The
      // composer's key is `corral:<conversation>` or `corral:<conversation>/<thread>`.
      const voicePath = (key, end) => {
        const [conversation, thread = ''] = key.slice('corral:'.length).split('/');
        const at = `/api/corral/conversations/${encodeURIComponent(conversation)}/${end}`;
        return at + '?thread=' + encodeURIComponent(thread);
      };
      this.dictation = new HyprlandDictation(
        this.nativeInput,
        () => (this.openId && !this.main.hidden ? this.nativeInput.id : null),
        this.stage,
        this.voiceTools,
        {
          group: 'Corral',
          changed: () => this.voiceChanged(),
          revise: text =>
            spokenMentions(
              text,
              this.data.agents.map(a => a.name),
              this.data.conversations.filter(c => c.kind === 'channel').map(c => c.name)
            ),
          endpoints: {
            latest: async (voice, key) => (await voice.request(voicePath(key, 'response'))).json(),
            speech: key => voicePath(key, 'speech'),
            send: async (voice, key) => {
              const sent = key === this.nativeInput.id && this.send(voice.dictation.input.draft);
              if (!(await sent)) throw Error('Not sent');
            },
          },
        }
      );
      this.promptRow.append(this.dictation.control);
      this.voiceChanged();
      this.resized = new ResizeObserver(() => {
        this.root.classList.toggle('corral-wide', this.root.clientWidth >= 700);
        // Room for the details panel beside the conversation.
        this.root.classList.toggle('corral-roomy', this.root.clientWidth >= 1000);
        this.layout();
      });
      this.resized.observe(root);
      this.listResized = new ResizeObserver(() => this.pin());
      this.listResized.observe(this.list);
    }
    connect() {
      this.socket();
      if (this.detailsOpen) this.showPanel(this.panel);
      this.refresh().then(() => {
        // The conversation, or the thread in it, open last time.
        const [open, thread = ''] = String(storage.get(OPEN) || '').split('/');
        if (open && this.conversation(open)) this.open(open, thread);
      });
    }
    resume() {
      if (!this.ws || this.ws.readyState > 1) this.socket();
      this.refresh();
      if (this.detailsOpen) this.loadActivity();
      // Reconnecting, as when the host restarts, keeps a thread open.
      if (this.openId) this.open(this.openId, this.threadId || '');
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
        // What arrives where you are looking counts as seen.
        if (this.showing(e.conversation, e.message.thread || '')) this.markSeen();
        this.renderSide();
        if (this.detailsOpen) this.activityLater();
        if (this.detailsOpen && this.panel === 'search' && this.searchAsked) this.searchLater();
        if (this.workAgent() === e.message.author) this.workLater();
      } else if (e.type === 'status') {
        const key = [e.conversation, e.agent, e.thread || ''].join(' ');
        if (e.status) this.working.set(key, e.status);
        else this.working.delete(key);
        if (this.workAgent()) this.renderWork();
        this.renderWorking();
        this.renderSide();
        if (this.detailsOpen) this.renderActivity();
      } else if (e.type === 'closed') {
        if (this.detailsOpen) this.activityLater();
      } else if (e.type === 'deleted') {
        this.removeMessages(e.conversation, e.messages || []);
      } else if (e.type === 'queued') {
        const before = [...this.queued.keys()].join();
        this.setQueued(e.queued);
        if ([...this.queued.keys()].join() !== before) this.renderMessages();
      } else if (e.type === 'background') {
        this.setBackground(e.background);
        if (this.workAgent()) this.renderWork();
        this.renderWorking();
        this.renderSide();
        if (this.detailsOpen) this.renderActivity();
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
        this.setBackground(this.data.background);
        this.setQueued(this.data.queued);
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
        if ([...this.working.keys()].some(k => k.startsWith(c.id + ' '))) row.append(dot());
        else if ([...this.background.keys()].some(k => k.startsWith(c.id + ' ')))
          row.append(dot(true));
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
        const places = keys =>
          [...keys]
            .filter(k => k.split(' ')[1] === a.id)
            .map(k => this.conversation(k.split(' ')[0]))
            .filter(Boolean);
        const where = places(this.working.keys());
        const waiting = places(this.background.keys());
        const machine = a.host && this.host(a.host);
        const status = where.length
          ? 'working in ' + where.map(c => this.label(c)).join(', ')
          : waiting.length
            ? 'running in the background in ' + waiting.map(c => this.label(c)).join(', ')
            : machine && !machine.online
              ? `${a.host} is not reachable`
              : [this.engineLabel(a.engine), a.model].filter(Boolean).join(' · ');
        const text = node('span', 'corral-row-text');
        text.append(
          node('span', 'corral-row-name', a.name),
          node('span', 'corral-row-status', status)
        );
        row.append(this.face(a), text);
        if (where.length) row.append(dot());
        else if (waiting.length) row.append(dot(true));
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
        agentRows.set(a.id, { row, busy: where.length > 0, waiting: waiting.length > 0 });
      }
      // Agents whose home folders on this host share a parent group under that folder. Groups
      // collapse; an agent alone in its folder stands alone, as does one on another host, whose
      // machine its conversation names.
      const parent = a => a.home.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
      const groups = new Map();
      for (const a of this.data.agents.filter(a => !a.host))
        groups.set(parent(a), [...(groups.get(parent(a)) || []), a]);
      const collapsed = new Set(storage.read(COLLAPSED, []) || []);
      const agents = [];
      for (const a of this.data.agents) {
        const members = a.host ? [a] : groups.get(parent(a));
        if (members.length < 2) {
          agents.push(agentRows.get(a.id).row);
          continue;
        }
        if (members[0] !== a) continue;
        const folder = parent(a);
        const label = folder.split('/').pop() || folder;
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
          node('span', 'corral-row-name', label),
          node('span', 'corral-count', String(members.length))
        );
        if (shut && members.some(m => agentRows.get(m.id).busy)) head.append(dot());
        else if (shut && members.some(m => agentRows.get(m.id).waiting)) head.append(dot(true));
        const group = node('div', 'corral-folder-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', label);
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
    // Another host whose agents are here, and whether it answered.
    host(name) {
      return (this.data.hosts || []).find(h => h.name === name);
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
    // Opens a conversation, or with `thread`, that thread in it, which alone counts as seen.
    async open(id, thread = '') {
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
      if (!thread) this.markSeen();
      if (this.workAgent()) {
        this.recent = [];
        this.renderWork();
        this.loadWork();
      }
      try {
        const data = await request('/conversations/' + encodeURIComponent(id));
        if (this.openId !== id) return;
        this.messages = data.messages;
        for (const w of data.working || [])
          this.working.set([id, w.agent, w.thread || ''].join(' '), w.status);
        this.renderMessages();
        this.renderWorking();
        if (thread) this.openThread(thread);
      } catch (e) {
        if (this.openId === id) this.list.replaceChildren(node('p', 'corral-empty', e.message));
      }
    }
    // A thread replaces the conversation's messages until its back key; the composer replies in it.
    openThread(id) {
      if (!this.messages.some(m => m.id === id && !m.thread)) return;
      this.threadId = id;
      storage.set(OPEN, this.openId + '/' + id);
      this.nativeInput.select('corral:' + this.openId + '/' + id);
      this.layout();
      this.renderHeader();
      this.renderMessages();
      this.renderWorking();
      this.markSeen();
    }
    closeThread() {
      this.threadId = null;
      storage.set(OPEN, this.openId);
      this.nativeInput.select('corral:' + this.openId);
      this.layout();
      this.renderHeader();
      this.renderMessages();
      this.renderWorking();
      this.markSeen();
    }
    close() {
      this.threadId = null;
      this.openId = null;
      storage.set(OPEN, null);
      this.nativeInput.dismiss();
      this.layout();
      this.renderSide();
    }
    // Voice follows the conversation or thread on screen.
    followVoice() {
      if (!this.dictation) return;
      const target = this.dictation.getTarget();
      if (target === this.voiceTarget) return;
      this.voiceTarget = target;
      this.dictation.voice.changeThread();
    }
    panelKey() {
      const key = button('', () => this.toggleDetails(), 'keycap corral-settings corral-panel-key');
      key.innerHTML = PANEL_ICON;
      key.setAttribute('aria-label', 'Activity and Search');
      key.title = 'Activity and Search: the latest everywhere, and every message';
      return key;
    }
    toggleDetails(open = !this.detailsOpen) {
      this.detailsOpen = open;
      storage.write(DETAILS, open);
      this.layout();
      if (open) this.showPanel(this.panel);
    }
    // Shows one of the details panel's panels; `load` fetches what it lists.
    showPanel(id, load = true) {
      this.panel = id;
      storage.write(PANEL, id);
      for (const tab of this.tabs.children) {
        const on = tab.dataset.panel === id;
        tab.setAttribute('aria-selected', String(on));
        tab.classList.toggle('active', on);
      }
      const searching = id === 'search';
      this.activityList.hidden = id !== 'activity';
      this.searchField.hidden = !searching;
      this.searchList.hidden = !searching;
      this.renderList.hidden = id !== 'renders';
      this.filterKey.hidden = id === 'renders';
      clearTimeout(this.rendersTimer);
      if (!load) return;
      if (id === 'renders') {
        this.filterNote.hidden = true;
        this.loadRenders();
      } else if (searching) {
        this.renderSearch();
        // Ready to type, except where a keyboard would cover the panel.
        if (window.matchMedia?.('(pointer: fine)').matches) this.searchField.focus();
      } else this.loadActivity();
    }
    // The queues, every few seconds while Renders shows.
    async loadRenders() {
      clearTimeout(this.rendersTimer);
      try {
        const renders = await request('/renders');
        this.renders = renders.machines || [];
        this.splits = renders.splits || [];
        this.rendersError = '';
      } catch (e) {
        this.rendersError = e.message;
      }
      if (this.panel !== 'renders' || !this.detailsOpen || this.disposed) return;
      this.renderRenders();
      this.rendersTimer = setTimeout(() => this.loadRenders(), 5000);
    }
    renderRenders() {
      const ago = ts => {
        const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
        return s < 60
          ? `${Math.round(s)} s`
          : s < 3600
            ? `${Math.round(s / 60)} min`
            : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
      };
      const rows = [];
      // Renders shared out across the farm: how far along, and about how long is left.
      const span = s =>
        s < 60
          ? 'under a minute'
          : s < 3600
            ? `${Math.round(s / 60)} min`
            : s < 172800
              ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
              : `${Math.floor(s / 86400)} days ${Math.round((s % 86400) / 3600)} h`;
      const progressBar = done => {
        const bar = node('span', 'corral-split-bar');
        const fill = node('span', '');
        fill.style.width = `${Math.round(100 * Math.min(1, done))}%`;
        bar.append(fill);
        return bar;
      };
      if (this.splits?.length) {
        const head = node('div', 'corral-render-machine');
        head.append(node('span', 'corral-row-name', 'Split across the farm'));
        rows.push(head);
      }
      for (const split of this.splits || []) {
        const [conversation = '', agent = '', thread = ''] = (split.place || '').split('\t');
        const who = this.agent(agent) ? '@' + this.author(agent) : split.cwd.split(/[\\/]/).pop();
        const row = button(
          '',
          () => this.conversation(conversation) && this.goTo({ conversation, thread }),
          'corral-activity-row corral-render-job corral-split'
        );
        row.setAttribute('role', 'listitem');
        const place = node('div', 'corral-activity-place');
        place.append(
          node(
            'span',
            'corral-row-name',
            split.left == null ? 'Estimating time left…' : `About ${span(split.left)} left`
          ),
          node('time', '', `${split.done} of ${split.pieces} pieces`)
        );
        const bar = progressBar(split.done / Math.max(1, split.pieces));
        const text = node('span', 'corral-row-text');
        text.append(
          place,
          bar,
          node(
            'span',
            'corral-activity-text',
            `${who}: ${split.label} · running ${ago(new Date(split.started * 1000).toISOString())}`
          )
        );
        row.append(dot(), text);
        rows.push(row);
      }
      for (const machine of this.renders || []) {
        const q = machine.queue;
        const head = node('div', 'corral-render-machine');
        head.append(node('span', 'corral-row-name', machine.name));
        if (!machine.online || !q) {
          head.append(node('span', 'corral-offline', 'not reachable'));
          rows.push(head);
          continue;
        }
        const running = q.jobs.filter(j => j.running);
        const used = running.reduce((n, j) => n + j.cores, 0) + q.legacy * 4;
        const seats = running.filter(j => j.gpu).length;
        head.append(
          node(
            'span',
            'corral-count',
            `${used} of ${q.budget.cores} cores · GPU ${seats} of ${q.budget.gpus}`
          )
        );
        rows.push(head);
        if (q.legacy)
          rows.push(
            node(
              'p',
              'corral-render-note',
              `${q.legacy} ${q.legacy === 1 ? 'job' : 'jobs'} from before the queue`
            )
          );
        if (!q.jobs.length) rows.push(node('p', 'corral-render-note', 'Nothing queued.'));
        for (const job of q.jobs) {
          const [conversation = '', agent = '', thread = ''] = (job.place || '').split('\t');
          const who = this.agent(agent) ? '@' + this.author(agent) : job.cwd.split(/[\\/]/).pop();
          const row = button(
            '',
            () => this.conversation(conversation) && this.goTo({ conversation, thread }),
            'corral-activity-row corral-render-job'
          );
          row.setAttribute('role', 'listitem');
          row.classList.toggle('waiting', !job.running);
          const place = node('div', 'corral-activity-place');
          place.append(
            node(
              'span',
              'corral-row-name',
              job.running
                ? `Running ${ago(job.started)}`
                : `#${job.position} · waiting ${ago(job.since)}`
            ),
            node('time', '', `${job.cores} cores${job.gpu ? ' + GPU' : ''}`)
          );
          // A piece of a split render says so, rather than looking like a job of its own.
          const label = job.label || '';
          const split = (this.splits || []).find(
            s => s.place === job.place && (label === s.label || label.startsWith(s.label + ' · '))
          );
          const piece = split
            ? 'Part of the split above'
            : / · (frames \d+–\d+|piece \d+|mix)$/.test(label)
              ? 'Part of a split render'
              : '';
          // How far along, when its log says.
          const p = job.running && job.progress;
          const text = node('span', 'corral-row-text');
          text.append(place);
          if (p) text.append(progressBar(p.done));
          text.append(
            node(
              'span',
              'corral-activity-text',
              `${who}: ${job.label || job.command}${p ? ` · ${p.counted} · about ${span(p.left)} left` : ''}`
            )
          );
          if (piece) text.append(node('span', 'corral-row-status corral-piece', piece));
          if (job.running) row.append(dot());
          else row.append(dot(true));
          row.append(text);
          rows.push(row);
        }
      }
      if (!rows.length)
        rows.push(node('p', 'corral-empty', this.rendersError || 'No render queues found.'));
      this.renderList.replaceChildren(...rows);
    }
    // Typing narrows the results once it pauses.
    searchLater() {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 150);
    }
    async runSearch() {
      const query = this.searchField.value.trim();
      const asked = (this.searchAsked = query);
      if (!query) {
        this.results = [];
        this.searchError = '';
        return this.renderSearch();
      }
      try {
        const { items } = await request('/search?q=' + encodeURIComponent(query));
        if (asked !== this.searchAsked) return;
        this.results = items || [];
        this.searchError = '';
      } catch (e) {
        this.searchError = e.message;
      }
      this.renderSearch();
    }
    // The words searched for, highlighted where they are in a result's text.
    highlighted(text) {
      const words = this.searchAsked
        ?.split(/\s+/)
        .map(w => w.replace(/^[@#]+/, ''))
        .filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const out = node('span', 'corral-activity-text');
      if (!words?.length) {
        out.textContent = text;
        return out;
      }
      const pattern = new RegExp(`(${words.join('|')})`, 'gi');
      for (const part of text.split(pattern))
        out.append(
          part && new RegExp(`^(${words.join('|')})$`, 'i').test(part)
            ? node('mark', 'corral-hit', part)
            : part
        );
      return out;
    }
    renderSearch() {
      if (this.panel !== 'search') return;
      this.renderFilter();
      const rows = [];
      for (const item of this.results) {
        const c = this.conversation(item.conversation);
        if (!c || !this.kept(item, c)) continue;
        const m = item.message;
        const name = this.author(m.author);
        const row = button('', () => this.goTo(item, m.id), 'corral-activity-row');
        row.setAttribute('role', 'listitem');
        const where = node('div', 'corral-activity-place');
        where.append(
          node('span', 'corral-row-name', (item.thread ? 'Thread in ' : '') + this.label(c)),
          node('time', '', when(m.ts))
        );
        const text = node('span', 'corral-row-text');
        const said = this.highlighted(m.text);
        said.prepend(node('span', 'corral-name', name + ': '));
        text.append(where, said);
        row.append(this.face(this.agent(m.author), m.author === 'you' ? 'you' : name, name), text);
        rows.push(row);
      }
      const query = this.searchField.value.trim();
      const name = this.filter && this.filterName();
      if (!rows.length)
        rows.push(
          node(
            'p',
            'corral-empty',
            this.searchError ||
              (!query
                ? 'Search every message in every conversation and thread: all the words, in any order.'
                : `No messages${name ? ' for ' + name : ''} with ${query}.`)
          )
        );
      else
        rows.unshift(
          node(
            'p',
            'corral-filter-count',
            `${rows.length}${this.results.length >= 200 ? '+' : ''} ${rows.length === 1 ? 'message' : 'messages'}`
          )
        );
      this.searchList.replaceChildren(...rows);
    }
    async loadActivity() {
      try {
        this.activity = (await request('/activity')).items || [];
        this.activityError = '';
      } catch (e) {
        this.activityError = e.message;
      }
      this.renderActivity();
    }
    // Several messages at once load the list once.
    activityLater() {
      clearTimeout(this.activityTimer);
      this.activityTimer = setTimeout(() => this.loadActivity(), 300);
    }
    // Whether a place (a conversation, or a thread in it) is on screen.
    showing(conversation, thread) {
      return (
        !this.main.hidden &&
        !document.hidden &&
        conversation === this.openId &&
        thread === (this.threadId || '')
      );
    }
    // The place on screen counts as read up to now, on this device.
    markSeen() {
      if (!this.openId) return;
      this.seen[this.openId + '/' + (this.threadId || '')] = new Date().toISOString();
      const keys = Object.keys(this.seen);
      // The most recent few hundred places are enough.
      if (keys.length > 400)
        for (const k of keys.sort((a, b) => this.seen[a].localeCompare(this.seen[b])).slice(0, 100))
          delete this.seen[k];
      storage.write(SEEN, this.seen);
      if (this.detailsOpen) this.renderActivity();
    }
    // The agent or room open now, as a filter: a direct message filters to its agent.
    filterHere() {
      const c = this.conversation(this.openId);
      if (!c) return null;
      return c.kind === 'dm' ? { kind: 'agent', id: c.members[0] } : { kind: 'room', id: c.id };
    }
    toggleFilter() {
      this.filter = this.filter ? null : this.filterHere();
      storage.write(FILTER, this.filter);
      if (this.panel === 'search') this.renderSearch();
      else this.renderActivity();
    }
    // What the filter is, for a person; null once its agent or room is gone.
    filterName() {
      const f = this.filter;
      if (f?.kind === 'agent' && this.agent(f.id)) return '@' + this.author(f.id);
      const room = f?.kind === 'room' && this.conversation(f.id);
      return room ? `${this.label(room)}'s agents` : null;
    }
    // Whether a place belongs in Activity as filtered: one the agent wrote in or is the direct
    // message with, or for a room, the room itself and anywhere its agents are.
    kept(item, c) {
      const f = this.filter;
      if (!f) return true;
      const agents = new Set(f.kind === 'agent' ? [f.id] : this.conversation(f.id)?.members || []);
      return (
        item.conversation === f.id ||
        (item.agents || []).some(a => agents.has(a)) ||
        (c.kind === 'dm' && agents.has(c.members[0]))
      );
    }
    // The filter key and the note saying what it keeps; returns its name, if it is on.
    renderFilter() {
      // A filter whose agent or room was deleted goes, once the workspace has loaded.
      if (this.filter && this.data.conversations.length && !this.filterName()) {
        this.filter = null;
        storage.write(FILTER, null);
      }
      const name = this.filter && this.filterName();
      this.filterKey.setAttribute('aria-pressed', String(!!this.filter));
      this.filterKey.disabled = !this.filter && !this.filterHere();
      this.filterKey.title = this.filter
        ? 'Show everything'
        : this.filterHere()
          ? 'Show only what is for the agent or room open'
          : 'Open an agent or a room to filter by it';
      this.filterNote.hidden = !name;
      this.filterNote.textContent = name ? 'Only ' + name : '';
      return name;
    }
    renderActivity() {
      if (this.details.hidden && !this.detailsOpen) return;
      if (this.panel !== 'activity') return;
      const name = this.renderFilter();
      const rows = [];
      for (const item of this.activity) {
        const c = this.conversation(item.conversation);
        if (!c || !this.kept(item, c)) continue;
        const m = item.message;
        const key = item.conversation + '/' + item.thread;
        const fresh = m.author !== 'you' && m.ts > (this.seen[key] || '');
        const here = keys =>
          [...keys].some(k => {
            const [conv, , thread = ''] = k.split(' ');
            return conv === item.conversation && thread === item.thread;
          });
        const busy = here(this.working.keys());
        const waiting = here(this.background.keys());
        const row = button('', () => this.goTo(item), 'corral-activity-row');
        row.setAttribute('role', 'listitem');
        row.classList.toggle('fresh', fresh);
        row.setAttribute(
          'aria-current',
          String(item.conversation === this.openId && item.thread === (this.threadId || ''))
        );
        const name = this.author(m.author);
        const where = node('div', 'corral-activity-place');
        where.append(
          node('span', 'corral-row-name', (item.thread ? 'Thread in ' : '') + this.label(c)),
          node('time', '', when(m.ts))
        );
        if (busy) where.append(dot());
        else if (waiting) where.append(dot(true));
        const text = node('span', 'corral-row-text');
        text.append(where);
        if (item.root)
          text.append(
            node(
              'span',
              'corral-activity-root',
              `${this.author(item.root.author)}: ${item.root.text}`
            )
          );
        text.append(node('span', 'corral-activity-text', `${name}: ${m.text}`));
        if (item.replies)
          text.append(
            node(
              'span',
              'corral-row-status',
              `${item.replies} ${item.replies === 1 ? 'reply' : 'replies'}`
            )
          );
        row.append(this.face(this.agent(m.author), m.author === 'you' ? 'you' : name, name), text);
        if (fresh) row.setAttribute('aria-label', `New: ${this.label(c)}, ${name}: ${m.text}`);
        // Closing a row hides it here until a newer message comes to that place.
        const close = button('\u00d7', () => this.closeActivity(item), 'corral-activity-close');
        close.title = 'Close until something new comes';
        close.setAttribute(
          'aria-label',
          `Close ${(item.thread ? 'thread in ' : '') + this.label(c)}`
        );
        const holder = node('div', 'corral-activity-item');
        holder.append(row, close);
        rows.push(holder);
      }
      if (!rows.length)
        rows.push(
          node(
            'p',
            'corral-empty',
            this.activityError ||
              (name ? `Nothing yet for ${name}.` : 'Conversations show here as they go.')
          )
        );
      this.activityList.replaceChildren(...rows);
    }
    async closeActivity(item) {
      this.activity = this.activity.filter(
        a => a.conversation !== item.conversation || a.thread !== item.thread
      );
      this.renderActivity();
      try {
        await request('/activity/close', { conversation: item.conversation, thread: item.thread });
      } catch (e) {
        this.activityError = e.message;
        this.loadActivity();
      }
    }
    // Opens a place from Activity as if it were opened from the sidebar or its message.
    // With `message`, it is shown and lit, as a search result is.
    async goTo(item, message) {
      if (!this.root.classList.contains('corral-roomy')) this.toggleDetails(false);
      if (this.workAgent() && item.conversation === this.openId) this.setMode('messages');
      if (item.conversation !== this.openId || (this.threadId && !item.thread))
        await this.open(item.conversation, item.thread);
      else if (item.thread) this.openThread(item.thread);
      if (message) this.reveal(message);
    }
    reveal(id) {
      const text = this.list.querySelector(`[data-message="${CSS.escape(id)}"]`);
      if (!text) return;
      this.pinned = false;
      text.scrollIntoView({ block: 'center' });
      text.classList.remove('revealed');
      void text.offsetWidth;
      text.classList.add('revealed');
    }
    voiceChanged() {
      const voice = this.dictation?.voice;
      if (!voice) return;
      this.voiceTools.hidden = !voice.enabled && !voice.loading && voice.stop.hidden;
    }
    // One view at a time on a phone; both side by side when there is room.
    layout() {
      const wide = this.root.classList.contains('corral-wide');
      // Without room beside the conversation, the details panel takes its place.
      const over = this.detailsOpen && !this.root.classList.contains('corral-roomy');
      this.main.hidden = !this.openId || !this.sheet.hidden || over;
      this.side.hidden = !wide && (!!this.openId || !this.sheet.hidden || over);
      this.details.hidden = !this.detailsOpen || (!wide && !this.sheet.hidden);
      for (const key of this.root.querySelectorAll('.corral-panel-key'))
        key.setAttribute('aria-pressed', String(this.detailsOpen));
      if (this.detailsOpen && this.filterKey)
        this.filterKey.disabled = !this.filter && !this.filterHere();
      this.backKey.hidden = wide && !this.threadId;
      this.sidePanelKey.hidden = !this.main.hidden;
      this.layoutMode();
      this.followVoice();
    }
    // The Messages and Work tabs, for an agent's direct message outside a thread.
    workAgent() {
      const c = this.conversation(this.openId);
      return c?.kind === 'dm' && !this.threadId && this.dmMode === 'work' ? c.members[0] : null;
    }
    layoutMode() {
      if (!this.modeTabs) return;
      const c = this.conversation(this.openId);
      this.modeTabs.hidden = !(c?.kind === 'dm' && !this.threadId);
      for (const tab of this.modeTabs.children) {
        const on = tab.dataset.mode === this.dmMode;
        tab.setAttribute('aria-selected', String(on));
        tab.classList.toggle('active', on);
      }
      const work = !!this.workAgent();
      this.list.hidden = work;
      this.workList.hidden = !work;
      this.main.classList.toggle('corral-at-work', work);
    }
    setMode(mode) {
      this.dmMode = mode;
      storage.write(MODE, mode);
      this.layoutMode();
      if (mode === 'work') this.loadWork();
      else this.pin();
    }
    async loadWork() {
      const agent = this.workAgent();
      if (!agent) return;
      try {
        const { items } = await request(`/agents/${encodeURIComponent(agent)}/recent`);
        if (this.workAgent() !== agent) return;
        this.recent = items;
        this.workError = '';
      } catch (e) {
        this.workError = e.message;
      }
      this.renderWork();
    }
    workLater() {
      clearTimeout(this.workTimer);
      this.workTimer = setTimeout(() => this.loadWork(), 300);
    }
    // What the agent is doing now, in any place: turns under way, then work left running; then its
    // latest message in each place it has written, newest first. A row opens its place.
    renderWork() {
      const agent = this.workAgent();
      if (!agent) return;
      const where = (conversation, thread) => {
        const c = this.conversation(conversation);
        return c ? (thread ? 'Thread in ' : '') + this.label(c) : 'removed';
      };
      const row = (place, item, first, second, at, live) => {
        const r = button('', () => this.goTo(item, item.message?.id), 'corral-activity-row');
        r.setAttribute('role', 'listitem');
        const head = node('div', 'corral-activity-place');
        head.append(node('span', 'corral-row-name', place));
        if (at) head.append(node('time', '', when(at)));
        if (live) head.append(dot(live === 'background'));
        const text = node('span', 'corral-row-text');
        text.append(head);
        if (first) text.append(node('span', 'corral-activity-root', first));
        text.append(node('span', 'corral-activity-text', second));
        r.append(text);
        return r;
      };
      const rows = [node('h3', 'corral-work-heading', 'Now')];
      const mine = map =>
        [...map.entries()]
          .map(([k, value]) => [...k.split(' '), value])
          .filter(([, a]) => a === agent);
      const busy = mine(this.working);
      const left = mine(this.background);
      for (const [c, , t, status] of busy)
        rows.push(
          row(
            where(c, t),
            { conversation: c, thread: t },
            '',
            status === 'thinking' ? 'Thinking…' : status,
            '',
            'turn'
          )
        );
      for (const [c, , t, command] of left)
        rows.push(
          row(
            where(c, t),
            { conversation: c, thread: t },
            '',
            'In the background: ' + command,
            '',
            'background'
          )
        );
      if (!busy.length && !left.length) rows.push(node('p', 'corral-empty', 'Nothing under way.'));
      rows.push(node('h3', 'corral-work-heading', 'Latest everywhere'));
      for (const item of this.recent) {
        if (!this.conversation(item.conversation)) continue;
        rows.push(
          row(
            where(item.conversation, item.thread),
            item,
            item.root ? `${this.author(item.root.author)}: ${item.root.text}` : '',
            item.message.text,
            item.message.ts
          )
        );
      }
      if (!this.recent.length)
        rows.push(node('p', 'corral-empty', this.workError || 'It has not written anywhere yet.'));
      this.workList.replaceChildren(...rows);
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
          ? [
              this.engineLabel(a.engine),
              a.model,
              a.host && 'on ' + a.host,
              a.host ? a.home : window.HyprlandApps.tilde(a.home),
            ]
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
      // Reactions show on the message they are to, not as messages of their own.
      const reactions = new Map();
      for (const m of this.messages)
        if (m.reacts) reactions.set(m.reacts, [...(reactions.get(m.reacts) || []), m]);
      const said = this.messages.filter(m => !m.reacts);
      const shown = thread
        ? said.filter(m => m.id === thread || m.thread === thread)
        : said.filter(m => !m.thread);
      const replies = new Map();
      for (const m of said)
        if (m.thread) replies.set(m.thread, [...(replies.get(m.thread) || []), m]);
      for (const m of shown) {
        if (m.author === 'corral') {
          const note = node('div', 'corral-note');
          markdown(note, m.text, names);
          contextMenu(note, pressed => ({
            title: 'Corral',
            items: [...this.textItems(m, note, pressed), this.deleteItem(m, 0)],
          }));
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
        text.dataset.message = m.id;
        markdown(text, m.text, names);
        last.body.append(text);
        // Sent, but the agent it is for is still at work: it gets it when that turn ends.
        const waiting = this.queued.get(m.id);
        if (waiting) {
          text.classList.add('queued');
          last.body.append(
            node(
              'div',
              'corral-queued',
              `Waiting for ${waiting.map(a => '@' + this.author(a)).join(', ')} to finish ${waiting.length > 1 ? 'their' : 'its'} current turn`
            )
          );
        }
        last.author = m.author;
        const given = reactions.get(m.id);
        if (given) last.body.append(this.reactionChips(m, given));
        if (!thread) {
          // Reply in thread: on hover, or from the message's menu.
          const answer = button('Reply', () => this.openThread(m.id), 'corral-reply-key');
          answer.setAttribute('aria-label', 'Reply in thread');
          text.append(answer);
          const these = replies.get(m.id);
          contextMenu(text, pressed => ({
            title: this.author(m.author),
            items: [
              this.reactRow(m),
              ...this.textItems(m, text, pressed),
              { label: 'Reply in thread', run: () => this.openThread(m.id) },
              this.deleteItem(m, these?.length || 0),
            ],
          }));
          if (these) {
            const more = button('', () => this.openThread(m.id), 'corral-replies');
            more.textContent = `${these.length} ${these.length === 1 ? 'reply' : 'replies'}`;
            more.append(node('time', '', 'last ' + time(these.at(-1).ts)));
            last.body.append(more);
            last = null;
          }
        } else {
          contextMenu(text, pressed => ({
            title: this.author(m.author),
            items: [
              this.reactRow(m),
              ...this.textItems(m, text, pressed),
              this.deleteItem(m, m.id === thread ? replies.get(thread)?.length || 0 : 0),
            ],
          }));
        }
        if (thread && m.id === thread) {
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
      const here = map =>
        [...map.entries()]
          .map(([k, value]) => [...k.split(' '), value])
          .filter(([c, , t]) => c === this.openId && (!this.threadId || t === this.threadId));
      const name = (agent, t) =>
        '@' + this.author(agent) + (t && !this.threadId ? ' in a thread' : '');
      const busy = here(this.working);
      const waiting = here(this.background).filter(
        ([c, agent, t]) => !this.working.has([c, agent, t].join(' '))
      );
      this.workingLine.hidden = !this.openId || (!busy.length && !waiting.length);
      // Only a turn under way stops; background work is the agent's to manage.
      this.stopKey.hidden = !busy.length;
      this.workingLine.classList.toggle('background', !busy.length);
      this.workingText.textContent = [
        ...busy.map(([, agent, t, status]) =>
          status === 'thinking' ? `${name(agent, t)} is thinking…` : `${name(agent, t)} · ${status}`
        ),
        ...waiting.map(
          ([, agent, t, command]) => `${name(agent, t)} · in the background: ${command}`
        ),
      ].join('   ');
      this.workingText.title = this.workingText.textContent;
    }
    // A message's menu starts with what it was pressed on: a link's own items, then copying what
    // is selected in it, or the whole message, which is how a touch screen copies text.
    textItems(m, element, pressed) {
      const copy = text => navigator.clipboard?.writeText(text).catch(() => {});
      const selection = window.getSelection?.();
      const selected =
        selection && !selection.isCollapsed && element.contains(selection.anchorNode)
          ? selection.toString().trim()
          : '';
      return [
        ...(window.HyprlandLinks?.menuItems(pressed) || []),
        ...(selected ? [{ label: 'Copy selection', run: () => copy(selected) }] : []),
        { label: 'Copy text', run: () => copy(m.text) },
      ];
    }
    // Quick replies to a message: the agent that wrote it is woken where it is and told, in words,
    // which one it got and to what.
    reactRow(m) {
      return {
        row: OFFERED.map(([emoji, word]) => ({
          label: emoji,
          title: word[0].toUpperCase() + word.slice(1),
          run: () => this.react(m, emoji),
        })),
      };
    }
    react(m, emoji) {
      request(`/conversations/${encodeURIComponent(this.openId)}/messages`, {
        text: emoji,
        reacts: m.id,
      }).catch(e => {
        this.workingText.textContent = e.message;
        this.workingLine.hidden = false;
      });
    }
    // A message's reactions, as Slack shows them: one chip for each emoji with how many gave it,
    // naming them on hover. A tap on one adds yours, or takes yours back.
    reactionChips(m, given) {
      const row = node('div', 'corral-reactions');
      const byEmoji = new Map();
      for (const r of given) {
        const [emoji] = REACTIONS.find(([e]) => r.text.startsWith(e)) || [r.text.split(' ')[0]];
        byEmoji.set(emoji, [...(byEmoji.get(emoji) || []), r]);
      }
      for (const [emoji, list] of byEmoji) {
        const word = REACTIONS.find(([e]) => e === emoji)?.[1] || '';
        const mine = list.find(r => r.author === 'you');
        const chip = button('', () => (mine ? this.deleteMessage(mine) : this.react(m, emoji)));
        chip.className = 'corral-reaction' + (mine ? ' mine' : '');
        chip.append(node('span', '', emoji), node('span', 'corral-reaction-count', list.length));
        const who = list.map(r => (r.author === 'you' ? 'You' : '@' + this.author(r.author)));
        chip.title = `${who.join(', ')}${word ? ': ' + word : ''}`;
        chip.setAttribute('aria-label', chip.title);
        row.append(chip);
      }
      return row;
    }
    // Delete, for any message: the person's, an agent's, or Corral's. One a thread hangs from
    // takes its replies with it.
    deleteItem(m, replies) {
      return {
        label: 'Delete',
        danger: true,
        confirm: replies
          ? `Delete this message and its ${replies} ${replies === 1 ? 'reply' : 'replies'}?`
          : 'Delete this message?',
        run: () => this.deleteMessage(m),
      };
    }
    async deleteMessage(m) {
      const id = this.openId;
      try {
        const { deleted } = await request(
          `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(m.id)}/delete`,
          {}
        );
        this.removeMessages(id, deleted);
      } catch (e) {
        this.workingText.textContent = e.message;
        this.workingLine.hidden = false;
      }
    }
    removeMessages(conversation, ids) {
      if (conversation === this.openId) {
        this.messages = this.messages.filter(m => !ids.includes(m.id));
        if (ids.includes(this.threadId)) this.closeThread();
        else this.renderMessages();
      }
      this.later();
      if (this.detailsOpen) this.activityLater();
    }
    setQueued(list = []) {
      this.queued = new Map(list.map(q => [q.message, q.agents]));
    }
    setBackground(list = []) {
      this.background = new Map(
        list.map(b => [[b.conversation, b.agent, b.thread || ''].join(' '), b.command])
      );
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
      if (this.workAgent()) this.setMode('messages');
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
      const hosts = this.data.hosts || [];
      this.showSheet(a ? 'Edit @' + a.name : 'New agent', form => {
        const name = this.field(
          form,
          'Name',
          this.input(a?.name || '', 'AsBuilt'),
          'Mention it as @name, in any case.'
        );
        // With other hosts, the machine it works on; an agent stays on the one it was made on.
        const machine = this.select(
          [
            ['', `${this.data.machine || 'This host'} (this one)`],
            ...hosts.map(h => [h.name, h.name + (h.online ? '' : ' · not reachable')]),
          ],
          a?.host || ''
        );
        machine.disabled = !!a;
        if (hosts.length)
          this.field(form, 'Machine', machine, 'Where it works: its folder, tools, and files.');
        const engines = () =>
          (machine.value ? this.host(machine.value)?.engines : this.data.engines) || [];
        const engine = this.field(form, 'Agent', this.select([], ''));
        const model = this.field(form, 'Model', this.select([['', 'Default']], ''));
        const effort = this.field(form, 'Effort', this.select([['', 'Default']], ''));
        const offer = () => {
          const keep = engine.value || a?.engine || '';
          engine.replaceChildren(
            ...engines().map(e => {
              const o = node('option', '', e.label);
              o.value = e.id;
              return o;
            })
          );
          engine.value = engines().some(e => e.id === keep) ? keep : engines()[0]?.id || '';
          fill();
          choose.hidden = !!machine.value;
        };
        const fill = () => {
          const spec = engines().find(e => e.id === engine.value) || { models: [], efforts: [] };
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
        const home = this.input(a?.home || '', '~/git/project');
        const homeRow = node('div', 'corral-home');
        // Files browses this host, so another host's folder is typed.
        const choose = button('Choose…', () => this.chooseHome(home), 'keycap small');
        homeRow.append(home, choose);
        this.field(form, 'Home folder', homeRow, 'Where its sessions start.');
        machine.onchange = offer;
        offer();
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
              ...(machine.value && !a ? { host: machine.value } : {}),
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
      if (this.detailsOpen && !this.root.classList.contains('corral-roomy')) {
        this.toggleDetails(false);
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
      const composing = !this.nativeInput.element.hidden;
      this.promptRow.hidden = composing;
      if (composing)
        this.nativeInput.row.insertBefore(this.dictation.control, this.nativeInput.field);
      else this.promptRow.append(this.dictation.control);
    }
    get actions() {
      return this.openId && !this.main.hidden ? this.dictation.actions : [];
    }
    key() {}
    dispose() {
      this.disposed = true;
      clearTimeout(this.retry);
      clearTimeout(this.refreshTimer);
      clearTimeout(this.activityTimer);
      clearTimeout(this.rendersTimer);
      this.ws?.close();
      this.resized.disconnect();
      this.listResized.disconnect();
      for (const url of this.pictures.values())
        url.then(
          u => URL.revokeObjectURL(u),
          () => {}
        );
      this.folderPicker?.dispose();
      this.dictation.dispose();
      this.nativeInput.dispose();
    }
  }
  window.HyprlandApps?.provide('corral', { create: (root, bridge) => new CorralApp(root, bridge) });
})();
