/* Home's configurable widget deck and its local overview. */
(() => {
  const catalog = {
    weather: 'Weather',
    metrics: 'Host metrics',
    tailscale: 'Tailscale',
    ...Object.fromEntries(HyprlandApps.widgets().map(w => [w.key, w.name])),
  };
  const { node: el } = window.HyprlandUtil;
  const read = window.HyprlandUtil.storage.read;
  class WidgetDeck {
    constructor(host, roots, openApp) {
      this.host = host;
      this.roots = roots;
      this.abort = new AbortController();
      for (const widget of HyprlandApps.widgets()) {
        const root = roots[widget.key];
        root.classList.add('widget-app-link');
        root.tabIndex = 0;
        root.setAttribute('role', 'group');
        root.setAttribute(
          'aria-label',
          widget.name + ' widget; open ' + HyprlandApps.get(widget.app).name
        );
        const interactive = target => target.closest('button,a,input,select,textarea,summary');
        root.addEventListener(
          'click',
          e => {
            if (interactive(e.target) || Date.now() < this.suppress) return;
            e.stopPropagation();
            openApp(widget.app);
          },
          { signal: this.abort.signal }
        );
        root.addEventListener(
          'keydown',
          e => {
            if (e.target !== root || !['Enter', ' '].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            openApp(widget.app);
          },
          { signal: this.abort.signal }
        );
      }

      const saved = read('omarchy-widgets');
      this.order = Array.isArray(saved)
        ? [...new Set(saved.filter(k => catalog[k]))]
        : Object.keys(catalog);
      // Remember known entries so a new app widget appears once on existing installs,
      // without restoring widgets the user deliberately removed.
      const known = read('omarchy-widget-catalog', ['weather', 'metrics', 'tailscale', 'codexbar']);
      if (Array.isArray(saved) && Array.isArray(known))
        for (const key of Object.keys(catalog))
          if (!known.includes(key) && !this.order.includes(key)) this.order.push(key);
      if (Array.isArray(saved) && JSON.stringify(saved) !== JSON.stringify(this.order))
        HyprlandUtil.storage.write('omarchy-widgets', this.order);
      HyprlandUtil.storage.write('omarchy-widget-catalog', Object.keys(catalog));
      this.selected = read('omarchy-widget-current');
      if (!this.order.includes(this.selected)) this.selected = this.order[0];
      this.viewport = el('div', 'widget-viewport');
      this.strip = el('div', 'widget-strip');
      this.viewport.append(this.strip);
      this.dots = el('div', 'widget-dots');
      host.append(this.viewport, this.dots);
      const listen = (name, fn) =>
        this.viewport.addEventListener(name, fn, { capture: true, signal: this.abort.signal });
      listen('pointerdown', e => {
        if (e.button !== 0 || this.touch) return;
        this.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
        this.hold = setTimeout(() => {
          this.touch = null;
          this.suppress = Date.now() + 600;
          this.open();
        }, 450);
      });
      listen('pointermove', e => {
        const p = this.touch;
        if (!p || p.id !== e.pointerId) return;
        p.dx = e.clientX - p.x;
        p.dy = e.clientY - p.y;
        if (Math.hypot(p.dx, p.dy) > 9) clearTimeout(this.hold);
        if (Math.abs(p.dx) > 12 && Math.abs(p.dx) > Math.abs(p.dy) * 1.3) {
          p.swipe = true;
          e.stopPropagation();
          this.viewport.setPointerCapture(e.pointerId);
          this.strip.style.transition = 'none';
          this.strip.style.transform = `translateX(calc(${-this.index() * 100}% + ${p.dx / (host.getBoundingClientRect().width / host.clientWidth)}px))`;
        }
      });
      listen('pointerup', e => {
        const p = this.touch;
        clearTimeout(this.hold);
        this.touch = null;
        if (!p || p.id !== e.pointerId) return;
        if (Math.hypot(p.dx, p.dy) > 9) this.suppress = Date.now() + 500;
        if (p.swipe) {
          e.stopPropagation();
          this.suppress = Date.now() + 500;
          if (Math.abs(p.dx) > 40)
            this.select(
              this.order[
                Math.max(0, Math.min(this.order.length - 1, this.index() + (p.dx < 0 ? 1 : -1)))
              ]
            );
          else this.position();
        }
        if (this.viewport.hasPointerCapture(e.pointerId))
          this.viewport.releasePointerCapture(e.pointerId);
      });
      listen('pointercancel', () => {
        clearTimeout(this.hold);
        this.touch = null;
        this.position();
      });
      listen('click', e => {
        if (Date.now() < this.suppress) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      });
      this.render(false);
    }
    index() {
      return Math.max(0, this.order.indexOf(this.selected));
    }
    save() {
      try {
        HyprlandUtil.storage.write('omarchy-widgets', this.order);
        HyprlandUtil.storage.write('omarchy-widget-current', this.selected);
      } catch {}
    }
    select(key) {
      if (!this.order.includes(key)) return;
      this.selected = key;
      this.save();
      this.position();
      this.renderDots();
    }
    position() {
      this.strip.style.transition = 'transform .3s cubic-bezier(.22,.9,.24,1)';
      this.strip.style.transform = `translateX(${-this.index() * 100}%)`;
    }
    button(label, fn, cls = '') {
      const b = el('button', 'widget-button ' + cls, label);
      b.type = 'button';
      b.onclick = e => {
        e.stopPropagation();
        fn();
      };
      return b;
    }
    render(persist = true) {
      this.strip.style.setProperty(
        '--widget-rows',
        Math.max(1, this.order.length - Number(this.order.includes('tailscale')))
      );
      this.strip.replaceChildren(...this.order.map(k => this.roots[k]));
      if (!this.order.length)
        this.strip.append(this.button('+ Widgets', () => this.open(), 'widget-empty'));
      this.position();
      this.renderDots();
      if (persist) this.save();
    }
    renderDots() {
      this.dots.replaceChildren(
        ...this.order.map(k => {
          const b = this.button('', () => this.select(k), 'widget-dot');
          b.setAttribute('aria-label', 'Show ' + catalog[k]);
          b.setAttribute('aria-pressed', String(k === this.selected));
          b.append(el('i'));
          return b;
        })
      );
      this.dots.append(this.button('⚙', () => this.open(), 'widget-manage'));
      this.dots.lastChild.setAttribute('aria-label', 'Manage widgets');
    }
    preview(key) {
      const copy = this.roots[key].cloneNode(true);
      copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
      copy.querySelectorAll('button,a,input,select').forEach(n => {
        n.tabIndex = -1;
      });
      copy.setAttribute('aria-hidden', 'true');
      copy.classList.add('widget-preview');
      return copy;
    }
    refresh() {
      if (this.panel && !this.drag)
        this.panel
          .querySelectorAll('.widget-mini')
          .forEach(n => n.replaceChildren(this.preview(n.dataset.key)));
    }
    open() {
      if (this.panel) return;
      clearTimeout(this.hold);
      this.touch = null;
      this.position();
      this.panel = el('section', 'widget-overview');
      this.panel.setAttribute('role', 'dialog');
      this.panel.setAttribute('aria-label', 'Manage widgets');
      this.panel.tabIndex = -1;
      const header = el('header', 'widget-overview-header');
      header.append(
        el('h1', '', 'Widgets'),
        this.button('Done', () => this.close())
      );
      this.panel.append(header);
      this.grid = el('div', 'widget-overview-grid');
      this.panel.append(this.grid);
      this.library = el('div', 'widget-library');
      this.panel.append(this.library);
      const shell = this.host.closest('#touch-shell');
      shell.append(this.panel);
      for (const type of [
        'pointerdown',
        'pointermove',
        'pointerup',
        'touchstart',
        'touchmove',
        'touchend',
        'click',
      ])
        this.panel.addEventListener(type, e => e.stopPropagation());
      this.panel.addEventListener('keydown', e => {
        if (e.key === 'Escape') this.close();
      });
      this.renderOverview();
      this.panel.focus();
    }
    renderOverview() {
      this.grid.replaceChildren();
      for (const key of this.order) {
        const card = el('div', 'widget-overview-card');
        card.dataset.widgetKey = key;
        const mini = el('div', 'widget-mini');
        mini.dataset.key = key;
        mini.append(this.preview(key));
        const label = el('div', 'widget-card-label');
        label.append(
          el('strong', '', catalog[key]),
          this.button('×', () => this.remove(key), 'widget-remove')
        );
        label.lastChild.setAttribute('aria-label', 'Remove ' + catalog[key]);
        card.append(mini, label);
        card.addEventListener('pointerdown', e => this.down(e, key, card));
        card.addEventListener('pointermove', e => this.move(e));
        card.addEventListener('pointerup', e => this.up(e));
        card.addEventListener('pointercancel', () => this.cancel());
        card.addEventListener('lostpointercapture', () => this.cancel());
        card.onclick = e => {
          if (e.target.closest('button') || Date.now() < this.suppress) return;
          this.select(key);
          this.close();
        };
        for (const [text, offset] of [
          ['Move earlier', -1],
          ['Move later', 1],
        ]) {
          const b = this.button(
            text,
            () => this.reorder(key, this.order.indexOf(key) + offset),
            'widget-accessible-move'
          );
          b.setAttribute('aria-label', text + ': ' + catalog[key]);
          card.append(b);
        }
        this.grid.append(card);
      }
      if (!this.order.length)
        this.grid.append(el('p', 'widget-muted', 'Add a widget below to get started.'));
      this.library.replaceChildren(el('h2', '', 'Add widgets'));
      for (const key of Object.keys(catalog).filter(k => !this.order.includes(k)))
        this.library.append(
          this.button('+ ' + catalog[key], () => {
            this.order.push(key);
            this.selected = key;
            this.render();
            this.renderOverview();
          })
        );
      if (this.order.length === Object.keys(catalog).length)
        this.library.append(el('p', 'widget-muted', 'All widgets added'));
    }
    remove(key) {
      const index = this.order.indexOf(key);
      this.order = this.order.filter(k => k !== key);
      if (this.selected === key) this.selected = this.order[Math.min(index, this.order.length - 1)];
      this.render();
      this.renderOverview();
    }
    reorder(key, index) {
      index = Math.max(0, Math.min(this.order.length - 1, index));
      const from = this.order.indexOf(key);
      if (from === index) return;
      this.order.splice(from, 1);
      this.order.splice(index, 0, key);
      this.render();
      this.renderOverview();
    }
    down(e, key, card) {
      if (e.button !== 0 || e.target.closest('button') || this.drag) return;
      this.drag = {
        key,
        card,
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        dy: 0,
        scale: this.host.getBoundingClientRect().width / this.host.clientWidth,
        slots: [...this.grid.children].map(n => {
          const r = n.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
      };
      card.setPointerCapture(e.pointerId);
      this.reorderHold = setTimeout(() => {
        if (this.drag) {
          this.drag.reorder = true;
          card.classList.add('widget-dragging');
        }
      }, 350);
    }
    move(e) {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      d.dx = e.clientX - d.x;
      d.dy = e.clientY - d.y;
      if (!d.reorder && Math.hypot(d.dx, d.dy) > 9) clearTimeout(this.reorderHold);
      d.card.style.transform = `translate(${(d.reorder ? d.dx : 0) / d.scale}px,${(d.reorder ? d.dy : Math.min(0, d.dy)) / d.scale}px)`;
      if (d.reorder) {
        const origin = d.slots[this.order.indexOf(d.key)];
        let best = Infinity;
        d.slots.forEach((p, i) => {
          const dist = Math.hypot(p.x - origin.x - d.dx, p.y - origin.y - d.dy);
          if (dist < best) {
            best = dist;
            d.target = i;
          }
        });
        [...this.grid.children].forEach((n, i) =>
          n.classList.toggle('widget-drop-target', i === d.target)
        );
      }
    }
    up(e) {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      clearTimeout(this.reorderHold);
      this.drag = null;
      d.card.style.transform = '';
      d.card.classList.remove('widget-dragging');
      if (d.reorder || Math.hypot(d.dx, d.dy) > 9) this.suppress = Date.now() + 500;
      if (d.reorder) {
        this.reorder(d.key, d.target ?? this.order.indexOf(d.key));
        this.grid
          .querySelectorAll('.widget-drop-target')
          .forEach(n => n.classList.remove('widget-drop-target'));
      } else if (d.dy < -65 && Math.abs(d.dy) > Math.abs(d.dx) * 1.2) {
        const animation = d.card.animate(
          [
            { transform: `translateY(${d.dy / d.scale}px)`, opacity: 1 },
            { transform: 'translateY(-250px)', opacity: 0 },
          ],
          { duration: 160 }
        );
        animation.onfinish = () => {
          if (this.panel) this.remove(d.key);
        };
      }
      if (d.card.hasPointerCapture(e.pointerId)) d.card.releasePointerCapture(e.pointerId);
    }
    cancel() {
      clearTimeout(this.reorderHold);
      const d = this.drag;
      this.drag = null;
      if (d) {
        d.card.style.transform = '';
        d.card.classList.remove('widget-dragging');
        this.grid
          .querySelectorAll('.widget-drop-target')
          .forEach(n => n.classList.remove('widget-drop-target'));
        if (d.card.hasPointerCapture(d.id)) d.card.releasePointerCapture(d.id);
      }
    }
    close() {
      this.cancel();
      this.panel?.remove();
      this.panel = null;
      this.suppress = Date.now() + 500;
      this.host.querySelector('.widget-manage')?.focus();
    }
    dispose() {
      this.abort.abort();
      clearTimeout(this.hold);
      this.close();
    }
  }
  window.HyprlandWidgetDeck = WidgetDeck;
})();
