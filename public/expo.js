/* Expo owns card gestures; nested app controls are inert while overview is open. */
(() => {
  class Expo {
    constructor(logic) {
      this.logic = logic;
      this.root = [...document.querySelectorAll('#touch-shell')].find(n => !n.closest('x-dc'));
      this.abort = new AbortController();
      for (const [event, handler] of [
        ['pointerdown', e => this.down(e)],
        ['pointermove', e => this.move(e)],
        ['pointerup', e => this.up(e)],
        ['pointercancel', () => this.cancel()],
        ['lostpointercapture', () => this.cancel()],
        [
          'click',
          e => {
            if (this.logic.state.ov || Date.now() < this.suppressUntil) {
              e.stopImmediatePropagation();
              e.preventDefault();
            }
          },
        ],
      ])
        this.root.addEventListener(event, handler, { capture: true, signal: this.abort.signal });
      this.update();
    }
    update() {
      this.root.classList.toggle('expo-mode', this.logic.state.ov);
      if (!this.logic.state.ov) this.cancel();
      else if (this.drag) this.paint();
    }
    down(e) {
      if (!this.logic.state.ov || e.button !== 0) return;
      if (this.drag) {
        e.stopImmediatePropagation();
        return;
      }
      e.stopImmediatePropagation();
      e.preventDefault();
      const card = e.target.closest('[data-workspace]'),
        key = card?.dataset.workspace;
      const scale = this.root.getBoundingClientRect().width / (this.root.offsetWidth || 402);
      this.drag = {
        card,
        key,
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        dy: 0,
        scale,
        base: card?.style.transform,
        transition: card?.style.transition,
        order: [...this.logic.state.open],
        active: this.logic.cur(),
        slots: this.logic.state.open.map(k => {
          const el = this.root.querySelector(`[data-workspace="${k}"]`),
            r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }),
      };
      this.root.setPointerCapture(e.pointerId);
      if (card && key !== 'home' && !this.logic.state.desk)
        this.timer = setTimeout(() => {
          if (!this.drag) return;
          this.drag.reorder = true;
          card.classList.add('expo-lifted');
          this.paint();
        }, 420);
    }
    move(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      d.dx = e.clientX - d.x;
      d.dy = e.clientY - d.y;
      if (!d.reorder && Math.hypot(d.dx, d.dy) > 9) clearTimeout(this.timer);
      if (d.reorder) {
        const origin = d.slots[d.order.indexOf(d.key)];
        const x = origin.x + d.dx,
          y = origin.y + d.dy;
        let target = 1,
          best = Infinity;
        d.slots.forEach((slot, i) => {
          if (!i) return;
          const distance = Math.hypot(slot.x - x, slot.y - y);
          if (distance < best) {
            best = distance;
            target = i;
          }
        });
        const open = [...this.logic.state.open],
          from = open.indexOf(d.key);
        if (from !== target) {
          open.splice(from, 1);
          open.splice(target, 0, d.key);
          this.logic.set({ open, ws: open.indexOf(d.active) });
        }
      }
      this.paint();
    }
    paint() {
      const d = this.drag;
      if (!d?.card || d.key === 'home') return;
      d.card.style.transition = 'none';
      d.card.style.zIndex = '8';
      d.card.style.transform = `translate(${(d.reorder ? d.dx : 0) / d.scale}px,${(d.reorder ? d.dy : Math.min(0, d.dy)) / d.scale}px) ${d.base}`;
      d.card.style.opacity = d.reorder ? '1' : String(Math.max(0.2, 1 - Math.max(0, -d.dy) / 350));
    }
    up(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      clearTimeout(this.timer);
      this.suppressUntil = Date.now() + 500;
      if (
        d.card &&
        d.key !== 'home' &&
        !d.reorder &&
        d.dy < -65 &&
        Math.abs(d.dy) > Math.abs(d.dx) * 1.2
      ) {
        this.drag = null;
        d.card.classList.remove('expo-lifted');
        const animation = d.card.animate(
          [
            { transform: d.card.style.transform, opacity: d.card.style.opacity },
            { transform: `translate(0,-${this.root.clientHeight}px) ${d.base}`, opacity: 0 },
          ],
          { duration: 190, easing: 'cubic-bezier(.3,0,.7,1)' }
        );
        animation.onfinish = () => {
          animation.cancel();
          this.clearCard(d);
          this.logic.closeApp(d.key, true);
        };
      } else {
        this.drag = null;
        this.clearCard(d);
        this.logic.set({});
        if (!d.reorder && Math.hypot(d.dx, d.dy) < 9 && d.key) this.logic.jump(d.key);
        else if (!d.reorder && d.dy > 65 && Math.abs(d.dy) > Math.abs(d.dx))
          this.logic.set({ ov: false });
      }
      if (this.root.hasPointerCapture(d.id)) this.root.releasePointerCapture(d.id);
    }
    clearCard(d) {
      if (!d?.card) return;
      d.card.classList.remove('expo-lifted');
      d.card.style.removeProperty('z-index');
      d.card.style.transition = d.transition;
      this.logic.cards?.apply(d.key);
    }
    cancel() {
      clearTimeout(this.timer);
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.clearCard(d);
      if (d.reorder) this.logic.set({ open: d.order, ws: d.order.indexOf(d.active) });
      else this.logic.set({});
      if (this.root.hasPointerCapture(d.id)) this.root.releasePointerCapture(d.id);
    }
    error(text) {
      this.notice?.remove();
      this.notice = document.createElement('div');
      this.notice.className = 'expo-notice';
      this.notice.setAttribute('role', 'alert');
      this.notice.textContent = text;
      this.root.append(this.notice);
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => this.notice?.remove(), 5000);
    }
    dispose() {
      clearTimeout(this.noticeTimer);
      this.notice?.remove();
      this.cancel();
      this.abort.abort();
    }
  }
  window.HyprlandExpo = { attach: logic => new Expo(logic) };
})();
