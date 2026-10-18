// Canvas: talk or type to Claude, and it answers by building the page you see. Built on Chat: the
// same sessions, settings, attachments, and composer, with each session's conversation shown as
// the page Claude writes in its folder, live, and its replies as a subtitle.
(() => {
  const { node, button } = window.HyprlandUtil;
  const ChatApp = window.HyprlandChatApp;
  if (!ChatApp) return;
  const THEME = [
    'background',
    'foreground',
    'surface',
    'surface-raised',
    'border',
    'accent',
    'secondary',
    'terminal',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
  ];

  class CanvasApp extends ChatApp {
    constructor(root, bridge) {
      super(root, bridge, {
        base: '/api/canvas',
        prefix: 'omarchy-canvas',
        title: 'Canvas',
        emptyTitle: 'No canvases yet',
        emptyText: 'Ask for anything, and Claude draws the answer.',
        start: 'Start a canvas',
      });
      root.classList.add('canvas-app');
      // The page runs its own scripts, apart from the shell: no shared storage or host access.
      this.frame = node('iframe', 'canvas-frame');
      this.frame.title = 'Canvas page';
      this.frame.setAttribute(
        'sandbox',
        'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation'
      );
      this.frame.setAttribute(
        'allow',
        'autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture; web-share'
      );
      this.frame.hidden = true;
      this.welcome = node('div', 'canvas-welcome');
      this.welcomeText = node('p', '', '');
      this.welcome.append(node('span', 'canvas-welcome-mark', ''), this.welcomeText);
      this.messages.hidden = true;
      this.stage.prepend(this.frame, this.welcome);
      // Claude's reply, one line until tapped.
      this.subtitle = button('', () => this.expand(), 'canvas-subtitle');
      this.subtitle.setAttribute('aria-expanded', 'false');
      this.subtitle.hidden = true;
      this.threadView.insertBefore(this.subtitle, this.status);
      // The page answers for the person: its message continues the conversation.
      this.bridgeMessage = e => {
        if (e.source !== this.frame.contentWindow || !this.chat) return;
        const text =
          e.data?.type === 'canvas' && typeof e.data.text === 'string' ? e.data.text : '';
        if (text.trim() && !this.chat.busy) this.send(text.slice(0, 4000));
      };
      window.addEventListener('message', this.bridgeMessage);
    }
    // The screen and theme the page is shown with, for Claude to design for.
    sendExtras() {
      const style = getComputedStyle(document.documentElement);
      const theme = {};
      for (const name of THEME) {
        const value = style.getPropertyValue('--theme-' + name).trim();
        if (value) theme[name] = value;
      }
      const desk = window.HyprlandDesk?.isDesk?.();
      return {
        context: {
          screen: {
            width: Math.round(this.stage.clientWidth || innerWidth),
            height: Math.round(this.stage.clientHeight || innerHeight),
            pixelRatio: devicePixelRatio,
          },
          device: !desk
            ? 'phone'
            : Math.min(innerWidth, innerHeight) >= 900
              ? 'computer'
              : 'tablet',
          touch: matchMedia('(pointer: coarse)').matches,
          colorScheme: style.getPropertyValue('--theme-mode').trim() || 'dark',
          theme,
          fonts: { interface: 'JetBrains Mono, monospace' },
        },
      };
    }
    apply(e) {
      if (e.type === 'page' && this.chat && e.id === this.chat.id && e.n > this.chat.n) {
        this.chat.n = e.n;
        this.chat.version = e.version;
        this.chat.page = e.page;
        this.showPage();
        return;
      }
      super.apply(e);
    }
    // Loads the page when it first appears or changes, keeping it otherwise.
    showPage() {
      const chat = this.chat;
      const ready = !!(chat?.view && chat.page);
      this.frame.hidden = !ready;
      this.welcome.hidden = ready;
      this.welcomeText.textContent = `Ask for anything. ${this.agentName()} draws the answer on ${HyprlandApps.host.name}.`;
      if (!ready) return;
      const src = `${chat.view}?v=${chat.version || 0}`;
      if (this.frame.dataset.src !== src) {
        this.frame.dataset.src = src;
        this.frame.src = src;
      }
    }
    render() {
      const chat = this.chat;
      if (!chat) return;
      this.title.textContent = chat.title || 'New canvas';
      this.showPage();
      this.renderSubtitle();
      this.renderState();
    }
    renderPartial() {
      this.renderSubtitle();
    }
    // The reply to the latest message; while Claude works, what it is doing.
    renderSubtitle() {
      const chat = this.chat;
      if (!chat) return;
      const entries = chat.entries.filter(Boolean);
      const last = entries.findLastIndex(entry => entry.role === 'user');
      const turn = entries.slice(last + 1);
      const reply = turn.filter(entry => entry.role === 'assistant').at(-1)?.text || '';
      const tool = turn.filter(entry => entry.role === 'tool').at(-1);
      const text = chat.partial || reply || (chat.busy ? this.doing(tool) : '');
      this.subtitle.hidden = !text && !entries.length;
      this.subtitle.classList.toggle('working', !!chat.busy && !chat.partial && !reply);
      const asked = last >= 0 ? entries[last].text : '';
      const said = node('span', 'canvas-said', this.spoken ? '' : text);
      this.words = [];
      if (this.spoken) {
        // Each word, with where it starts in the text, lit once speech reaches it.
        let at = 0;
        const length = this.spoken.text.length || 1;
        for (const part of this.spoken.text.split(/(\s+)/)) {
          if (part && !/^\s+$/.test(part)) {
            const word = node('span', 'canvas-word', part);
            this.words.push({ word, at: at / length });
            said.append(word);
          } else if (part) said.append(part);
          at += part.length;
        }
        said.classList.add('reading');
        this.subtitle.hidden = false;
        this.subtitle.classList.remove('working');
        this.lit = -1;
      }
      this.subtitle.replaceChildren(...(asked ? [node('span', 'canvas-asked', asked)] : []), said);
      this.said = said;
    }
    // In talk mode the subtitle is what is read aloud, its words lit as they are spoken.
    speaking(state) {
      if (!this.subtitle || (state?.text ?? '') === (this.spoken?.text ?? '')) return;
      cancelAnimationFrame(this.readFrame);
      this.spoken = state;
      this.renderSubtitle();
      if (state) this.follow();
    }
    follow() {
      const progress = this.spoken?.progress?.() || 0;
      const lit = this.words.findLastIndex(({ at }) => at <= progress);
      if (lit !== this.lit && this.said?.isConnected) {
        this.words.forEach(({ word }, i) => {
          word.classList.toggle('spoken', i <= lit);
          word.classList.toggle('current', i === lit);
        });
        this.lit = lit;
        // Keep the word being spoken in view, a line from the top.
        const word = this.words[lit]?.word;
        if (word) {
          const line = parseFloat(getComputedStyle(this.said).lineHeight) || 18;
          const top =
            word.getBoundingClientRect().top -
            this.said.getBoundingClientRect().top +
            this.said.scrollTop;
          this.said.scrollTop = Math.max(0, top - line);
        }
      }
      this.readFrame = requestAnimationFrame(() => this.follow());
    }
    // One line for what Claude is doing until it replies: thinking, using the web, or drawing.
    doing(tool) {
      const name = this.agentName();
      if (!tool) return `${name} is thinking…`;
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool.name)) return `${name} is drawing…`;
      if (tool.name === 'WebSearch') return `Searching · ${tool.text}`;
      if (tool.name === 'WebFetch') return `Reading · ${tool.text}`;
      return `${name} is working…`;
    }
    // The subtitle says what Claude is doing; the status line is kept for errors.
    renderState() {
      super.renderState();
      this.renderSubtitle();
      if (this.chat?.error) return;
      this.status.textContent = '';
      this.status.classList.remove('thinking');
    }
    expand(open = this.subtitle.getAttribute('aria-expanded') !== 'true') {
      this.subtitle.setAttribute('aria-expanded', String(open));
    }
    showThread() {
      this.expand(false);
      this.frame.dataset.src = '';
      super.showThread();
    }
    renderLabels() {
      super.renderLabels();
      const placeholder = `Ask ${this.agentName()} for anything…`;
      this.promptField.querySelector('.chat-placeholder').textContent = placeholder;
      this.nativeInput.field.placeholder = placeholder;
    }
    scroll() {}
    dispose() {
      cancelAnimationFrame(this.readFrame);
      window.removeEventListener('message', this.bridgeMessage);
      super.dispose();
    }
  }
  window.HyprlandApps?.provide('canvas', {
    create: (root, bridge) => new CanvasApp(root, bridge),
  });
})();
