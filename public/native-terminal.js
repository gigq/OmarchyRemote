/* Native overflow scrolling over xterm's parsed buffer. No touchmove cancellation,
   velocity simulation, or per-frame scroll-position animation. */
(() => {
  const palette = [
    '#26233a',
    '#eb6f92',
    '#9ccfd8',
    '#f6c177',
    '#31748f',
    '#c4a7e7',
    '#9ccfd8',
    '#e0def4',
    '#6e6a86',
    '#ff0000',
    '#00ff00',
    '#ffff00',
    '#0000ff',
    '#ff00ff',
    '#00ffff',
    '#ffffff',
  ];
  let activePalette = window.HyprlandThemes?.palette() || palette;
  window.addEventListener('hyprland-theme-change', () => {
    activePalette = window.HyprlandThemes.palette();
  });
  const color = (n, rgb) => {
    if (rgb) return '#' + n.toString(16).padStart(6, '0');
    if (n < 16) return activePalette[n];
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    n -= 16;
    const c = v => (v ? 55 + 40 * v : 0);
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
  };
  class NativeTerminalView {
    constructor(host, term, onScroll = () => {}, onIdle = () => {}) {
      this.host = host;
      this.term = term;
      this.onScroll = onScroll;
      this.onIdle = onIdle;
      this.height = 18;
      this.width = 7.2;
      this.frame = null;
      this.rows = new Map();
      this.syncing = false;
      this.busy = false;
      this.finger = false;
      this.follow = true;
      this.dirty = true;
      this.cursorVisible = true;
      this.fit = false;
      this.layout = [];
      this.sourceRows = [];
      this.scroller = document.createElement('div');
      this.scroller.className = 'native-terminal-scroll';
      this.scroller.tabIndex = 0;
      this.scroller.setAttribute('aria-label', 'Terminal output');
      this.content = document.createElement('div');
      this.content.className = 'native-terminal-content';
      this.scroller.append(this.content);
      host.append(this.scroller);
      this.edges = ['left', 'right'].map(side => {
        const edge = document.createElement('div');
        edge.className = 'native-scroll-edge ' + side;
        edge.setAttribute('aria-hidden', 'true');
        host.append(edge);
        return edge;
      });
      term.element.classList.add('terminal-parser');
      term.element.setAttribute('aria-hidden', 'true');
      term.textarea.tabIndex = -1;
      this.abort = new AbortController();
      window.addEventListener(
        'hyprland-theme-change',
        () => {
          term.options.theme = window.HyprlandThemes.terminalTheme();
          this.schedule(true);
        },
        { signal: this.abort.signal }
      );
      const listen = (type, fn, options = {}) =>
        this.scroller.addEventListener(type, fn, { ...options, signal: this.abort.signal });
      listen(
        'scroll',
        () => {
          if (
            this.expected !== undefined &&
            Math.abs(this.scroller.scrollTop - this.expected) < 1
          ) {
            this.expected = undefined;
            this.schedule();
            return;
          }
          if (this.viewportHeight !== this.scroller.clientHeight) {
            this.schedule();
            return;
          }
          // A programmatic scroll is pending; the next render positions the scroller.
          if (this.target !== undefined) return;
          this.follow =
            this.scroller.scrollTop >= this.scroller.scrollHeight - this.scroller.clientHeight - 1;
          this.busy = true;
          clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => this.idle(), 160);
          this.syncing = true;
          term.scrollToLine(
            this.layout[Math.floor(this.scroller.scrollTop / this.height)]?.source || 0
          );
          this.syncing = false;
          this.schedule();
          onScroll();
        },
        { passive: true }
      );
      listen('scrollend', () => this.idle(), { passive: true });
      listen(
        'touchstart',
        e => {
          this.finger = true;
          this.touchStarted = performance.now();
          this.startY = this.lastY = e.touches[0]?.clientY;
          this.startX = e.touches[0]?.clientX;
          this.wheelDelta = 0;
          this.moved = this.busy;
          e.stopPropagation();
        },
        { passive: true }
      );
      listen(
        'touchmove',
        e => {
          const { clientX, clientY } = e.touches[0];
          if (Math.hypot(clientY - this.startY, clientX - this.startX) > 6) this.moved = true;
          // A tracking app scrolls its own content: swipes turn into wheel ticks.
          if (this.moved && this.wheel(this.lastY - clientY, clientX, clientY))
            this.lastY = clientY;
          e.stopPropagation();
        },
        { passive: true }
      );
      listen(
        'wheel',
        e => {
          const delta = e.deltaMode === 1 ? e.deltaY * this.height : e.deltaY;
          if (this.wheel(delta, e.clientX, e.clientY)) e.preventDefault();
        },
        { passive: false }
      );
      const end = e => {
        this.moved ||= e.type === 'touchcancel' || performance.now() - this.touchStarted >= 350;
        this.finger = false;
        e.stopPropagation();
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.idle(), 160);
      };
      listen('touchend', end, { passive: true });
      listen('touchcancel', end, { passive: true });
      listen('pointerdown', e => e.stopPropagation());
      listen(
        'click',
        e => {
          if (this.moved || this.selecting() || e.detail > 1) {
            e.preventDefault();
            e.stopImmediatePropagation();
            this.moved = false;
          }
        },
        { capture: true }
      );
      // A tap that was not a drag or a selection reaches TUIs that asked for mouse reports.
      // The edge guards keep swipes local but still pass their taps through.
      listen('click', e => this.report(e));
      for (const edge of this.edges)
        edge.addEventListener('click', e => this.report(e), { signal: this.abort.signal });
      listen('contextmenu', () => {
        this.moved = true;
      });
      document.addEventListener(
        'selectionchange',
        () => {
          const selected = this.selecting();
          if (this.hadSelection && !selected) {
            this.schedule(true);
            this.idle();
          }
          this.hadSelection = selected;
        },
        { signal: this.abort.signal }
      );
      this.listeners = [
        term.onWriteParsed(() => this.schedule(true)),
        term.onResize(() => {
          if (this.follow) this.target = term.buffer.active.baseY;
          this.schedule(true);
        }),
        term.onScroll(() => {
          if (!this.syncing) {
            this.target = term.buffer.active.viewportY;
            this.follow = this.target >= term.buffer.active.baseY;
            this.schedule();
          }
        }),
      ];
      for (const [final, visible] of [
        ['h', true],
        ['l', false],
      ])
        this.listeners.push(
          term.parser.registerCsiHandler({ prefix: '?', final }, params => {
            if (params.includes(25)) {
              this.cursorVisible = visible;
              this.schedule(true);
            }
            if (params.includes(1006)) this.sgrMouse = visible;
            return false;
          })
        );
      this.listeners.push(
        term.buffer.onBufferChange(() => {
          this.target = term.buffer.active.viewportY;
          this.follow = this.target >= term.buffer.active.baseY;
          this.schedule(true);
        })
      );
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(host);
      this.schedule();
    }
    setFit(fit) {
      this.savedAnchor = this.anchor();
      this.fit = fit;
      this.scroller.scrollLeft = 0;
      this.schedule(true);
    }
    anchor() {
      const visual = Math.floor(this.scroller.scrollTop / this.height),
        entry = this.layout[visual];
      return {
        source: entry?.source || 0,
        column: entry?.start || 0,
        pixel: this.scroller.scrollTop % this.height,
        follow: this.follow,
      };
    }
    restore(anchor, source = anchor.source) {
      this.savedAnchor = { ...anchor, source };
      this.follow = anchor.follow;
      this.schedule();
    }
    buildLayout(buffer, columns) {
      this.layout = [];
      this.sourceRows = [];
      for (let source = 0; source < buffer.length; source++) {
        this.sourceRows[source] = this.layout.length;
        const line = buffer.getLine(source);
        let end = this.term.cols;
        if (this.fit) {
          while (
            end > 0 &&
            !line
              .getCell(end - 1)
              ?.getChars()
              .trim()
          )
            end--;
          if (end > 0) end = Math.min(this.term.cols, end - 1 + line.getCell(end - 1).getWidth());
        }
        for (let start = 0; start < Math.max(1, end);) {
          let stop = this.fit ? Math.min(end, start + columns) : end;
          if (stop < end) {
            if (line.getCell(stop)?.getWidth() === 0) stop--;
            if (stop <= start) stop = Math.min(end, start + 2);
            let space = -1;
            for (let x = start; x < stop; x++)
              if (/^\s+$/.test(line.getCell(x)?.getChars() || ' ')) space = x;
            if (space > start && line.translateToString(true, start, space).trim())
              stop = space + 1;
          }
          this.layout.push({ source, start, end: Math.max(start + 1, stop) });
          start = Math.max(start + 1, stop);
        }
      }
    }
    // Sends a press and release for the tapped cell while the app tracks the mouse
    // (DECSET 1000/1002/1003; 9 is press only), SGR encoded when the app enabled 1006.
    // The tapped cell in the app's screen coordinates, or null outside the screen.
    cell(clientX, clientY) {
      const { term } = this,
        rect = this.content.getBoundingClientRect(),
        entry = this.layout[Math.floor((clientY - rect.top) / this.height)];
      if (!entry) return null;
      const b = term.buffer.active,
        row = entry.source - b.viewportY,
        col = Math.min(entry.end - 1, entry.start + Math.floor((clientX - rect.left) / this.width));
      if (row < 0 || row >= term.rows || col < 0 || col >= term.cols) return null;
      return { x: col + 1, y: row + 1 };
    }
    // Mouse reports go to apps that asked for them (DECSET 1000/1002/1003; 9 is press only),
    // SGR encoded when the app enabled 1006. Button 0 releases with 'm', 64/65 are wheel ticks.
    tracking() {
      const mode = this.term.modes.mouseTrackingMode;
      return mode === 'none' || this.term.options.disableStdin ? null : mode;
    }
    encode(button, final, { x, y }) {
      if (this.sgrMouse) return `\x1b[<${button};${x};${y}${final}`;
      if (x >= 224 || y >= 224) return '';
      const code = final === 'm' ? 3 : button;
      return `\x1b[M${String.fromCharCode(32 + code, 32 + x, 32 + y)}`;
    }
    report(e) {
      const mode = this.tracking(),
        cell = mode && this.cell(e.clientX, e.clientY);
      if (!cell) return;
      this.term.input(
        this.encode(0, 'M', cell) + (mode === 'x10' ? '' : this.encode(0, 'm', cell)),
        false
      );
    }
    // Vertical movement becomes wheel ticks, one per row, at the cell under the pointer.
    wheel(deltaY, clientX, clientY) {
      const mode = this.tracking();
      if (!mode || mode === 'x10') return false;
      this.wheelDelta = (this.wheelDelta || 0) + deltaY;
      const ticks = Math.trunc(this.wheelDelta / this.height);
      this.wheelDelta -= ticks * this.height;
      const cell = this.cell(clientX, clientY);
      if (!cell) return true;
      let data = '';
      for (let i = 0; i < Math.abs(ticks); i++) data += this.encode(ticks > 0 ? 65 : 64, 'M', cell);
      if (data) this.term.input(data, false);
      return true;
    }
    selecting() {
      const s = window.getSelection();
      return !!(
        s &&
        !s.isCollapsed &&
        (this.content.contains(s.anchorNode) || this.content.contains(s.focusNode))
      );
    }
    idle() {
      if (this.finger || this.selecting()) return;
      this.schedule();
      this.busy = false;
      clearTimeout(this.idleTimer);
      this.onIdle();
    }
    active() {
      return this.busy || this.finger || this.selecting();
    }
    cancel() {
      this.scroller.scrollTo({
        top: this.scroller.scrollTop,
        left: this.scroller.scrollLeft,
        behavior: 'instant',
      });
      this.finger = false;
      this.idle();
    }
    schedule(dirty = false) {
      this.dirty ||= dirty;
      if (this.frame === null)
        this.frame = requestAnimationFrame(() => {
          this.frame = null;
          this.render();
        });
    }
    render() {
      const { term, scroller, content } = this;
      if (!this.host.clientHeight) return;
      // Keep selected DOM nodes and scroll position intact until selection finishes.
      if ((this.finger && !this.moved) || this.selecting()) {
        this.dirty = true;
        return;
      }
      const screen = term.element.querySelector('.xterm-screen');
      // While an app tracks the mouse, swipes are its wheel input rather than a native pan.
      scroller.classList.toggle('mouse-tracking', !!this.tracking());
      let dirty = this.dirty;
      this.dirty = false;
      const oldHeight = this.height,
        oldWidth = this.width;
      this.height = parseFloat(screen.style.height) / term.rows || 18;
      this.width = parseFloat(screen.style.width) / term.cols || 7.2;
      dirty ||= oldHeight !== this.height || oldWidth !== this.width;
      const b = term.buffer.active;
      const columns = Math.max(2, Math.floor(scroller.clientWidth / this.width));
      if (columns !== this.columns && !this.follow && !this.savedAnchor && this.layout.length)
        this.savedAnchor = this.anchor();
      if (dirty || columns !== this.columns || !this.layout.length) {
        this.columns = columns;
        this.buildLayout(b, columns);
        dirty = true;
      }

      if (this.viewportHeight !== scroller.clientHeight && this.follow) this.target = b.baseY;
      this.viewportHeight = scroller.clientHeight;
      content.style.height = `${this.fit ? Math.max(this.layout.length * this.height, scroller.clientHeight) : Math.max(b.length * this.height, b.baseY * this.height + scroller.clientHeight)}px`;
      content.style.width = this.fit ? '100%' : `${term.cols * this.width}px`;
      if (this.savedAnchor) {
        const a = this.savedAnchor;
        this.savedAnchor = null;
        this.follow = a.follow;
        let visual = this.sourceRows[a.source] || 0;
        while (
          this.layout[visual + 1]?.source === a.source &&
          this.layout[visual + 1].start <= a.column
        )
          visual++;
        this.expected = a.follow
          ? content.offsetHeight - scroller.clientHeight
          : visual * this.height + a.pixel;
        scroller.scrollTop = this.expected;
        this.target = undefined;
      } else if (this.target !== undefined) {
        const source = Math.floor(this.target),
          fraction = this.target - source;
        this.expected =
          this.fit && this.follow
            ? content.offsetHeight - scroller.clientHeight
            : Math.min(
                ((this.sourceRows[source] || 0) + fraction) * this.height,
                content.offsetHeight - scroller.clientHeight
              );
        scroller.scrollTop = this.expected;
        this.target = undefined;
      }
      // Overscan allows the compositor to keep moving existing text between JS updates.
      const top = Math.max(0, Math.floor(scroller.scrollTop / this.height) - 80),
        end = Math.min(
          this.layout.length,
          Math.ceil((scroller.scrollTop + scroller.clientHeight) / this.height) + 80
        );
      for (const [i, row] of this.rows)
        if (i < top || i >= end) {
          row.remove();
          this.rows.delete(i);
        }
      const cell = b.getNullCell();
      for (let y = top; y < end; y++) {
        const entry = this.layout[y],
          line = b.getLine(entry.source);
        if (!line) continue;
        let row = this.rows.get(y);
        if (row && !dirty) continue;
        if (!row) {
          row = document.createElement('div');
          row.className = 'native-terminal-row';
          row.dataset.line = y;
          content.append(row);
          this.rows.set(y, row);
        }
        row.style.top = `${y * this.height}px`;
        row.style.height = row.style.lineHeight = `${this.height}px`;
        const runs = [];
        let run;
        for (let x = entry.start; x < entry.end; x++) {
          const c = line.getCell(x, cell);
          if (!c || !c.getWidth()) continue;
          let fg = c.isFgDefault()
              ? this.term.options.theme.foreground || '#e0def4'
              : color(c.getFgColor(), c.isFgRGB()),
            bg = c.isBgDefault() ? 'transparent' : color(c.getBgColor(), c.isBgRGB());
          if (this.colorTransform) {
            fg = this.colorTransform(fg, false);
            bg = this.colorTransform(bg, true);
            if (bg !== 'transparent') fg = 'var(--theme-foreground)';
            if (this.themeBoxBorders && /^[\u2500-\u257f]+$/.test(c.getChars()))
              fg = 'var(--theme-accent)';
          }
          if (c.isInverse())
            [fg, bg] = [
              bg === 'transparent' ? this.term.options.theme.background || '#15131f' : bg,
              fg,
            ];
          const cursor =
            this.cursorVisible &&
            !term.options.disableStdin &&
            entry.source === b.baseY + b.cursorY &&
            x === b.cursorX;
          const decoration =
            [
              c.isUnderline() ? 'underline' : '',
              c.isStrikethrough() ? 'line-through' : '',
              c.isOverline() ? 'overline' : '',
            ]
              .filter(Boolean)
              .join(' ') || 'none';
          const style = `color:${fg};background:${bg};font-weight:${c.isBold() ? 700 : 400};font-style:${c.isItalic() ? 'italic' : 'normal'};opacity:${c.isDim() ? 0.5 : 1};text-decoration:${decoration};${cursor ? `box-shadow:inset 0 0 0 1px ${this.term.options.theme.cursor || '#ebbcba'};` : ''}`;
          const chars = c.isInvisible() ? ' '.repeat(c.getWidth()) : c.getChars() || ' ';
          if (run && run.style === style && c.getWidth() === 1 && run.simple) {
            run.text += chars;
            run.width++;
          } else {
            run = { style, text: chars, width: c.getWidth(), simple: c.getWidth() === 1 };
            runs.push(run);
          }
        }
        const signature = JSON.stringify([this.width, runs]);
        if (signature === row.signature) continue;
        row.signature = signature;
        const fragment = document.createDocumentFragment();
        for (const r of runs) {
          const span = document.createElement('span');
          span.style.cssText = r.style + `width:${r.width * this.width}px`;
          span.textContent = r.text;
          fragment.append(span);
        }
        row.replaceChildren(fragment);
      }
    }
    dispose() {
      this.abort.abort();
      this.resize.disconnect();
      this.listeners.forEach(l => l.dispose());
      cancelAnimationFrame(this.frame);
      clearTimeout(this.idleTimer);
      this.scroller.remove();
      this.edges.forEach(edge => edge.remove());
    }
  }
  window.NativeTerminalView = NativeTerminalView;
})();
