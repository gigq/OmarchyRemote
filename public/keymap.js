/* Per-device shortcut overrides and their editor. The desk supplies the action registry. */
(() => {
  const { node } = HyprlandUtil;
  const signature = a => [a.code, !!a.meta, !!a.ctrl, !!a.alt, !!a.shift].join(':');
  const validCode = code =>
    /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|F[235]|Enter|NumpadEnter|Escape|Tab|Space|Backspace|Comma|Period|Slash|Semicolon|Quote|Backquote|BracketLeft|BracketRight|Backslash|Equal|Minus|PageUp|PageDown)$/.test(
      code
    );
  const valid = a =>
    a &&
    validCode(a.code) &&
    (a.meta || a.ctrl) &&
    ['meta', 'ctrl', 'alt', 'shift'].every(k => typeof a[k] === 'boolean');
  const reserved = a =>
    (!a.alt &&
      !a.ctrl &&
      a.meta &&
      (['Space', 'Tab', 'Backquote', 'KeyH', 'KeyQ', 'KeyM'].includes(a.code) ||
        a.code.startsWith('Arrow') ||
        (!a.shift && ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY'].includes(a.code)) ||
        (a.shift && ['KeyZ', 'KeyV'].includes(a.code)))) ||
    (!a.meta &&
      a.ctrl &&
      !a.alt &&
      ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY'].includes(a.code));
  const signatures = a => [
    signature(a),
    ...((a.owner === 'shell' || window.__OMARCHY_PLATFORM__ === 'android') &&
    a.meta &&
    !a.ctrl &&
    !a.alt
      ? [signature({ ...a, meta: false, ctrl: true, alt: true })]
      : []),
  ];
  const clean = saved =>
    Object.fromEntries(
      Object.entries(saved || {})
        .filter(([id, v]) => id.length < 240 && (v === null || (valid(v) && !reserved(v))))
        .slice(0, 256)
        .map(([id, v]) => [
          id,
          v === null
            ? null
            : {
                code: v.code,
                meta: v.meta,
                ctrl: v.ctrl,
                alt: v.alt,
                shift: v.shift,
              },
        ])
    );
  const chord = e => ({
    code: e.code,
    meta: !!e.metaKey,
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
  });
  const matches = (a, e) => {
    if (!a.code) return false;
    if (signature(a) === signature(chord(e))) return true;
    // Keep the existing Ctrl+Alt spelling of plain Command shell bindings on the web.
    return (
      (a.owner === 'shell' || window.__OMARCHY_PLATFORM__ === 'android') &&
      a.meta &&
      !a.ctrl &&
      !a.alt &&
      !e.metaKey &&
      e.ctrlKey &&
      e.altKey &&
      a.code === e.code &&
      !!a.shift === !!e.shiftKey
    );
  };
  const resolve = (actions, overrides) => {
    const seen = new Set();
    return actions
      .map(a => {
        const custom = Object.hasOwn(overrides || {}, a.id) ? overrides[a.id] : undefined;
        return custom === null ? { ...a, code: null } : custom ? { ...a, ...custom } : a;
      })
      .map(a => {
        if (!a.code) return a;
        const keys = signatures(a);
        if (keys.some(key => seen.has(key))) return { ...a, code: null };
        keys.forEach(key => seen.add(key));
        return a;
      });
  };
  const open = desk => {
    desk.closeSheet();
    const sheet = node('div', 'desk-sheet desk-keymap');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Customize keyboard shortcuts');
    const head = node('div', 'desk-sheet-head');
    const title = node('h2', '', 'Keyboard shortcuts');
    const close = node('button', 'desk-sheet-close', 'Done');
    close.onclick = () => desk.closeSheet();
    head.append(title, close);
    const search = node('input', 'desk-action-search');
    search.type = 'search';
    search.placeholder = 'Find an action…';
    search.setAttribute('aria-label', 'Find shortcut');
    search.autocapitalize = 'none';
    search.setAttribute('autocorrect', 'off');
    const status = node('p', 'widget-muted');
    status.setAttribute('role', 'status');
    status.textContent =
      'Choose Change, then press a shortcut. Escape cancels recording. Saved for this device.';
    const list = node('div', 'desk-keymap-list');
    const reset = node('button', 'desk-sheet-close', 'Restore defaults');
    const all = () => desk.actions(true, true).filter(a => a.code && a.code !== 'NumpadEnter');
    const save = (action, value, resetOne = false) => {
      const overrides = { ...desk.logic.state.keyBindings };
      if (resetOne) delete overrides[action.id];
      else overrides[action.id] = value;
      const candidate = resetOne ? action : value;
      if (candidate) {
        if (!resetOne && !valid(candidate)) {
          status.textContent = 'Include Command or Control and a supported key.';
          return false;
        }
        if (!resetOne && reserved(candidate)) {
          status.textContent = 'That shortcut is reserved for system controls or text editing.';
          return false;
        }
        const conflict = all().find(other => {
          if (other.id === action.id) return false;
          const bound = Object.hasOwn(overrides, other.id) ? overrides[other.id] : other;
          return (
            bound &&
            signatures({ ...other, ...bound }).some(key =>
              signatures({ ...action, ...candidate }).includes(key)
            )
          );
        });
        if (conflict) {
          status.textContent = `Already assigned to ${conflict.label}. Change or disable it first.`;
          return false;
        }
      }
      desk.logic.set({ keyBindings: clean(overrides) });
      status.textContent = resetOne
        ? 'Default restored.'
        : value
          ? 'Shortcut saved.'
          : 'Shortcut disabled. The action remains in Search actions.';
      return true;
    };
    const stop = () => {
      desk.keyRecorder = null;
      desk.publishActions();
      render();
    };
    const render = () => {
      list.replaceChildren();
      for (const action of all().filter(a =>
        `${a.group} ${a.label}`.toLowerCase().includes(search.value.toLowerCase())
      )) {
        const row = node('div', 'desk-keymap-row');
        const label = node('div', 'desk-keymap-label');
        label.append(node('span', '', action.label), node('small', 'widget-muted', action.group));
        const current = Object.hasOwn(desk.logic.state.keyBindings || {}, action.id)
          ? desk.logic.state.keyBindings[action.id]
          : action;
        const change = node(
          'button',
          'desk-keymap-change',
          current ? HyprlandDesk.actionKeys(current) : 'Disabled'
        );
        change.setAttribute('aria-label', `Change shortcut for ${action.label}`);
        change.onclick = () => {
          stop();
          const button = [...list.querySelectorAll('button')].find(
            b => b.getAttribute('aria-label') === change.getAttribute('aria-label')
          );
          if (button) {
            button.textContent = 'Press shortcut…';
            button.focus();
          }
          status.textContent = `Recording ${action.label}. Escape cancels.`;
          desk.keyRecorder = e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.code === 'Escape') {
              status.textContent = 'Recording canceled.';
              stop();
              return;
            }
            if (/^(Meta|Control|Alt|Shift)/.test(e.code) || e.repeat) return;
            if (save(action, chord(e))) stop();
          };
          desk.publishActions();
        };
        const disable = node('button', '', 'Disable');
        disable.setAttribute('aria-label', `Disable shortcut for ${action.label}`);
        disable.disabled = current === null;
        disable.onclick = () => {
          save(action, null);
          stop();
        };
        const restore = node('button', '', 'Reset');
        restore.setAttribute('aria-label', `Reset shortcut for ${action.label}`);
        restore.disabled = !Object.hasOwn(desk.logic.state.keyBindings || {}, action.id);
        restore.onclick = () => {
          save(action, null, true);
          stop();
        };
        row.append(label, change, disable, restore);
        list.append(row);
      }
      if (!list.children.length) list.append(node('p', 'widget-muted', 'No matching shortcuts'));
    };
    search.oninput = render;
    reset.onclick = () => {
      desk.logic.set({ keyBindings: {} });
      status.textContent = 'All default shortcuts restored.';
      stop();
    };
    sheet.append(head, search, status, list, reset);
    desk.returnFocus = document.activeElement;
    desk.sheet = sheet;
    desk.shell.append(sheet);
    render();
    desk.logic.remote?.update?.();
    desk.updateDividers();
    search.focus({ preventScroll: true });
  };
  window.HyprlandKeymap = { clean, resolve, matches, open };
})();
