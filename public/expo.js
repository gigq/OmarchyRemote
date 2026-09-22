/* Expo owns card gestures; nested app controls are inert while overview is open. */
(() => {
  /* Gesture storyboard: edge press → scrub workspace/grid with the finger → settle on release.
     Only the endpoints change shell state; pointer moves never rerender the app tree. */
  const SWIPE = {
    slop: 6,
    heightFraction: 0.3,
    minDistance: 140,
    maxDistance: 260,
    commit: 0.45,
    flickDistance: 24,
    velocityProjection: 120,
    velocityExpiry: 120,
    settleMs: 220,
    timelineMs: 1000,
    labelReveal: 0.65,
  };
  const clamp = n => Math.max(0, Math.min(1, n));
  const frameProperties = [
    'top',
    'right',
    'bottom',
    'left',
    'borderTopWidth',
    'borderTopLeftRadius',
  ];
  const frameVariables = ['top', 'right', 'bottom', 'left', 'width', 'radius'];
  const snapshot = card => {
    const style = getComputedStyle(card);
    const border = getComputedStyle(card, '::after');
    const label = card.querySelector(':scope > .workspace-label');
    return {
      card,
      label,
      labelOpacity: label ? getComputedStyle(label).opacity : '0',
      visual: {
        transform: style.transform,
        width: style.width,
        height: style.height,
        opacity: style.opacity,
      },
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      frame: frameProperties.map(key => parseFloat(border[key]) || 0),
    };
  };
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
        [
          'lostpointercapture',
          e => {
            // Touch initially captures the child under the finger. Its capture loss
            // bubbles here when we take over; only losing our own capture cancels.
            const gesture = this.swipe || this.drag;
            if (e.target === this.root && e.pointerId === gesture?.id) this.cancel();
          },
        ],
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
      for (const event of ['blur', 'resize', 'pagehide'])
        window.addEventListener(event, () => this.cancelSwipe(true), { signal: this.abort.signal });
      this.update();
    }
    update() {
      this.root.classList.toggle('expo-mode', this.logic.state.ov);
      if (this.swipe?.claimed) {
        if (!this.logic.state.ov) this.clearSwipe();
        else if (!this.swipe.animations) this.prepareSwipe();
      }
      if (!this.logic.state.ov) this.cancel();
      else if (this.drag) this.paint();
    }
    beginSwipe(e) {
      const s = this.logic.state;
      if (s.ov || s.launch || s.kb || e.button !== 0 || e.isPrimary === false) return;
      const r = this.root.getBoundingClientRect();
      const x = e.clientX - r.left;
      const edge = Math.max(24, r.width * 0.08);
      if (e.clientY < r.bottom - edge || x < r.width * 0.15 || x > r.width * 0.85) return;
      this.swipe = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        lastY: e.clientY,
        lastTime: e.timeStamp,
        velocity: 0,
        progress: 0,
        distance: Math.max(
          SWIPE.minDistance,
          Math.min(SWIPE.maxDistance, r.height * SWIPE.heightFraction)
        ),
      };
    }
    moveSwipe(e) {
      const g = this.swipe;
      if (!g || e.pointerId !== g.id) return false;
      if (g.settling) return true;
      const dy = g.y - e.clientY;
      const dx = e.clientX - g.x;
      if (!g.claimed) {
        if (Math.abs(dx) > SWIPE.slop && Math.abs(dx) > Math.abs(dy)) {
          this.swipe = null;
          return false;
        }
        if (dy < SWIPE.slop) return false;
        g.claimed = true;
        g.from = this.logic.state.open
          .map(key => this.root.querySelector(`[data-workspace="${key}"]`))
          .filter(Boolean)
          .map(snapshot);
        this.root.classList.add('expo-tracking');
        this.root.setPointerCapture(g.id);
        this.logic.ptr = null;
        this.logic.set({ ov: true, kb: false, launch: false });
      }
      const elapsed = e.timeStamp - g.lastTime;
      if (elapsed > 0) g.velocity = (g.lastY - e.clientY) / elapsed;
      g.lastTime = e.timeStamp;
      g.lastY = e.clientY;
      g.progress = clamp(dy / g.distance);
      if (!this.swipeFrame)
        this.swipeFrame = requestAnimationFrame(() => {
          this.swipeFrame = null;
          if (this.swipe === g && !g.settling) this.paintSwipe(g.progress);
        });
      return true;
    }
    prepareSwipe() {
      const g = this.swipe;
      // Read every destination before installing the overrides used during scrubbing.
      const pairs = g.from.map(from => ({ from, to: snapshot(from.card) }));
      g.animations = [];
      g.pairs = pairs;
      for (const { from, to } of pairs) {
        const animation = from.card.animate([from.visual, to.visual], {
          duration: SWIPE.timelineMs,
          fill: 'both',
          easing: 'linear',
        });
        animation.pause();
        g.animations.push(animation);
        if (from.label) {
          const label = from.label.animate(
            [
              { opacity: from.labelOpacity, offset: 0 },
              { opacity: from.labelOpacity, offset: SWIPE.labelReveal },
              { opacity: to.labelOpacity, offset: 1 },
            ],
            {
              duration: SWIPE.timelineMs,
              fill: 'both',
              easing: 'linear',
            }
          );
          label.pause();
          g.animations.push(label);
        }
        from.card.dataset.expoFrame = '';
      }
      this.paintSwipe(g.progress);
      if (g.target !== undefined) this.settleSwipe(g.target);
    }
    paintSwipe(progress) {
      const g = this.swipe;
      if (!g?.animations) return;
      for (const animation of g.animations) animation.currentTime = progress * SWIPE.timelineMs;
      for (const { from, to } of g.pairs) {
        from.card.style.setProperty(
          '--expo-card-radius',
          `${from.radius + (to.radius - from.radius) * progress}px`
        );
        from.frame.forEach((value, i) =>
          from.card.style.setProperty(
            `--expo-frame-${frameVariables[i]}`,
            `${value + (to.frame[i] - value) * progress}px`
          )
        );
      }
    }
    endSwipe(e) {
      const g = this.swipe;
      if (!g || e.pointerId !== g.id) return false;
      if (!g.claimed) {
        this.swipe = null;
        return false;
      }
      const velocity = e.timeStamp - g.lastTime < SWIPE.velocityExpiry ? g.velocity : 0;
      const projection =
        g.progress * g.distance >= SWIPE.flickDistance
          ? (velocity * SWIPE.velocityProjection) / g.distance
          : 0;
      this.suppressUntil = Date.now() + 500;
      this.settleSwipe(g.progress + projection >= SWIPE.commit);
      if (this.root.hasPointerCapture(g.id)) this.root.releasePointerCapture(g.id);
      return true;
    }
    settleSwipe(open) {
      const g = this.swipe;
      if (!g) return;
      g.target = open;
      g.settling = true;
      cancelAnimationFrame(this.swipeFrame);
      this.swipeFrame = null;
      if (!g.animations) return;
      const from = g.progress;
      const to = open ? 1 : 0;
      const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SWIPE.settleMs;
      const start = performance.now();
      const step = now => {
        if (this.swipe !== g) return;
        const t = duration ? clamp((now - start) / duration) : 1;
        this.paintSwipe(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) this.swipeFrame = requestAnimationFrame(step);
        else {
          // Keep tracking overrides until the endpoint state has painted, avoiding a second transition.
          if (!open) {
            this.logic.set({ ov: false });
          } else this.clearSwipe();
        }
      };
      this.swipeFrame = requestAnimationFrame(step);
    }
    clearSwipe() {
      const g = this.swipe;
      this.swipe = null;
      cancelAnimationFrame(this.swipeFrame);
      this.swipeFrame = null;
      for (const animation of g?.animations || []) animation.cancel();
      for (const { card } of g?.from || []) {
        delete card.dataset.expoFrame;
        card.style.removeProperty('--expo-card-radius');
        for (const key of frameVariables) card.style.removeProperty(`--expo-frame-${key}`);
      }
      this.root.classList.remove('expo-tracking');
      if (g && this.root.hasPointerCapture(g.id)) this.root.releasePointerCapture(g.id);
    }
    cancelSwipe(immediate = false) {
      const g = this.swipe;
      if (!g) return;
      if (!g.claimed) return this.clearSwipe();
      if (immediate) {
        this.clearSwipe();
        this.logic.set({ ov: false });
      } else if (!g.settling) this.settleSwipe(false);
    }
    down(e) {
      if (this.swipe?.claimed) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      this.beginSwipe(e);
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
      if (this.moveSwipe(e)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
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
      if (this.endSwipe(e)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
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
      this.cancelSwipe();
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
      this.clearSwipe();
      clearTimeout(this.noticeTimer);
      this.notice?.remove();
      this.cancel();
      this.abort.abort();
    }
  }
  window.HyprlandExpo = { attach: logic => new Expo(logic) };
})();
