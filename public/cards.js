/* Workspace cards: one element per catalog app, built from HyprlandApps so the template only
   carries Home. The shell's layout() computes each card's transform, frame and opacity; update()
   applies it after every render. Expo drags restore a card through apply(). */
(() => {
  const live = selector => [...document.querySelectorAll(selector)].find(n => !n.closest('x-dc'));
  class Cards {
    constructor(logic) {
      this.logic = logic;
      this.cards = {};
      const home = live('[data-workspace="home"]');
      this.container = home?.parentElement;
      if (!this.container) return;
      this.cards.home = home;
      this.update();
    }
    sync() {
      if (!this.container) return;
      for (const [key, card] of Object.entries(this.cards))
        if (!HyprlandApps.get(key)) {
          card.remove();
          delete this.cards[key];
        }
      for (const app of Object.values(window.HyprlandApps.catalog)) {
        if (this.cards[app.key]) continue;
        const background =
          app.surface === 'terminal' ? 'var(--theme-terminal)' : 'var(--theme-background)';
        const card = document.createElement('div');
        card.dataset.workspace = app.key;
        card.style.cssText = `--pane-background:${background};position:absolute;inset:0;width:100%;height:100%;transform:translate(440px,0px) scale(1);transform-origin:0 0;--pane-border:var(--theme-window-inactive);border:2px solid transparent;border-radius:0px;overflow:hidden;background:${background};opacity:0;pointer-events:none;box-sizing:border-box`;
        const root = document.createElement('div');
        root.id = app.mount;
        root.className = app.mountClass;
        const label = document.createElement('div');
        label.className = 'workspace-label';
        label.textContent = app.name;
        label.style.cssText = `position:absolute;top:0;left:0;right:0;padding:26px 28px;font-size:28px;color:var(--theme-foreground);background:linear-gradient(${background} 60%,transparent);opacity:0;pointer-events:none`;
        card.append(root, label);
        this.container.append(card);
        this.cards[app.key] = card;
      }
    }
    update() {
      this.sync();
      const state = this.logic.state;
      document.documentElement.style.setProperty(
        '--wallpaper-x',
        (state.desk ? 50 : 50 + Math.max(0, Math.min(9, state.ws)) * 2) + '%'
      );
      const layout = this.logic.layout();
      for (const key of Object.keys(this.cards)) this.paint(key, layout);
    }
    apply(key) {
      this.paint(key, this.logic.layout());
    }
    groupTabs(key, card, state) {
      const members = state.desk ? HyprlandDesk.groupMembers(state, key) : [key];
      const grouped = members.length > 1 && key !== state.scratchKey;
      card.classList.toggle('desk-grouped', grouped);
      const signature = grouped ? JSON.stringify(members) : '';
      if (card.dataset.groupTabs === signature) return;
      card.dataset.groupTabs = signature;
      card.querySelector('.desk-window-tabs')?.remove();
      if (!grouped) return;
      const bar = document.createElement('nav');
      bar.className = 'desk-window-tabs';
      bar.setAttribute('aria-label', 'Window group');
      for (const member of members) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = HyprlandApps.get(member)?.name || member;
        button.setAttribute('aria-pressed', String(member === key));
        button.onclick = e => {
          e.stopPropagation();
          this.logic.focusApp(member);
        };
        bar.append(button);
      }
      card.append(bar);
    }
    paint(key, layout) {
      const card = this.cards[key],
        c = layout.cards[key],
        state = this.logic.state;
      if (!card || !c) return;
      this.groupTabs(key, card, state);
      const s = card.style;
      s.zIndex = state.desk && key === state.scratchKey ? '20' : '';
      card.classList.toggle('desk-scratchpad', state.desk && key === state.scratchKey);
      s.visibility = c.visibility || 'visible';
      s.width = c.w;
      s.height = c.h;
      s.transform = c.tf;
      s.transition = layout.tr;
      s.setProperty('--pane-border', c.bd);
      s.borderRadius = layout.rad;
      const focused = key === this.logic.cur();
      card.dataset.active = String(focused);
      s.opacity = Number(c.op) * HyprlandThemes.windowOpacity(focused);
      s.pointerEvents = c.pe;
      // Keep open phone cards composited between switches so a swipe starts without a re-raster.
      s.willChange = !state.desk && c.pe === 'auto' ? 'transform, opacity' : 'auto';
      const label = card.querySelector(':scope > .workspace-label');
      if (label) {
        label.style.opacity = c.lab;
        label.style.transition = layout.tr;
      }
    }
    dispose() {
      for (const [key, card] of Object.entries(this.cards)) if (key !== 'home') card.remove();
    }
  }
  window.HyprlandCards = { attach: logic => new Cards(logic) };
})();
