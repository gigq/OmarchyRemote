// Muster: every Herdr agent thread on one board, grouped by project. What needs you comes first:
// questions to answer here, then finished turns to read, then work in progress. A thread opens
// to its task, the agent's latest prose, and a composer; projects you are not working on can be
// hidden from the board without changing Herdr.
(() => {
  const { node, button, storage } = window.HyprlandUtil;
  const headers = { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' };
  const OPEN = 'omarchy-muster-open';
  const STATES = {
    question: 'Needs you',
    working: 'Working',
    waiting: 'Waiting',
    review: 'To review',
    quiet: 'Quiet',
  };
  // The board's columns, in order; a project sits in the first its threads reach.
  const ORDER = ['question', 'working', 'waiting', 'review', 'quiet'];
  const COUNTED = {
    question: 'needs you',
    working: 'working',
    waiting: 'waiting',
    review: 'to review',
    quiet: 'quiet',
  };
  // "1 needs you · 2 working · 1 to review"; quiet threads count only where asked.
  function counts(threads, withQuiet = false) {
    const n = {};
    for (const thread of threads) n[thread.state] = (n[thread.state] || 0) + 1;
    return ORDER.filter(state => n[state] && (withQuiet || state !== 'quiet'))
      .map(state =>
        state === 'question' && n[state] > 1
          ? `${n[state]} need you`
          : `${n[state]} ${COUNTED[state]}`
      )
      .join(' · ');
  }
  const ICONS = {
    back: 'm15 18-6-6 6-6',
    hide: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c5 0 9 4 10 7a13 13 0 0 1-3 4.2M6.6 6.6C4.3 8 2.7 10 2 12c1 3 5 7 10 7a10 10 0 0 0 5.4-1.6',
    show: 'M2 12c1-3 5-7 10-7s9 4 10 7c-1 3-5 7-10 7S3 15 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    herdr: 'M4 5h16v14H4ZM8 10l3 2-3 2M13 15h3',
    folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z',
  };

  async function request(path, body) {
    const response = await fetch(
      '/api/muster' + path,
      body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'The host did not respond.');
    return data;
  }
  // Agent prose is Markdown. DOMPurify removes anything that could run in the shell's page.
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
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  function iconButton(name, label, fn, className = '') {
    const b = button('', fn, 'muster-icon-button ' + className);
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
    return Math.floor(seconds / 86400) + 'd';
  }
  function chip(state) {
    const c = node('span', 'muster-state ' + state, STATES[state] || state);
    c.dataset.state = state;
    return c;
  }
  // A tab's name, with its agent: "2 · claude".
  function threadName(thread) {
    return [thread.tab, thread.agent].filter(Boolean).join(' · ');
  }
  function duration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // One gray line for the work between two pieces of an agent's text, in place of its tool calls:
  // "Worked 1m 20s · 8 tool calls · 3 files changed", "Thought for 12s", "Working 45s · 2 tool calls".
  function workLine(work) {
    const seconds = work.ongoing ? (Date.now() - Date.parse(work.since)) / 1000 : work.seconds;
    const time = Number.isFinite(seconds) ? duration(seconds) : '';
    const lead = work.ongoing
      ? ['Working', time].filter(Boolean).join(' ')
      : work.tools
        ? ['Worked', time].filter(Boolean).join(' ')
        : work.thought
          ? ['Thought for', time].filter(Boolean).join(' ')
          : `${time} later`;
    const parts = [lead];
    if (work.tools) parts.push(plural(work.tools, 'tool call'));
    if (work.files) parts.push(`${plural(work.files, 'file')} changed`);
    return parts.join(' · ');
  }
  function waiting(thread) {
    const count = thread.background?.length || 0;
    return count ? `waiting on ${count} background ${count === 1 ? 'task' : 'tasks'}` : '';
  }

  class MusterApp {
    constructor(root, bridge) {
      this.root = root;
      this.bridge = bridge;
      root.classList.add('muster-app');
      this.projects = [];
      this.thread = null;

      this.boardView = node('section', 'muster-board');
      const bar = node('div', 'muster-bar');
      const heading = node('div', 'muster-heading');
      this.summary = node('span', 'muster-summary');
      heading.append(node('h2', 'muster-title', 'Muster'), this.summary);
      bar.append(heading);
      this.notice = node('div', 'muster-notice');
      this.notice.hidden = true;
      // A section for each state, stacked on a phone and side by side in a wide window.
      this.list = node('div', 'muster-sections');
      this.hiddenToggle = button('', () => this.toggleHidden(), 'muster-hidden-toggle');
      this.hiddenToggle.setAttribute('aria-expanded', 'false');
      this.hiddenList = node('div', 'muster-hidden');
      this.hiddenList.hidden = true;
      this.status = node('p', 'remote-status muster-status');
      this.scroller = node('div', 'muster-scroll');
      this.scroller.append(this.notice, this.list, this.hiddenToggle, this.hiddenList, this.status);
      this.boardView.append(bar, this.scroller);

      this.threadView = node('section', 'muster-thread');
      this.threadView.hidden = true;
      const threadBar = node('div', 'muster-bar');
      this.backButton = iconButton('back', 'Muster', () => this.showBoard(), 'muster-back');
      this.threadTitle = node('div', 'muster-thread-title');
      this.threadState = node('span');
      // The thread's folder, in Files or, on the host's own desktop, its file manager.
      this.folderButton = iconButton('folder', 'Open thread folder', () => this.openFolder());
      this.herdrButton = iconButton('herdr', 'Open in Herdr', () => this.openInHerdr());
      threadBar.append(
        this.backButton,
        this.threadTitle,
        this.threadState,
        this.folderButton,
        this.herdrButton
      );
      // The project's other threads, to switch between its tabs.
      this.tabs = node('div', 'muster-tabs');
      this.tabs.setAttribute('role', 'tablist');
      this.body = node('div', 'muster-body');
      this.threadStatus = node('p', 'remote-status muster-thread-status');
      this.threadStatus.setAttribute('role', 'status');
      this.promptRow = node('div', 'herdr-prompt-row muster-prompt-row');
      this.promptField = button('', () => bridge.keyboard());
      this.promptField.className = 'prompt-field herdr-prompt muster-prompt';
      this.placeholder = node('span', 'muster-placeholder', 'Message the agent…');
      this.promptField.append(this.placeholder);
      this.promptRow.append(this.promptField);
      this.threadView.append(threadBar, this.tabs, this.body, this.threadStatus, this.promptRow);
      root.append(this.boardView, this.threadView);
      // The shell gives the composer focus only while a thread is showing.
      this.detail = this.threadView;
      this.nativeInput = bridge.createInput(this.threadView, true, text => this.send(text), {
        compactControls: true,
        dismissOnSend: true,
        draftStore: 'omarchy-muster-drafts-v1',
      });
      this.nativeInput.header.hidden = true;
      this.body.addEventListener('click', e => {
        if (
          window.__HYPRLAND_HARDWARE_KEYBOARD__ === true ||
          this.nativeInput.element.hidden ||
          e.target.closest('a, button') ||
          !getSelection().isCollapsed
        )
          return;
        this.nativeInput.dismiss();
      });
      this.picks = new Set();
      this.ticks = 0;
    }
    connect() {
      this.refresh();
      const open = storage.get(OPEN);
      if (open) this.open(open);
    }
    resume() {
      this.refresh();
      if (this.thread) this.load();
    }
    show(visible) {
      if (visible === this.visible) return;
      this.visible = visible;
      clearTimeout(this.timer);
      if (visible) this.poll();
    }
    // The board refreshes every few seconds while it is on screen; an open thread more often.
    async poll() {
      clearTimeout(this.timer);
      if (!this.visible || this.disposed) return;
      // A thread also refreshes the board now and then, for its tabs' states.
      if (this.pane) await Promise.all([this.load(), this.ticks++ % 3 ? null : this.refresh()]);
      else await this.refresh();
      if (this.visible && !this.disposed)
        this.timer = setTimeout(() => this.poll(), this.pane ? 2000 : 4000);
    }
    async refresh() {
      try {
        const data = await request('');
        this.projects = data.projects || [];
        this.status.textContent = '';
        this.renderBoard();
      } catch (e) {
        this.status.textContent = e.message;
      }
    }
    renderBoard() {
      const shown = this.projects.filter(p => !p.hidden);
      const hidden = this.projects.filter(p => p.hidden);
      this.summary.textContent =
        counts(shown.flatMap(project => project.threads)) || (shown.length ? 'All quiet' : '');
      const signature = JSON.stringify(this.projects);
      if (signature !== this.signature) {
        this.signature = signature;
        this.list.replaceChildren(
          ...ORDER.map(state => [state, shown.filter(project => project.state === state)])
            .filter(([, projects]) => projects.length)
            .map(([state, projects]) => this.section(state, projects))
        );
        if (!shown.length)
          this.list.append(
            node(
              'p',
              'muster-empty',
              this.projects.length
                ? 'Every project is hidden.'
                : `No agents are running in Herdr on ${HyprlandApps.host.name}.`
            )
          );
        this.hiddenList.replaceChildren(...hidden.map(project => this.hiddenRow(project)));
      }
      this.hiddenToggle.hidden = !hidden.length;
      this.hiddenToggle.textContent = `${this.hiddenList.hidden ? 'Show' : 'Hide'} hidden projects · ${hidden.length}`;
      // A question in a hidden project still reaches you.
      const asking = hidden.filter(p => p.state === 'question');
      this.notice.hidden = !asking.length;
      this.notice.replaceChildren(
        node(
          'span',
          '',
          asking.length === 1
            ? `${asking[0].label} is hidden and has a question.`
            : `${asking.length} hidden projects have questions.`
        ),
        button('Show', () => this.toggleHidden(true), 'muster-link')
      );
      const questions = this.projects.reduce(
        (n, p) => n + p.threads.filter(t => t.state === 'question').length,
        0
      );
      const badges = this.bridge.logic.state.badges || {};
      if ((badges.muster || 0) !== questions)
        this.bridge.logic.set({ badges: { ...badges, muster: questions } });
    }
    section(state, projects) {
      const section = node('section', 'muster-section');
      section.dataset.state = state;
      section.setAttribute('aria-label', STATES[state]);
      const head = node('h3', 'muster-section-head');
      head.append(
        node('span', 'muster-dot'),
        node('span', '', STATES[state]),
        node('span', 'muster-section-count', String(projects.length))
      );
      // Everything that finished before you looked lands here at first; clear it in one go.
      if (state === 'review')
        head.append(
          button(
            'Mark all reviewed',
            () => this.markReviewed(projects),
            'muster-link muster-mark-all'
          )
        );
      const list = node('div', 'muster-projects');
      list.setAttribute('role', 'list');
      list.append(...projects.map(project => this.card(project)));
      section.append(head, list);
      return section;
    }
    card(project) {
      const card = node('article', 'muster-project');
      card.setAttribute('role', 'listitem');
      card.dataset.state = project.state;
      const head = node('div', 'muster-project-head');
      const name = node('h3', 'muster-project-name', project.label);
      // With several tabs, how many are in each state, so none hides behind the project's.
      const mixed = new Set(project.threads.map(thread => thread.state)).size > 1;
      const tally = mixed
        ? node('p', 'muster-project-counts', counts(project.threads, true))
        : null;
      head.append(
        name,
        chip(project.state),
        node('time', 'muster-ago', project.updated ? ago(project.updated) : ''),
        iconButton('hide', `Hide ${project.label}`, () => this.hide(project, true))
      );
      card.append(
        head,
        ...(tally ? [tally] : []),
        ...project.threads.map(thread => this.row(thread))
      );
      return card;
    }
    row(thread) {
      const row = button('', () => this.open(thread.pane_id), 'muster-row');
      row.dataset.state = thread.state;
      row.dataset.pane = thread.pane_id;
      const top = node('span', 'muster-row-top');
      top.append(
        node('span', 'muster-dot'),
        node('span', 'muster-row-title', thread.title || thread.prompt || threadName(thread))
      );
      // What kind of attention, or why Muster cannot tell.
      const badge = thread.question
        ? thread.question.kind === 'approval'
          ? 'Approval'
          : 'Question'
        : thread.error
          ? 'Unreadable'
          : thread.status === 'unknown'
            ? 'Unknown status'
            : '';
      if (badge) {
        const b = node('span', 'muster-row-badge', badge);
        b.dataset.kind = badge.toLowerCase().replace(' ', '-');
        top.append(b);
      }
      top.append(node('span', 'muster-row-tab', threadName(thread)));
      row.append(top);
      if (thread.question) {
        const q = node('span', 'muster-row-question', thread.question.question || 'Waiting on you');
        row.append(q);
      } else if (thread.state === 'question')
        row.append(node('span', 'muster-row-question', 'Waiting on you in Herdr'));
      // Until the agent replies, a thread shows the message it was just sent.
      const text = thread.error
        ? 'Open in Herdr to read this conversation.'
        : thread.latest ||
          (thread.answered === false && thread.prompt ? 'You: ' + thread.prompt : '');
      if (text) row.append(node('span', 'muster-row-latest', text));
      const more = waiting(thread);
      if (more) row.append(node('span', 'muster-row-meta', more));
      return row;
    }
    hiddenRow(project) {
      const row = node('div', 'muster-hidden-row');
      row.append(
        node('span', 'muster-project-name', project.label),
        chip(project.state),
        button('Show', () => this.hide(project, false), 'remote-button muster-unhide')
      );
      return row;
    }
    // Marks threads reviewed: each thread given, or every thread to review in the projects given.
    async markReviewed(items, refresh = true) {
      const threads = items
        .flatMap(item => item.threads || [item])
        .filter(thread => thread.state === 'review' && thread.review_key)
        .filter(thread => this.acked?.get(thread.pane_id) !== thread.review_key);
      if (!threads.length) return;
      this.acked ||= new Map();
      for (const thread of threads) this.acked.set(thread.pane_id, thread.review_key);
      try {
        await request('/reviewed', {
          threads: threads.map(thread => ({ pane_id: thread.pane_id, key: thread.review_key })),
        });
        if (refresh) this.refresh();
      } catch (e) {
        for (const thread of threads) this.acked.delete(thread.pane_id);
        this.status.textContent = e.message;
      }
    }
    toggleHidden(open = this.hiddenList.hidden) {
      this.hiddenList.hidden = !open;
      this.hiddenToggle.setAttribute('aria-expanded', String(open));
      this.renderBoard();
    }
    async hide(project, hidden) {
      project.hidden = hidden;
      this.signature = null;
      this.renderBoard();
      try {
        await request('/hidden', { workspace_id: project.workspace_id, hidden });
      } catch (e) {
        this.status.textContent = e.message;
      }
      this.refresh();
    }

    showBoard() {
      this.thread = null;
      this.pane = null;
      storage.set(OPEN, null);
      this.nativeInput.dismiss();
      this.threadView.hidden = true;
      this.boardView.hidden = false;
      this.poll();
    }
    open(pane) {
      if (this.pane !== pane) {
        this.pane = pane;
        this.thread = null;
        this.threadSignature = null;
        this.threadStatus.textContent = '';
        this.body.replaceChildren();
      }
      storage.set(OPEN, pane);
      this.boardView.hidden = true;
      this.threadView.hidden = false;
      this.nativeInput.select('muster:' + pane);
      this.renderTabs();
      this.poll();
    }
    async load() {
      const pane = this.pane;
      if (!pane) return;
      try {
        const thread = await request('/panes/' + encodeURIComponent(pane));
        if (pane !== this.pane) return;
        this.thread = thread;
        // Opening a finished turn here reviews it.
        if (thread.state === 'review' && thread.review_key) this.markReviewed([thread], false);
        this.renderThread();
      } catch (e) {
        if (pane !== this.pane) return;
        // A pane that closed in Herdr leaves Muster's thread view.
        if (!this.thread) {
          storage.set(OPEN, null);
          this.showBoard();
          this.status.textContent = e.message;
        } else this.threadStatus.textContent = e.message;
      }
    }
    project() {
      return this.projects.find(p => p.threads.some(t => t.pane_id === this.pane));
    }
    renderTabs() {
      const project = this.project();
      const threads = project?.threads || [];
      this.tabs.hidden = threads.length < 2;
      this.tabs.replaceChildren(
        ...threads.map(thread => {
          const tab = button('', () => this.open(thread.pane_id), 'muster-tab');
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-selected', String(thread.pane_id === this.pane));
          tab.dataset.state = thread.state;
          tab.append(node('span', 'muster-dot'), node('span', '', threadName(thread)));
          return tab;
        })
      );
    }
    // A message sent here shows at once, unanswered, until the agent's log has it.
    current() {
      const thread = this.thread;
      const sent = this.sent;
      if (!sent || sent.pane !== thread.pane_id) return thread;
      if (thread.prompt?.trim() === sent.text || Date.now() - sent.at > 60000) {
        this.sent = null;
        return thread;
      }
      return {
        ...thread,
        prompt: sent.text,
        answered: false,
        paragraphs: [],
        updates: [],
        turn_text: '',
        turn_parts: [],
        working: true,
        state: thread.state === 'question' ? 'question' : 'working',
        earlier: (thread.earlier || 0) + (thread.prompt ? 1 : 0),
      };
    }
    renderThread() {
      const thread = this.current();
      const project = this.project();
      this.threadTitle.replaceChildren(
        node('strong', '', project?.label || 'Thread'),
        node('span', '', threadName(thread))
      );
      this.threadState.replaceChildren(chip(thread.state));
      this.herdrButton.hidden = !HyprlandApps.get('herdr')?.provider?.openPane;
      this.folderButton.hidden = !thread.cwd || !HyprlandApps.get('files')?.provider?.openFolder;
      const question = thread.question;
      // A question with a typed choice takes the composer's text as its answer.
      const typedAnswer = question && question.other != null && !question.multi;
      this.placeholder.textContent = typedAnswer
        ? 'Type your own answer…'
        : question
          ? 'Answer above first'
          : 'Message the agent…';
      this.nativeInput.field.placeholder = this.placeholder.textContent;
      if (project) this.renderTabs();
      const signature = JSON.stringify(thread);
      if (signature === this.threadSignature) {
        if (this.ongoing) this.ongoing.line.textContent = workLine(this.ongoing.work);
        return;
      }
      this.threadSignature = signature;
      const b = this.body;
      const bottom = !b.hasChildNodes() || b.scrollHeight - b.scrollTop - b.clientHeight < 80;
      const parts = [];
      if (thread.title) parts.push(node('h3', 'muster-thread-heading', thread.title));
      if (thread.earlier > 0) parts.push(this.recapCard(thread));
      // The reply to the message before yours stays at hand, folded away and marked as past.
      if (thread.answered === false && thread.answer?.text) {
        const key = `${thread.pane_id}:${thread.earlier}`;
        const previous = node('details', 'muster-previous');
        previous.open = this.previousOpen === key;
        previous.addEventListener('toggle', () => {
          this.previousOpen = previous.open ? key : null;
        });
        const said = node('div', 'muster-said');
        markdown(said, thread.answer.text);
        previous.append(node('summary', '', 'Previous reply'), said);
        parts.push(previous);
      }
      if (thread.prompt) {
        const asked = node('details', 'muster-asked');
        asked.open = thread.prompt.length < 400;
        asked.append(node('summary', '', 'You asked'), node('p', '', thread.prompt));
        parts.push(asked);
      }
      const prose = this.prose(thread);
      this.ongoing = null;
      const pieces = thread.turn_parts || [];
      if (pieces.some(part => part.text) || (thread.working && pieces.length)) {
        // What the agent wrote since your message, with a line for the work between.
        for (const part of pieces) {
          if (part.text) {
            const said = node('div', 'muster-said');
            markdown(said, part.text);
            parts.push(said);
          } else if (part.work && (!part.work.ongoing || thread.working)) {
            const line = node('p', 'muster-work', workLine(part.work));
            if (part.work.ongoing) {
              line.classList.add('ongoing');
              this.ongoing = { line, work: part.work };
            }
            parts.push(line);
          }
        }
      } else if (prose) {
        const said = node('div', 'muster-said');
        markdown(said, prose);
        parts.push(said);
      } else if (thread.error)
        parts.push(node('p', 'muster-note', 'Muster cannot read this conversation.'));
      else if (thread.answered === false && !question && !thread.screen)
        parts.push(
          thread.working || thread.state === 'working'
            ? node('p', 'muster-note muster-working', 'Working on your message…')
            : node('p', 'muster-note', 'No reply to this message yet.')
        );
      for (const task of thread.background || [])
        parts.push(node('p', 'muster-task', 'Background · ' + task.description));
      if (question) parts.push(this.questionCard(question));
      else if (thread.screen) parts.push(this.screenCard(thread.screen));
      const top = b.scrollTop;
      b.replaceChildren(...parts);
      // Opening the recap keeps your place; new output otherwise follows the end.
      if (this.keepScroll) b.scrollTop = top;
      else if (bottom) b.scrollTop = b.scrollHeight;
      this.keepScroll = false;
    }
    /* What came before your last message, summarized by the host when you open it, so a thread
       you come back to makes sense without its whole scrollback. A new turn makes a new one. */
    recapCard(thread) {
      const key = `${thread.pane_id}:${thread.earlier}`;
      if (this.recap?.key !== key)
        this.recap = {
          key,
          pane: thread.pane_id,
          open: this.recap?.pane === thread.pane_id && this.recap.open,
        };
      const recap = this.recap;
      const details = node('details', 'muster-earlier');
      details.open = !!recap.open;
      const count = thread.earlier;
      details.append(
        node(
          'summary',
          '',
          `Earlier in this thread · ${count} ${count === 1 ? 'message' : 'messages'}`
        )
      );
      const content = node('div', 'muster-recap');
      if (recap.text) markdown(content, recap.text);
      else if (recap.error)
        content.append(
          node('p', 'muster-note', recap.error),
          button('Try again', () => this.loadRecap(), 'muster-link')
        );
      else content.append(node('p', 'muster-note muster-summarizing', 'Summarizing…'));
      details.append(content);
      details.addEventListener('toggle', () => {
        recap.open = details.open;
        if (details.open) this.loadRecap();
      });
      if (recap.open) this.loadRecap();
      return details;
    }
    async loadRecap() {
      const recap = this.recap;
      if (!recap || recap.text || recap.loading) return;
      recap.loading = true;
      recap.error = null;
      try {
        const result = await request(`/panes/${encodeURIComponent(recap.pane)}/summary`, {});
        recap.text = result.summary || 'Nothing came before your last message.';
      } catch (e) {
        recap.error = e.message;
      } finally {
        recap.loading = false;
        if (this.recap === recap && this.thread) {
          this.threadSignature = null;
          this.keepScroll = true;
          this.renderThread();
        }
      }
    }
    // What the agent said in its latest turn: the answer once it is done, or its prose so far.
    prose(thread) {
      // Everything the agent has written since your message, as written, so text you are reading
      // stays put as more arrives and when the turn ends.
      if (thread.turn_text) return thread.turn_text;
      // An answer to an earlier message is not this turn's; it shows as the previous reply.
      const current = thread.answered !== false;
      if (current && !thread.working && thread.answer?.text) return thread.answer.text;
      const paragraphs = (thread.paragraphs || []).map(p => p.text);
      if (paragraphs.length) return paragraphs.join('\n\n');
      const updates = (thread.updates || []).map(u => u.text);
      if (updates.length) return updates.join('\n\n');
      return current ? thread.answer?.text || thread.latest || '' : '';
    }
    questionCard(question) {
      const card = node('section', 'muster-question');
      card.setAttribute('aria-label', 'Question');
      if (question.tabs?.length > 1) {
        const steps = node('div', 'muster-steps');
        for (const tab of question.tabs)
          steps.append(node('span', tab.done ? 'done' : '', tab.label));
        card.append(steps);
      }
      if (question.context) card.append(node('pre', 'muster-context', question.context));
      card.append(node('p', 'muster-question-text', question.question || 'Choose one'));
      if (this.picksFor !== question.id) {
        this.picksFor = question.id;
        this.picks = new Set(question.choices.filter(c => c.checked).map(c => c.number));
      }
      const choices = node('div', 'muster-choices');
      for (const choice of question.choices) {
        if (question.multi && choice.checked == null) continue;
        const b = button('', () => this.choose(question, choice), 'muster-choice');
        if (question.multi) {
          b.setAttribute('role', 'checkbox');
          b.setAttribute('aria-checked', String(this.picks.has(choice.number)));
        }
        b.append(node('span', 'muster-choice-number', String(choice.number)));
        const text = node('span', 'muster-choice-text');
        text.append(node('span', 'muster-choice-label', choice.label));
        if (choice.detail) text.append(node('span', 'muster-choice-detail', choice.detail));
        b.append(text);
        b.disabled = this.answering || choice.number > 9;
        choices.append(b);
      }
      card.append(choices);
      if (question.multi)
        card.append(
          button(
            'Continue',
            () => this.answer({ menu: question.id, choose: [...this.picks] }),
            'remote-button muster-continue'
          )
        );
      if (question.other != null && !question.multi)
        card.append(node('p', 'muster-hint', 'Or type your own answer below.'));
      return card;
    }
    choose(question, choice) {
      if (!question.multi) {
        this.answer({ menu: question.id, choose: [choice.number] });
        return;
      }
      if (this.picks.has(choice.number)) this.picks.delete(choice.number);
      else this.picks.add(choice.number);
      this.threadSignature = null;
      this.renderThread();
    }
    // A wait Muster cannot read as a menu shows the agent's screen, with keys to answer it.
    screenCard(screen) {
      const card = node('section', 'muster-question muster-screen');
      card.setAttribute('aria-label', 'Screen');
      card.append(node('pre', 'muster-context', screen));
      const keys = node('div', 'muster-keys');
      for (const [label, key] of [
        ['↑', 'Up'],
        ['↓', 'Down'],
        ['1', '1'],
        ['2', '2'],
        ['3', '3'],
        ['Tab', 'Tab'],
        ['Enter', 'Enter'],
        ['Esc', 'Escape'],
      ])
        keys.append(button(label, () => this.keys([key]), 'keycap muster-key'));
      card.append(keys);
      return card;
    }
    async answer(body) {
      if (this.answering) return false;
      const pane = this.pane;
      this.answering = true;
      this.threadSignature = null;
      this.renderThread();
      try {
        const result = await request(`/panes/${encodeURIComponent(pane)}/answer`, body);
        if (pane === this.pane && this.thread) {
          this.thread.question = result.question;
          this.threadStatus.textContent = result.question ? '' : 'Answered';
        }
        return true;
      } catch (e) {
        if (pane === this.pane) this.threadStatus.textContent = e.message;
        return false;
      } finally {
        this.answering = false;
        this.threadSignature = null;
        if (pane === this.pane && this.thread) this.renderThread();
        this.load();
      }
    }
    async keys(keys) {
      try {
        await request(`/panes/${encodeURIComponent(this.pane)}/keys`, { keys });
        setTimeout(() => this.load(), 300);
      } catch (e) {
        this.threadStatus.textContent = e.message;
      }
    }
    send(text) {
      text = text.trim();
      const pane = this.pane;
      const question = this.thread?.question;
      if (!text || !pane) return false;
      // While the agent waits, text can only answer a question that takes typed text.
      const waiting = this.thread?.state === 'question';
      if (waiting && !(question && question.other != null && !question.multi)) {
        this.threadStatus.textContent = 'Answer the question above first.';
        return false;
      }
      const draft = 'muster:' + pane;
      const sent = question
        ? this.answer({ menu: question.id, text })
        : request(`/panes/${encodeURIComponent(pane)}/send`, { text }).then(
            () => {
              this.threadStatus.textContent = '';
              if (pane === this.pane && this.thread) {
                this.sent = { pane, text, at: Date.now() };
                this.threadSignature = null;
                this.renderThread();
                this.body.scrollTop = this.body.scrollHeight;
              }
              setTimeout(() => this.load(), 500);
              return true;
            },
            e => {
              this.threadStatus.textContent = e.message;
              return false;
            }
          );
      // Keep the message as a draft if it did not arrive.
      return sent.then(ok => {
        if (ok) return true;
        const input = this.nativeInput;
        if (input.id === draft) {
          input.draft = text;
          input.configure();
        }
        input.storeDraft(draft, text);
        return false;
      });
    }
    openFolder() {
      const files = HyprlandApps.get('files')?.provider;
      if (this.thread?.cwd && files?.openFolder) files.openFolder(this.bridge, this.thread.cwd);
    }
    openInHerdr() {
      const herdr = HyprlandApps.get('herdr')?.provider;
      if (this.pane && herdr?.openPane) herdr.openPane(this.bridge, this.pane);
    }
    navigateBack() {
      if (this.threadView.hidden) return false;
      this.showBoard();
      return true;
    }
    placeLatest() {
      this.promptRow.hidden = !this.nativeInput.element.hidden;
    }
    key() {}
    dispose() {
      this.disposed = true;
      clearTimeout(this.timer);
      this.nativeInput.dispose();
    }
  }
  window.HyprlandApps?.provide('muster', {
    create: (root, bridge) => new MusterApp(root, bridge),
  });
})();
