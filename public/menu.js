/* Context menus for any app (HyprlandUtil.contextMenu): a right-click, a two-finger click on a
   trackpad, a long press on touch, or the menu key opens a list of actions for what was pressed.
   Phones get a sheet along the bottom; wider screens a small menu where the press was. */
(() => {
  const { node } = HyprlandUtil;
  const HOLD = 500;
  let current = null;

  function close() {
    current?.close();
  }

  /* Opens a menu. `items` are { label, run, danger, confirm } (confirm is a question asked in the
     menu before a danger runs); `ask` instead shows a text field and resolves with its value. */
  function open({ title, items = [], x, y, ask, returnFocus }) {
    close();
    const sheet = innerWidth < 600;
    const width = innerWidth;
    // The keyboard opening for a text field resizes the page too; only a new width closes it.
    const resized = () => {
      if (innerWidth !== width) close();
    };
    const scrim = node('div', 'context-scrim' + (sheet ? ' sheet' : ''));
    const menu = node('div', 'context-menu legend accent' + (sheet ? ' sheet' : ''));
    menu.setAttribute('role', ask ? 'dialog' : 'menu');
    menu.setAttribute('aria-label', title);
    menu.append(node('span', 'legend-title', title));
    scrim.append(menu);
    const state = {
      close() {
        if (current !== state) return;
        current = null;
        scrim.remove();
        document.removeEventListener('keydown', keys, true);
        window.removeEventListener('resize', resized);
        state.done?.(null);
        returnFocus?.focus?.({ preventScroll: true });
      },
    };
    current = state;
    scrim.onpointerdown = e => {
      if (e.target === scrim) e.preventDefault();
    };
    scrim.onclick = e => {
      e.stopPropagation();
      if (e.target === scrim) close();
    };
    scrim.oncontextmenu = e => {
      e.preventDefault();
      if (e.target === scrim) close();
    };
    const choices = () => [...menu.querySelectorAll('button:not(:disabled)')];
    const keys = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !ask) {
        e.preventDefault();
        const list = choices();
        const at = list.indexOf(document.activeElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : at + step;
        list[(next + list.length) % list.length]?.focus();
      }
    };
    document.addEventListener('keydown', keys, true);
    window.addEventListener('resize', resized);
    const item = (label, run, cls = '') => {
      const b = node('button', 'context-item ' + cls, label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.onclick = e => {
        e.stopPropagation();
        run();
      };
      return b;
    };
    const confirm = entry => {
      menu.replaceChildren(node('span', 'legend-title', title));
      menu.classList.replace('accent', 'danger');
      menu.append(node('p', 'context-question', entry.confirm), node('div', 'context-actions'));
      menu.lastChild.append(
        item('Cancel', close),
        item(
          entry.label,
          () => {
            close();
            entry.run();
          },
          'danger'
        )
      );
      choices()[0].focus();
    };
    let result;
    if (ask) {
      result = new Promise(resolve => (state.done = resolve));
      const form = node('form', 'context-form');
      const field = node('input', 'context-field');
      field.value = ask.value || '';
      field.setAttribute('aria-label', ask.label || title);
      field.maxLength = ask.max || 200;
      field.enterKeyHint = 'done';
      const save = item(ask.action || 'Save', () => {});
      save.type = 'submit';
      const actions = node('div', 'context-actions');
      actions.append(item('Cancel', close), save);
      form.append(field, actions);
      form.onsubmit = e => {
        e.preventDefault();
        const value = field.value.trim();
        if (!value) return;
        const done = state.done;
        state.done = null;
        close();
        done(value);
      };
      menu.append(form);
      setTimeout(() => {
        field.focus();
        field.select();
      });
    } else {
      for (const entry of items.filter(Boolean)) {
        menu.append(
          item(
            entry.label,
            () => {
              if (entry.confirm) return confirm(entry);
              close();
              entry.run();
            },
            entry.danger ? 'danger' : ''
          )
        );
      }
    }
    document.body.append(scrim);
    if (!sheet) {
      // Beside the press, kept on screen.
      const box = menu.getBoundingClientRect();
      const left = Math.min(Math.max(8, x ?? 8), innerWidth - box.width - 8);
      const top = (y ?? 8) + box.height > innerHeight - 8 ? (y ?? 8) - box.height : (y ?? 8);
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
    }
    // The menu takes focus, so arrows and Escape work, without marking an item as chosen.
    menu.tabIndex = -1;
    if (!ask) menu.focus({ preventScroll: true });
    return result;
  }

  /* Gives `target` a menu; `menu()` returns { title, items } when it opens. A long press that
     opened a menu does not also click the target. */
  function contextMenu(target, menu) {
    let timer = 0;
    let start = null;
    let held = false;
    const show = (x, y) => {
      const spec = menu();
      if (spec) open({ ...spec, x, y, returnFocus: target });
    };
    target.classList.add('has-context-menu');
    target.addEventListener('contextmenu', e => {
      // Desk mode's window drags use the right button too.
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (held) return;
      show(e.clientX, e.clientY);
    });
    target.addEventListener('pointerdown', e => {
      held = false;
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => {
        held = true;
        navigator.vibrate?.(10);
        show(start.x, start.y);
      }, HOLD);
    });
    const cancel = () => clearTimeout(timer);
    target.addEventListener('pointermove', e => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    });
    target.addEventListener('pointerup', cancel);
    target.addEventListener('pointercancel', cancel);
    target.addEventListener(
      'click',
      e => {
        if (!held) return;
        held = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );
    target.addEventListener('keydown', e => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      const box = target.getBoundingClientRect();
      show(box.left + 16, box.bottom);
    });
  }

  Object.assign(HyprlandUtil, {
    contextMenu,
    openMenu: open,
    closeMenu: close,
    // Asks for a line of text in the same sheet; resolves with it, or null when cancelled.
    askText: (title, ask) => open({ title, ask }),
  });
})();
