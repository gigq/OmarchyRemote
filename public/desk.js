/* Desk layout for iPad, Mac, and desktop windows: workspaces tile up to four windows
   (Hyprland dwindle), a hardware keyboard drives the shell, and ⌘/ shows the bindings.
   The phone shell keeps one app per workspace; nothing here runs below the size threshold. */
(() => {
  const MIN_SIDE = 600,
    MAX_TILES = 4;
  const CHROME = { top: 54, side: 10, bottom: 10, gap: 6 };
  const APPLE =
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ||
    /Macintosh|iPad|iPhone/.test(navigator.userAgent);
  const MOD = APPLE ? '⌘' : 'Ctrl+Alt';
  const NATIVE = !!window.webkit?.messageHandlers?.shellKeyboard;
  const { mount, node } = window.HyprlandUtil;
  const isDesk = () => Math.min(window.innerWidth, window.innerHeight) >= MIN_SIDE;

  // ---- workspace model: pure functions over the shell state ---------------------------------
  // `open` stays the ordered list of open apps; `tiles` maps each app to its desk index (home is desk 0).
  const desks = s => {
    const t = s.tiles || {};
    const rows = s.open
      .filter(k => k !== 'home' && k !== s.scratchKey)
      .map((k, i) => [k, Number.isInteger(t[k]) && t[k] > 0 ? t[k] : 1e6 + i]);
    const ids = [...new Set(rows.map(r => r[1]))].sort((a, b) => a - b);
    return [['home'], ...ids.map(id => rows.filter(r => r[1] === id).map(r => r[0]))];
  };
  const normalize = s => {
    const tiles = {};
    desks(s).forEach((apps, i) => {
      if (i) for (const k of apps) tiles[k] = i;
    });
    return tiles;
  };
  const deskOf = (s, key) => desks(s).findIndex(d => d.includes(key));
  const groupMembers = (s, key) => {
    const apps = desks(s)[deskOf(s, key)] || [];
    const group = s.groups?.[key];
    return group ? apps.filter(k => s.groups?.[k] === group) : [key];
  };
  const tileMembers = (s, apps) => {
    const result = [],
      seen = new Set();
    for (const key of apps) {
      const id = s.groups?.[key] || key;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(s.groups?.[key] ? apps.filter(k => s.groups?.[k] === id) : [key]);
    }
    return result;
  };
  const cur = s => {
    if (s.scratchVisible && s.open.includes(s.scratchKey)) return s.scratchKey;
    const d = desks(s)[s.ws] || ['home'];
    if (d.includes(s.focus)) return s.focus;
    const selected = s.groupActive?.[s.groups?.[d[0]]];
    return d.includes(selected) && s.groups?.[selected] === s.groups?.[d[0]] ? selected : d[0];
  };
  const clamp = (s, i) => Math.max(0, Math.min(desks(s).length - 1, i));
  const go = (s, i) => {
    const ws = clamp(s, i);
    return {
      ws,
      focus: desks(s)[ws].includes(s.focus) ? s.focus : null,
      tiles: normalize(s),
      scratchVisible: false,
    };
  };
  const open = (s, key) => {
    if (key === s.scratchKey) return { scratchVisible: true, focus: key };
    if (s.open.includes(key)) return { ws: deskOf(s, key), focus: key, tiles: normalize(s) };
    const d = desks(s);
    const target = s.ws === 0 || (d[s.ws] || []).length >= MAX_TILES ? d.length : s.ws;
    const ns = { ...s, open: [...s.open, key], tiles: { ...normalize(s), [key]: target } };
    return { open: ns.open, tiles: normalize(ns), ws: deskOf(ns, key), focus: key };
  };
  const close = (s, key) => {
    if (key === s.scratchKey)
      return {
        open: s.open.filter(k => k !== key),
        scratchKey: null,
        scratchVisible: false,
        focus: null,
      };
    const before = desks(s),
      pos = before.findIndex(d => d.includes(key)),
      current = before[s.ws] || ['home'];
    const tiles = { ...normalize(s) };
    delete tiles[key];
    const ns = { ...s, open: s.open.filter(k => k !== key), tiles };
    const after = desks(ns);
    const survivors = current.filter(k => k !== key);
    let ws = after.findIndex(d => d.some(k => survivors.includes(k)));
    if (ws < 0) ws = Math.max(0, Math.min(pos - 1, after.length - 1));
    return {
      open: ns.open,
      tiles: normalize(ns),
      full: (s.full || []).filter(k => k !== key),
      ws,
      focus: after[ws]?.includes(s.focus) ? s.focus : null,
    };
  };
  const move = (s, key, target, follow = true) => {
    if (!key || key === 'home' || key === s.scratchKey || !s.open.includes(key)) return null;
    const d = desks(s);
    target = Math.max(1, Math.min(d.length, target));
    if (deskOf(s, key) === target || (d[target]?.length || 0) >= MAX_TILES) return null;
    const ns = { ...s, tiles: { ...normalize(s), [key]: target } };
    return {
      tiles: normalize(ns),
      ws: follow
        ? deskOf(ns, key)
        : Math.max(0, deskOf(ns, d[s.ws]?.find(k => k !== key) || 'home')),
      focus: follow ? key : d[s.ws]?.find(k => k !== key) || 'home',
      full: (s.full || []).filter(k => k !== key),
    };
  };
  const swap = (s, key, other) => {
    if (!key || !other || key === other) return null;
    const open = [...s.open],
      a = open.indexOf(key),
      b = open.indexOf(other);
    if (a < 0 || b < 0) return null;
    [open[a], open[b]] = [open[b], open[a]];
    return { open, focus: key };
  };
  const MODES = {
    dwindle: 'Dwindle (Omarchy default)',
    master: 'Master and stack',
    scrolling: 'Scrolling columns',
  };
  const mode = s => (Object.hasOwn(MODES, s.windowLayout) ? s.windowLayout : 'dwindle');
  // Split identities follow the ordered apps, not a workspace number that can be renumbered.
  const splitID = (s, apps, index) =>
    JSON.stringify([mode(s), apps.map(k => s.groups?.[k] || k), index]);
  const boundedRatio = (value, length) => {
    const min = Math.min(0.45, 120 / Math.max(1, length));
    return Math.max(min, Math.min(1 - min, Number.isFinite(value) ? value : 0.5));
  };
  const tiled = (s, apps, rect, splits, desk, index = 0) => {
    if (apps.length - index <= 1) return [rect];
    const master = mode(s) === 'master';
    const id = splitID(s, apps, index);
    const override = s.splitAxes?.[id];
    const axis =
      !master && ['x', 'y'].includes(override)
        ? override
        : master
          ? index === 0
            ? 'x'
            : 'y'
          : rect.w >= rect.h
            ? 'x'
            : 'y';
    const dimension = axis === 'x' ? 'w' : 'h';
    const length = rect[dimension] - CHROME.gap;
    const fallback = master && index > 0 ? 1 / (apps.length - index) : 0.5;
    const ratio = boundedRatio(s.splits?.[id] ?? fallback, length);
    const a = { ...rect },
      b = { ...rect };
    a[dimension] = Math.round(length * ratio);
    b[axis] += a[dimension] + CHROME.gap;
    b[dimension] = length - a[dimension];
    splits.push({
      id,
      desk,
      axis,
      rect,
      length,
      position: rect[axis] + a[dimension] + CHROME.gap / 2,
      apps: apps.slice(index),
    });
    return [a, ...tiled(s, apps, b, splits, desk, index + 1)];
  };
  const floatingRect = (area, saved = {}) => {
    const w = Math.min(area.w, Math.max(240, Number.isFinite(saved.w) ? saved.w : area.w * 0.7));
    const h = Math.min(area.h, Math.max(200, Number.isFinite(saved.h) ? saved.h : area.h * 0.7));
    return {
      x: Math.max(
        area.x,
        Math.min(
          area.x + area.w - w,
          Number.isFinite(saved.x) ? saved.x : area.x + (area.w - w) / 2
        )
      ),
      y: Math.max(
        area.y,
        Math.min(
          area.y + area.h - h,
          Number.isFinite(saved.y) ? saved.y : area.y + (area.h - h) / 2
        )
      ),
      w,
      h,
    };
  };
  // Hidden siblings of a fullscreen window retain the full area.
  const layout = (s, W, H) => {
    const area = {
      x: CHROME.side,
      y: CHROME.top,
      w: Math.max(0, W - CHROME.side * 2),
      h: Math.max(0, H - CHROME.top - CHROME.bottom),
    };
    const rects = new Map(),
      splits = [],
      columns = new Map();
    desks(s).forEach((apps, desk) => {
      const full = apps.find(k => (s.full || []).includes(k));
      const floats = apps.filter(k => k !== 'home' && s.floating?.[k]);
      const tiledApps = apps.filter(k => !floats.includes(k));
      const visible = full
        ? [full]
        : tileMembers(s, tiledApps).map(members =>
            members.includes(s.focus)
              ? s.focus
              : members.includes(s.groupActive?.[s.groups?.[members[0]]])
                ? s.groupActive[s.groups[members[0]]]
                : members[0]
          );
      let rs;
      if (desk > 0 && !full && mode(s) === 'scrolling') {
        const anchor = apps[0],
          height = Math.max(0, area.h - 30);
        const widths = visible.map(
          k => area.w * Math.max(0.25, Math.min(1, s.columnWidths?.[s.groups?.[k] || k] || 0.49))
        );
        const total =
          widths.reduce((a, b) => a + b, 0) + CHROME.gap * Math.max(0, widths.length - 1);
        const offset = Math.max(
          0,
          Math.min(Math.max(0, total - area.w), s.columnOffsets?.[anchor] || 0)
        );
        let x = area.x;
        rs = visible.map((key, i) => {
          const rect = { x: x - offset, y: area.y, w: widths[i], h: height };
          splits.push({
            id: s.groups?.[key] || key,
            desk,
            axis: 'x',
            rect: { ...rect, w: area.w },
            length: area.w,
            position: rect.x + rect.w + CHROME.gap / 2,
            apps: [key],
            column: true,
          });
          x += widths[i] + CHROME.gap;
          return rect;
        });
        columns.set(desk, { anchor, total, offset, keys: visible, widths });
      } else rs = desk === 0 ? [area] : tiled(s, visible, area, splits, desk);
      visible.forEach((k, i) => rects.set(k, { ...rs[i], desk }));
      if (!full)
        for (const key of floats)
          rects.set(key, { ...floatingRect(area, s.floating[key]), desk, floating: true });
      apps
        .filter(k => !visible.includes(k) && (full || !floats.includes(k)))
        .forEach(k => {
          const selected = visible.find(v => groupMembers(s, k).includes(v));
          rects.set(k, { ...(selected ? rects.get(selected) : area), desk, hidden: true });
        });
    });
    if (s.open.includes(s.scratchKey)) {
      const saved = s.scratchRect || {};
      const w = Math.max(240, Math.min(area.w, Number.isFinite(saved.w) ? saved.w : area.w * 0.8));
      const h = Math.max(200, Math.min(area.h, Number.isFinite(saved.h) ? saved.h : area.h * 0.75));
      rects.set(s.scratchKey, {
        x: Math.max(
          area.x,
          Math.min(
            area.x + area.w - w,
            Number.isFinite(saved.x) ? saved.x : area.x + (area.w - w) / 2
          )
        ),
        y: Math.max(
          area.y,
          Math.min(
            area.y + area.h - h,
            Number.isFinite(saved.y) ? saved.y : area.y + (area.h - h) / 2
          )
        ),
        w,
        h,
        desk: s.ws,
        hidden: s.ov || !s.scratchVisible,
        scratch: true,
      });
    }
    return { area, rects, splits, columns };
  };
  const neighbor = (s, W, H, key, dir) => {
    const { rects } = layout(s, W, H),
      from = rects.get(key);
    if (!from) return null;
    const cx = from.x + from.w / 2,
      cy = from.y + from.h / 2;
    let best = null,
      score = Infinity;
    for (const [k, r] of rects) {
      if (k === key || r.desk !== from.desk || r.hidden) continue;
      const dx = r.x + r.w / 2 - cx,
        dy = r.y + r.h / 2 - cy;
      const ahead = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      if (ahead <= 4) continue;
      const drift = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const d = ahead + drift * 2;
      if (d < score) {
        score = d;
        best = k;
      }
    }
    return best;
  };
  // Card bindings for renderVals: transforms, sizes, frames, pills, and the workspace label.
  const render = (logic, s, W, H) => {
    const A = logic.APPS,
      d = desks(s),
      focused = cur(s),
      { area, rects, columns } = layout(s, W, H);
    const n = d.length,
      cols = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * W) / Math.max(1, H))))),
      rows = Math.ceil(n / cols);
    const eg = Math.max(28, CHROME.gap * 2),
      ex = CHROME.side,
      ey = CHROME.top + 8,
      ew = Math.max(1, W - ex * 2),
      eh = Math.max(1, H - ey - CHROME.bottom - 8);
    const sc = Math.max(
      0.05,
      Math.min(
        (ew - (cols - 1) * eg) / cols / Math.max(1, W),
        (eh - (rows - 1) * eg) / rows / Math.max(1, H)
      )
    );
    const gx = ex + (ew - (cols * W * sc + (cols - 1) * eg)) / 2,
      gy = ey + (eh - (rows * H * sc + (rows - 1) * eg)) / 2;
    const cards = {};
    for (const k of Object.keys(A)) {
      const r = rects.get(k);
      // Park unopened windows at the workspace's final height and size for horizontal entry.
      if (!r) {
        cards[k] = {
          tf: `translate(${W + 40}px,${area.y}px) scale(1)`,
          w: area.w + 'px',
          h: area.h + 'px',
          bd: 'var(--theme-window-inactive)',
          lab: 0,
          op: 0,
          pe: 'none',
          tap: () => {},
        };
        continue;
      }
      const column = columns.get(r.desk);
      const previewScale = s.ov && column ? Math.min(1, area.w / column.total) : 1;
      const previewX = column ? area.x + (r.x + column.offset - area.x) * previewScale : r.x;
      const previewY = area.y + (r.y - area.y) * previewScale;
      const tf = s.ov
        ? `translate(${Math.round(gx + (r.desk % cols) * (W * sc + eg) + previewX * sc)}px,${Math.round(gy + Math.floor(r.desk / cols) * (H * sc + eg) + previewY * sc)}px) scale(${(sc * previewScale).toFixed(4)})`
        : `translate(${r.x + (r.desk - s.ws) * W}px,${r.y}px) scale(1)`;
      cards[k] = {
        tf,
        w: r.w + 'px',
        h: r.h + 'px',
        bd:
          k === focused && r.desk === s.ws ? 'var(--theme-accent)' : 'var(--theme-window-inactive)',
        lab: s.ov ? 1 : 0,
        z: r.scratch ? 30 : r.floating ? 10 + (s.floatOrder || []).indexOf(k) : 0,
        floating: !!r.floating,
        visibility: mode(s) === 'scrolling' && !s.ov && r.desk !== s.ws ? 'hidden' : 'visible',
        op: r.hidden ? 0 : 1,
        pe: r.hidden ? 'none' : 'auto',
        tap: () => {
          if (logic.state.ov) logic.jump(k);
        },
      };
    }
    const pills = d.map((apps, i) => ({
      i: i + 1,
      col: logic.T.mu,
      bg: i === s.ws ? logic.T.sf2 : 'transparent',
      c: i === s.ws ? logic.T.fg : logic.T.mu,
      on: () => {
        if (i === logic.state.ws) logic.set({ ov: !logic.state.ov, kb: false });
        else logic.go(i);
      },
    }));
    const label = A[focused]?.name || focused;
    return { cards, pills, label };
  };

  // ---- keyboard bindings ------------------------------------------------------------------------
  // Apple keyboards use ⌘ (SUPER on Omarchy); elsewhere Ctrl+Alt stays clear of terminal and browser keys.
  // App bindings come from the catalog (`deskKeys` in public/apps.js) so a new app needs no
  // shell change; they sit between the window and shell groups.
  const appBindings = () =>
    Object.values(window.HyprlandApps?.catalog || {}).flatMap(app =>
      (app.deskKeys || []).map(b => ({
        group: 'Apps',
        focusShell: !!app.native,
        ...b,
        run: d => {
          const current = d.logic.cur();
          const front =
            (HyprlandApps.get(current)?.baseKey || current) === app.key &&
            d.logic.remote?.app(current);
          if (b.reopen && front?.reopen) front.reopen();
          else d.logic.openApp(app.key);
          if (app.native) d.logic.set({ kb: true });
        },
      }))
    );
  const bindings = () => {
    const shell = BINDINGS.findIndex(b => b.group === 'Shell');
    return [...BINDINGS.slice(0, shell), ...appBindings(), ...BINDINGS.slice(shell)];
  };
  const BINDINGS = [
    {
      group: 'Hosts',
      keys: '⌃ 1…9 / 0',
      ctrl: true,
      code: /^Digit[0-9]$/,
      desk: true,
      label: 'Switch to host',
      run: (d, e) => window.HyprlandHosts?.switchIndex((Number(e.code.slice(5)) || 10) - 1),
    },
    {
      group: 'Workspaces',
      keys: '1…9 / 0',
      code: /^Digit[0-9]$/,
      label: 'Switch to workspace',
      run: (d, e) => d.logic.go((Number(e.code.slice(5)) || 10) - 1),
    },
    {
      group: 'Workspaces',
      keys: '⇧ P',
      shift: true,
      code: /^KeyP$/,
      desk: true,
      label: 'Return to previous workspace',
      run: d => d.previousWorkspace(),
    },
    {
      group: 'Windows',
      keys: '⌥ ⇧ ← ↑ ↓ →',
      alt: true,
      shift: true,
      code: /^Arrow/,
      desk: true,
      label: 'Resize active window',
      run: (d, e) => d.resizeActive(e.code.slice(5).toLowerCase()),
    },
    {
      group: 'Windows',
      keys: '⇧ O',
      shift: true,
      code: /^KeyO$/,
      desk: true,
      label: 'Toggle floating window',
      run: d => d.toggleFloating(),
    },
    {
      group: 'Windows',
      keys: 'S',
      code: /^KeyS$/,
      desk: true,
      label: 'Show or hide scratchpad',
      run: d => d.toggleScratch(),
    },
    {
      group: 'Windows',
      keys: '⇧ S',
      code: /^KeyS$/,
      shift: true,
      desk: true,
      label: 'Send window to scratchpad or return it',
      run: d => d.stashWindow(),
    },
    {
      group: 'Windows',
      keys: '⇧ X',
      shift: true,
      code: /^KeyX$/,
      desk: true,
      label: 'Move window to next workspace without following',
      run: d => d.moveWindow(d.logic.state.ws + 1, false),
    },
    {
      group: 'Windows',
      keys: '⇧ Y',
      shift: true,
      code: /^KeyY$/,
      desk: true,
      label: 'Toggle split direction',
      run: d => d.toggleSplit(),
    },
    {
      group: 'Windows',
      keys: '⇧ U',
      shift: true,
      code: /^KeyU$/,
      desk: true,
      label: 'Cycle window layout',
      run: d => d.cycleLayout(),
    },
    {
      group: 'Workspaces',
      keys: '[ / ]',
      code: /^Bracket(Left|Right)$/,
      label: 'Previous / next workspace',
      run: (d, e) => d.logic.go(d.logic.state.ws + (e.code === 'BracketLeft' ? -1 : 1)),
    },
    {
      group: 'Workspaces',
      keys: 'E',
      code: /^KeyE$/,
      label: 'Expo overview',
      run: d => d.logic.set({ ov: !d.logic.state.ov, kb: false, launch: false }),
    },
    {
      group: 'Windows',
      keys: NATIVE ? '⌥ 1…9 / 0' : '⇧ 1…9 / 0',
      shift: !NATIVE,
      alt: NATIVE,
      code: /^Digit[0-9]$/,
      desk: true,
      label: 'Move window to workspace',
      run: (d, e) => d.moveWindow((Number(e.code.slice(5)) || 10) - 1),
    },
    {
      group: 'Windows',
      keys: '⇧ [ / ]',
      shift: true,
      code: /^Bracket(Left|Right)$/,
      desk: true,
      label: 'Move window to previous / next workspace',
      run: (d, e) => d.moveWindow(d.logic.state.ws + (e.code === 'BracketLeft' ? -1 : 1)),
    },
    {
      group: 'Windows',
      keys: '← ↑ ↓ →',
      code: /^Arrow/,
      label: 'Focus window in direction',
      run: (d, e) => d.focusDir(e.code.slice(5).toLowerCase()),
    },
    {
      group: 'Windows',
      keys: '⇧ ← ↑ ↓ →',
      shift: true,
      code: /^Arrow/,
      desk: true,
      label: 'Swap window in direction',
      run: (d, e) => d.swapDir(e.code.slice(5).toLowerCase()),
    },
    {
      group: 'Windows',
      keys: 'J',
      code: /^KeyJ$/,
      desk: true,
      label: 'Next window in workspace',
      run: d => d.cycle(1),
    },
    {
      group: 'Windows',
      keys: '⇧ J',
      shift: true,
      code: /^KeyJ$/,
      desk: true,
      label: 'Previous window in workspace',
      run: d => d.cycle(-1),
    },
    {
      group: 'Windows',
      keys: 'F',
      code: /^KeyF$/,
      desk: true,
      label: 'Toggle fullscreen window',
      run: d => d.toggleFull(),
    },
    {
      group: 'Windows',
      keys: 'W',
      code: /^KeyW$/,
      label: 'Close window',
      run: d => d.logic.closeWs(),
    },
    {
      group: 'Windows',
      browserOnly: true,
      keys: '⌫',
      code: /^Backspace$/,
      label: `Close window (when the browser owns ${APPLE ? '⌘W' : 'Ctrl+W'})`,
      run: d => d.logic.closeWs(),
    },
    {
      group: 'Shell',
      keys: '⇧ K',
      shift: true,
      code: /^KeyK$/,
      label: 'Search actions',
      focusShell: true,
      run: d => d.openPalette(),
    },
    {
      group: 'Shell',
      keys: 'K',
      code: /^KeyK$/,
      label: 'Launcher',
      run: d =>
        d.logic.state.launch
          ? d.logic.set({ launch: false, kb: false, query: '' })
          : d.logic.openLauncher(),
    },
    {
      group: 'Shell',
      keys: '/',
      code: /^Slash$/,
      label: 'Show these shortcuts',
      keepSheet: true,
      run: d => d.toggleSheet(),
    },
  ];
  const EDITING = new Set([
    'KeyA',
    'KeyC',
    'KeyV',
    'KeyX',
    'KeyZ',
    'Backspace',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
  ]);
  const editable = el =>
    !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  const KEY_CODES = [
    ...Array.from({ length: 26 }, (_, i) => 'Key' + String.fromCharCode(65 + i)),
    ...Array.from({ length: 10 }, (_, i) => 'Digit' + i),
    'BracketLeft',
    'BracketRight',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Enter',
    'NumpadEnter',
    'Backspace',
    'Comma',
    'Slash',
  ];
  const keyName = code =>
    ({
      Enter: '↩',
      NumpadEnter: '↩',
      Backspace: '⌫',
      Comma: ',',
      Slash: '/',
      BracketLeft: '[',
      BracketRight: ']',
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      Equal: '+',
      Minus: '−',
      NumpadAdd: '+',
      NumpadSubtract: '−',
      Tab: 'Tab',
      Escape: 'Esc',
    })[code] || code.replace(/^(Key|Digit)/, '');
  const actionKeys = a => {
    if (APPLE)
      return `${a.meta ? '⌘ ' : ''}${a.ctrl ? 'Ctrl+' : ''}${a.alt ? '⌥ ' : ''}${a.shift ? '⇧ ' : ''}${keyName(a.code)}`;
    const alias =
      a.meta &&
      !a.ctrl &&
      !a.alt &&
      (a.owner === 'shell' || window.__OMARCHY_PLATFORM__ === 'android');
    return `${alias ? 'Ctrl+Alt+' : `${a.meta ? 'Meta+' : ''}${a.ctrl ? 'Ctrl+' : ''}${a.alt ? 'Alt+' : ''}`}${a.shift ? 'Shift+' : ''}${keyName(a.code)}`;
  };
  const signature = a => [a.code, !!a.meta, !!a.ctrl, !!a.alt, !!a.shift].join(':');
  const superPressed = e => e.metaKey || (e.ctrlKey && e.altKey);

  class Desk {
    constructor(logic) {
      this.logic = logic;
      this.abort = new AbortController();
      const signal = this.abort.signal;
      this.shell = mount('touch-shell');
      window.addEventListener('keydown', e => this.keydown(e), { capture: true, signal });
      this.shell?.addEventListener('pointerdown', e => this.pointerdown(e), {
        capture: true,
        signal,
      });
      this.shell?.addEventListener(
        'pointermove',
        e => {
          if (e.pointerType !== 'mouse' || e.buttons) return;
          const position = `${e.clientX},${e.clientY}`;
          if (position === this.pointerPosition) return;
          this.pointerPosition = position;
          this.hoverFocus(e.target.closest('[data-workspace]')?.dataset.workspace);
        },
        { capture: true, signal }
      );
      window.addEventListener('hyprland-layout', e => this.measure(e.detail), { signal });
      window.addEventListener('pointermove', e => this.dragMove(e), { capture: true, signal });
      window.addEventListener('pointerup', e => this.dragEnd(e), { capture: true, signal });
      window.addEventListener('pointercancel', () => this.cancelDrag(), { signal });
      window.addEventListener('blur', () => this.cancelDrag(), { signal });
      this.shell?.addEventListener(
        'contextmenu',
        e => {
          if (this.drag || (superPressed(e) && this.logic.state.desk)) e.preventDefault();
        },
        { capture: true, signal }
      );
      this.shell?.addEventListener(
        'click',
        e => {
          if (performance.now() < (this.suppressClickUntil || 0)) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        },
        { capture: true, signal }
      );
      this.columnScroll = node('div', 'desk-column-scroll');
      this.columnScroll.setAttribute('aria-label', 'Scroll workspace windows');
      this.columnScroll.tabIndex = 0;
      this.columnTrack = node('div', 'desk-column-track');
      this.columnScroll.append(this.columnTrack);
      this.shell?.append(this.columnScroll);
      this.columnScroll.addEventListener(
        'wheel',
        e => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            this.columnScroll.scrollLeft += e.deltaY;
          }
        },
        { passive: false, signal }
      );
      this.columnScroll.onscroll = () => {
        const s = this.logic.state,
          info = layout(s, s.deskW, s.deskH).columns.get(s.ws);
        if (!info || Math.abs(this.columnScroll.scrollLeft - info.offset) < 1) return;
        this.shell.classList.add('desk-scrolling');
        clearTimeout(this.scrollEnd);
        this.scrollEnd = setTimeout(() => this.shell.classList.remove('desk-scrolling'), 150);
        this.logic.set({
          columnOffsets: { ...s.columnOffsets, [info.anchor]: this.columnScroll.scrollLeft },
        });
      };
      this.dividers = node('div', 'desk-dividers');
      this.shell?.append(this.dividers);
      this.measure();
      this.update();
    }
    measure(detail) {
      const viewport = mount('phone-viewport');
      const desk = detail ? detail.desk : isDesk();
      const inset = detail ? detail.inset : 0;
      const W = detail ? detail.width : viewport?.clientWidth || window.innerWidth,
        H = Math.max(
          0,
          (detail ? detail.height : viewport?.clientHeight || window.innerHeight) - inset
        );
      const s = this.logic.state;
      if (s.desk !== desk || (desk && (s.deskW !== W || s.deskH !== H)))
        this.logic.set({ desk, deskW: W, deskH: H });
    }
    update() {
      const s = this.logic.state;
      const apps = desks(s)[s.ws] || ['home'];
      const oldApps = this.lastWorkspaceApps;
      const changed = this.lastWs != null && this.lastWs !== s.ws;
      this.lastWs = s.ws;
      const focused = cur(s);
      if (s.floating?.[focused] && s.floatOrder?.at(-1) !== focused)
        this.logic.set({
          floatOrder: [
            ...(s.floatOrder || []).filter(k => k !== focused && s.open.includes(k)),
            focused,
          ],
        });
      const group = s.groups?.[focused];
      if (group && s.groupActive?.[group] !== cur(s))
        this.logic.set({ groupActive: { ...s.groupActive, [group]: cur(s) } });
      const anchor = apps.includes(cur(s)) ? cur(s) : apps[0];
      this.lastWorkspaceApps = [anchor, ...apps.filter(k => k !== anchor)];
      if (changed && oldApps) {
        const previousWindow = oldApps.find(k => s.open.includes(k) && !apps.includes(k));
        if (previousWindow && s.previousWindow !== previousWindow)
          this.logic.set({ previousWindow });
      }
      if (!s.desk && this.sheet) this.closeSheet();
      if (
        this.drag &&
        (!this.canDrag() || s.ws !== this.drag.ws || !s.open.includes(this.drag.key))
      )
        this.cancelDrag();
      this.updateColumns();
      this.updateDividers();
      this.publishActions();
    }
    pointerdown(e) {
      const s = this.logic.state;
      if (!s.desk || s.ov) return;
      const divider = e.target.closest('[data-desk-split]');
      if (divider || (superPressed(e) && [0, 2].includes(e.button))) {
        if (this.startDrag(e, divider?.dataset.deskSplit)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.shell.setPointerCapture?.(e.pointerId);
          return;
        }
      }
      if (e.button > 0) return;
      const key = e.target.closest('[data-workspace]')?.dataset.workspace;
      if (key && key !== s.scratchKey && s.scratchVisible)
        this.logic.set({ scratchVisible: false });
      if (key && key !== this.logic.cur() && deskOf(s, key) === s.ws) this.logic.focusApp(key);
    }
    updateColumns() {
      if (!this.columnScroll) return;
      const s = this.logic.state,
        geometry = layout(s, s.deskW, s.deskH),
        info = geometry.columns.get(s.ws);
      const hidden = !s.desk || !info?.keys.length || !this.canDrag() || s.scratchVisible;
      this.columnScroll.hidden = hidden;
      if (hidden) {
        this.columnMode = null;
        return;
      }
      const focused = cur(s),
        rect = geometry.rects.get(focused);
      if ((this.columnFocus !== focused || this.columnMode !== mode(s)) && rect) {
        let offset = info.offset;
        if (rect.x < geometry.area.x) offset += rect.x - geometry.area.x;
        else if (rect.x + rect.w > geometry.area.x + geometry.area.w)
          offset += rect.x + rect.w - geometry.area.x - geometry.area.w;
        this.columnFocus = focused;
        this.columnMode = mode(s);
        if (Math.abs(offset - info.offset) > 1)
          this.logic.set({ columnOffsets: { ...s.columnOffsets, [info.anchor]: offset } });
      }
      this.columnScroll.style.cssText = `left:${geometry.area.x}px;top:${geometry.area.y + geometry.area.h - 24}px;width:${geometry.area.w}px`;
      const signature = JSON.stringify([info.keys, info.widths]);
      if (this.columnSignature !== signature) {
        this.columnSignature = signature;
        this.columnTrack.replaceChildren(
          ...info.keys.map((key, i) => {
            const button = node('button', '', HyprlandApps.get(key)?.name || key);
            button.style.width = info.widths[i] + 'px';
            button.onclick = () => this.logic.focusApp(key);
            return button;
          })
        );
      }
      if (Math.abs(this.columnScroll.scrollLeft - info.offset) > 1)
        this.columnScroll.scrollLeft = info.offset;
    }
    actions(allProviders = false, defaults = false) {
      const result = [];
      for (const b of bindings()) {
        if ((b.desk && !this.logic.state.desk) || (b.browserOnly && NATIVE)) continue;
        for (const code of KEY_CODES.filter(code => b.code.test(code))) {
          let label = b.label;
          if (code.startsWith('Digit')) label += ' ' + (Number(code.slice(5)) || 10);
          else if (code.startsWith('Arrow') || code.startsWith('Bracket'))
            label += ' · ' + keyName(code);
          result.push({
            id: `shell:${b.label}:${code === 'NumpadEnter' ? 'Enter' : code}`,
            owner: 'shell',
            code,
            label,
            group: b.group,
            meta: true,
            ctrl: !!b.ctrl,
            alt: !!b.alt,
            shift: !!b.shift,
            editing: code.startsWith('Arrow') && !b.alt,
            focusShell: !!b.focusShell,
            keepSheet: !!b.keepSheet,
            run: () => b.run(this, { code }),
          });
        }
      }
      for (const app of Object.values(HyprlandApps.catalog).filter(
        a => this.logic.state.desk && !a.baseKey && a.provider?.multiple
      ))
        result.push({
          label: 'New ' + app.name + ' window',
          group: 'Windows',
          run: () => this.newWindow(app.key),
        });
      if (this.logic.state.desk)
        result.push(
          { label: 'Group window with next tile', group: 'Windows', run: () => this.groupWindow() },
          { label: 'Remove window from group', group: 'Windows', run: () => this.ungroupWindow() }
        );
      const providers = allProviders
        ? Object.entries(this.logic.remote?.apps || {})
        : [[this.logic.cur(), this.logic.remote?.app(this.logic.cur())]];
      const seen = new Set();
      for (const [key, app] of providers) {
        const owner = HyprlandApps.get(key)?.baseKey || key;
        for (const action of app?.actions || []) {
          const id = `app:${owner}:${signature(action)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          result.push({ ...action, id, owner });
        }
      }
      if (allProviders) {
        for (const spec of Object.values(HyprlandApps.catalog).filter(a => !a.baseKey)) {
          for (const action of spec.provider?.shortcutDefinitions || []) {
            const id = `app:${spec.key}:${signature(action)}`;
            if (seen.has(id)) continue;
            seen.add(id);
            result.push({ ...action, id, owner: spec.key });
          }
        }
      }
      return defaults ? result : HyprlandKeymap.resolve(result, this.logic.state.keyBindings);
    }
    publishActions() {
      const bridge = window.webkit?.messageHandlers?.shellKeyboard;
      if (!bridge?.postMessage) return;
      const actions = this.actions()
        .filter(a => a.code)
        .map(({ run, ...a }) =>
          this.keyRecorder ? { ...a, focusShell: true, editing: false } : a
        );
      const text = JSON.stringify(actions);
      if (text === this.registeredActions) return;
      this.registeredActions = text;
      bridge.postMessage({ commands: actions });
    }
    openPalette() {
      this.closeSheet();
      const sheet = node('div', 'desk-sheet desk-palette');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', 'Actions');
      const search = node('input', 'desk-action-search');
      search.type = 'search';
      search.autocapitalize = 'none';
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.setAttribute('autocorrect', 'off');
      search.placeholder = 'Search actions…';
      search.setAttribute('aria-label', 'Search actions');
      const done = node('button', 'desk-sheet-close', 'Done');
      done.onclick = () => this.closeSheet();
      const head = node('div', 'desk-sheet-head');
      head.append(search, done);
      const list = node('div', 'desk-action-results');
      const actions = this.actions().filter(
        (a, i, all) => a.code !== 'NumpadEnter' && all.findIndex(b => b.label === a.label) === i
      );
      if (this.logic.state.desk) {
        for (let ws = 1; ws <= Math.min(9, desks(this.logic.state).length); ws++)
          actions.push({
            label: `Move window to workspace ${ws + 1} without following`,
            group: 'Windows',
            run: () => this.moveWindow(ws, false),
          });
      }
      let selected = 0,
        shown = [];
      const render = () => {
        const query = search.value.trim().toLowerCase();
        shown = actions.filter(a => `${a.group} ${a.label}`.toLowerCase().includes(query));
        selected = Math.max(0, Math.min(selected, shown.length - 1));
        list.replaceChildren(
          ...shown.map((a, i) => {
            const row = node('button', 'desk-action-row');
            row.classList.toggle('selected', i === selected);
            row.append(node('span', '', a.label), node('kbd', '', a.code ? actionKeys(a) : ''));
            row.onclick = () => {
              this.closeSheet();
              a.run();
            };
            return row;
          })
        );
        if (!shown.length) list.append(node('p', 'widget-muted', 'No matching actions'));
      };
      search.oninput = () => {
        selected = 0;
        render();
      };
      search.onkeydown = e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          selected += e.key === 'ArrowDown' ? 1 : -1;
          render();
          list.children[selected]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && shown[selected]) {
          e.preventDefault();
          const a = shown[selected];
          this.closeSheet();
          a.run();
        }
      };
      sheet.append(head, list);
      this.returnFocus = document.activeElement;
      this.sheet = sheet;
      this.shell.append(sheet);
      render();
      this.logic.remote?.update?.();
      this.updateDividers();
      search.focus({ preventScroll: true });
    }
    canDrag() {
      const s = this.logic.state;
      return (
        s.desk &&
        !s.ov &&
        !s.launch &&
        !this.sheet &&
        ![...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"]')].some(
          el => el.getClientRects().length
        )
      );
    }
    point(e) {
      const r = this.shell.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    updateDividers() {
      if (!this.dividers) return;
      const s = this.logic.state;
      const splits =
        this.canDrag() && !s.scratchVisible
          ? layout(s, s.deskW, s.deskH).splits.filter(
              v =>
                v.desk === s.ws &&
                (!v.column || (v.position > CHROME.side && v.position < s.deskW - CHROME.side))
            )
          : [];
      this.dividers.replaceChildren(
        ...splits.map(split => {
          const el = node('div', 'desk-divider');
          el.dataset.deskSplit = split.id;
          el.dataset.axis = split.axis;
          el.setAttribute('role', 'separator');
          el.setAttribute('aria-label', 'Resize windows');
          el.setAttribute('aria-orientation', split.axis === 'x' ? 'vertical' : 'horizontal');
          el.tabIndex = 0;
          el.style.cssText =
            split.axis === 'x'
              ? `left:${split.position - 6}px;top:${split.rect.y + 20}px;width:12px;height:${Math.max(0, split.rect.h - 40)}px`
              : `left:${split.rect.x + 20}px;top:${split.position - 6}px;width:${Math.max(0, split.rect.w - 40)}px;height:12px`;
          el.onkeydown = e => {
            const direction =
              split.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
            if (!direction.includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
            e.preventDefault();
            e.stopPropagation();
            this.resizeSplit(split, split.position + (e.key === direction[0] ? -25 : 25));
            [...this.dividers.children].find(v => v.dataset.deskSplit === split.id)?.focus();
          };
          el.ondblclick = () =>
            this.resizeSplit(split, split.rect[split.axis] + split.length / 2 + CHROME.gap / 2);
          return el;
        })
      );
    }
    toggleSplit() {
      const s = this.logic.state;
      if (!s.desk || mode(s) !== 'dwindle') return;
      const split = layout(s, s.deskW, s.deskH)
        .splits.filter(v => v.desk === s.ws && v.apps.includes(cur(s)))
        .at(-1);
      if (!split) return;
      this.logic.set({ splitAxes: { ...s.splitAxes, [split.id]: split.axis === 'x' ? 'y' : 'x' } });
    }
    resizeSplit(split, position) {
      const s = this.logic.state;
      if (split.column) {
        const ratio = Math.max(
          0.25,
          Math.min(1, (position - split.rect.x - CHROME.gap / 2) / split.length)
        );
        this.logic.set({ columnWidths: { ...s.columnWidths, [split.id]: ratio } });
        return;
      }
      const ratio = boundedRatio(
        (position - split.rect[split.axis] - CHROME.gap / 2) / split.length,
        split.length
      );
      const entries = Object.entries(s.splits || {})
        .filter(([key]) => key !== split.id)
        .slice(-63);
      const splitAxes = { ...s.splitAxes };
      if (mode(s) === 'dwindle') {
        for (const item of layout(s, s.deskW, s.deskH).splits) splitAxes[item.id] = item.axis;
      }
      this.logic.set({ splits: { ...Object.fromEntries(entries), [split.id]: ratio }, splitAxes });
    }
    startDrag(e, splitID) {
      if (!this.canDrag() || this.drag) return false;
      const s = this.logic.state,
        point = this.point(e);
      const geometry = layout(s, s.deskW, s.deskH);
      const key = [...geometry.rects]
        .sort(([a, ar], [b, br]) => {
          const z = (k, r) =>
            r.scratch ? 30 : r.floating ? 10 + (s.floatOrder || []).indexOf(k) : 0;
          return z(b, br) - z(a, ar);
        })
        .find(
          ([, r]) =>
            r.desk === s.ws &&
            !r.hidden &&
            point.x >= r.x &&
            point.x <= r.x + r.w &&
            point.y >= r.y &&
            point.y <= r.y + r.h
        )?.[0];
      const floating = key === s.scratchKey || s.floating?.[key] ? geometry.rects.get(key) : null;
      if (floating) {
        this.drag = {
          ws: s.ws,
          key,
          start: point,
          pointerId: e.pointerId,
          moved: false,
          floating,
          resize: e.button === 2,
        };
        this.shell.classList.add('desk-dragging');
        this.logic.focusApp(key);
        return true;
      }
      const available = geometry.splits.filter(
        v =>
          v.desk === s.ws &&
          (!v.column || (v.position > CHROME.side && v.position < s.deskW - CHROME.side))
      );
      let split = available.find(v => v.id === splitID);
      const resizing = !!split || e.button === 2;
      if (resizing && !split)
        split = available
          .filter(v => v.apps.includes(key))
          .sort(
            (a, b) => Math.abs(point[a.axis] - a.position) - Math.abs(point[b.axis] - b.position)
          )[0];
      if (resizing ? !split : !key || key === 'home' || (s.full || []).includes(key)) return false;
      this.drag = {
        ws: s.ws,
        key: key || split.apps[0],
        split,
        start: point,
        pointerId: e.pointerId,
        moved: false,
      };
      this.shell.classList.add('desk-dragging');
      if (key) this.logic.focusApp(key);
      return true;
    }
    dragMove(e) {
      const drag = this.drag;
      if (!drag || (drag.pointerId != null && e.pointerId !== drag.pointerId)) return;
      const point = this.point(e);
      if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 4 && !drag.moved) return;
      drag.moved = true;
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      if (drag.floating) {
        const r = drag.floating,
          dx = point.x - drag.start.x,
          dy = point.y - drag.start.y;
        this.setFloatingRect(
          drag.key,
          drag.resize ? { ...r, w: r.w + dx, h: r.h + dy } : { ...r, x: r.x + dx, y: r.y + dy }
        );
      } else if (drag.split) {
        const split = drag.split;
        this.resizeSplit(split, split.position + point[split.axis] - drag.start[split.axis]);
      } else {
        const s = this.logic.state;
        drag.target = [...layout(s, s.deskW, s.deskH).rects].find(
          ([key, r]) =>
            key !== drag.key &&
            r.desk === s.ws &&
            !r.hidden &&
            point.x >= r.x &&
            point.x <= r.x + r.w &&
            point.y >= r.y &&
            point.y <= r.y + r.h
        )?.[0];
        this.shell
          .querySelectorAll('[data-workspace]')
          .forEach(el =>
            el.classList.toggle('desk-drop-target', el.dataset.workspace === drag.target)
          );
      }
    }
    dragEnd(e) {
      const drag = this.drag;
      if (!drag || (drag.pointerId != null && e.pointerId !== drag.pointerId)) return;
      if (drag.moved) {
        this.suppressClickUntil = performance.now() + 250;
        e.preventDefault?.();
        e.stopImmediatePropagation?.();
        if (!drag.split && !drag.floating && drag.target)
          this.patch(swap(this.logic.state, drag.key, drag.target));
      }
      this.cancelDrag();
    }
    cancelDrag() {
      const id = this.drag?.pointerId;
      this.drag = null;
      if (id != null && this.shell.hasPointerCapture?.(id)) this.shell.releasePointerCapture(id);
      this.shell.classList.remove('desk-dragging');
      this.shell
        .querySelectorAll('.desk-drop-target')
        .forEach(el => el.classList.remove('desk-drop-target'));
    }
    hoverFocus(key) {
      const s = this.logic.state;
      if (
        HyprlandUtil.storage.get('omarchy-focus-follows-pointer') !== 'true' ||
        !s.desk ||
        s.ov ||
        s.launch ||
        this.sheet ||
        !key ||
        !s.open.includes(key) ||
        key === this.logic.cur() ||
        deskOf(s, key) !== s.ws
      )
        return;
      if (
        [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"]')].some(
          el => el.getClientRects().length
        )
      )
        return;
      this.logic.focusApp(key);
    }
    isShellShortcut(e) {
      return this.actions().some(a => a.owner === 'shell' && HyprlandKeymap.matches(a, e));
    }
    keydown(e) {
      if (this.keyRecorder) {
        this.keyRecorder(e);
        return;
      }
      const s = this.logic.state,
        logic = this.logic;
      const match = this.actions().find(a => HyprlandKeymap.matches(a, e));
      const blocked = this.sheet || s.ov || s.launch;
      if (
        e.key === 'Escape' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (blocked || match?.owner === 'shell')
      ) {
        if (this.sheet) this.closeSheet();
        else if (editable(e.target)) return;
        else if (s.ov) logic.set({ ov: false });
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!match) {
        const app = logic.remote?.app(logic.cur());
        if (!blocked && !app?.actions?.length) app?.shortcut?.(e);
        return;
      }
      if (e.repeat || (match.owner !== 'shell' && blocked)) return;
      if (match.owner === 'shell' && editable(e.target)) {
        const apple = e.metaKey && !e.ctrlKey;
        if (
          apple
            ? (!e.shiftKey && !e.altKey && EDITING.has(e.code)) ||
              (e.shiftKey && !e.altKey && /^(Arrow|KeyZ$)/.test(e.code))
            : !e.metaKey && !/^(Arrow|Enter|Backspace|Escape)/.test(e.code)
        )
          return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.sheet && !match.keepSheet) this.closeSheet();
      match.run();
    }
    // Window operations only make sense on the desk; the phone keeps one app per workspace.
    patch(p) {
      if (p) this.logic.set(p);
    }
    groupWindow() {
      const s = this.logic.state,
        key = cur(s);
      if (!s.desk || key === 'home' || key === s.scratchKey) return;
      const apps = desks(s)[s.ws],
        members = groupMembers(s, key);
      const other = apps.find(k => !members.includes(k) && !s.floating?.[k]);
      if (!other) return;
      const group = s.groups?.[key] || crypto.randomUUID();
      if (s.floating?.[key] || s.floating?.[other]) return;
      const groups = { ...s.groups };
      for (const k of [...members, ...groupMembers(s, other)]) groups[k] = group;
      this.logic.set({
        groups,
        groupActive: { ...s.groupActive, [group]: key },
        full: (s.full || []).filter(k => !apps.includes(k)),
      });
    }
    ungroupWindow() {
      const s = this.logic.state,
        key = cur(s),
        groups = { ...s.groups };
      delete groups[key];
      this.logic.set({ groups });
    }
    setFloatingRect(key, rect) {
      const s = this.logic.state;
      const bounded = floatingRect(layout(s, s.deskW, s.deskH).area, rect);
      this.logic.set(
        key === s.scratchKey
          ? { scratchRect: bounded }
          : { floating: { ...s.floating, [key]: bounded } }
      );
    }
    resizeActive(direction) {
      const s = this.logic.state,
        key = cur(s);
      if (!s.desk || key === 'home' || (s.full || []).includes(key)) return;
      const geometry = layout(s, s.deskW, s.deskH),
        rect = geometry.rects.get(key);
      if (!rect || rect.hidden) return;
      const axis = ['left', 'right'].includes(direction) ? 'x' : 'y';
      const amount = ['left', 'up'].includes(direction) ? -25 : 25;
      if (rect.floating || rect.scratch) {
        this.setFloatingRect(key, {
          ...rect,
          [axis === 'x' ? 'w' : 'h']: rect[axis === 'x' ? 'w' : 'h'] + amount,
        });
        return;
      }
      const selected = groupMembers(s, key);
      const split = geometry.splits
        .filter(v => v.desk === s.ws && v.axis === axis && v.apps.some(k => selected.includes(k)))
        .sort((a, b) => a.apps.length - b.apps.length)[0];
      if (!split) return;
      const sign = split.column || selected.includes(split.apps[0]) ? 1 : -1;
      this.resizeSplit(split, split.position + sign * amount);
    }
    toggleFloating() {
      const s = this.logic.state,
        key = cur(s);
      if (!s.desk || key === 'home' || key === s.scratchKey) return;
      const floating = { ...s.floating },
        groups = { ...s.groups };
      if (floating[key]) delete floating[key];
      else {
        floating[key] = floatingRect(layout(s, s.deskW, s.deskH).area);
        delete groups[key];
      }
      this.logic.set({ floating, groups, full: (s.full || []).filter(k => k !== key) });
    }
    covered(key) {
      const s = this.logic.state;
      if (!s.desk || s.ov) return false;
      const rects = layout(s, s.deskW, s.deskH).rects;
      const r = rects.get(key);
      if (!r || r.hidden) return false;
      const z = k =>
        k === s.scratchKey ? 30 : s.floating?.[k] ? 10 + (s.floatOrder || []).indexOf(k) : 0;
      return [...rects].some(
        ([k, other]) =>
          k !== key &&
          !other.hidden &&
          other.desk === s.ws &&
          z(k) > z(key) &&
          r.x < other.x + other.w &&
          r.x + r.w > other.x &&
          r.y < other.y + other.h &&
          r.y + r.h > other.y
      );
    }
    newWindow(baseKey) {
      if (!this.logic.state.desk || this.logic.state.open.length >= 10) return;
      const app = HyprlandApps.createInstance(baseKey);
      if (app) this.logic.openApp(app.key);
    }
    toggleScratch() {
      const s = this.logic.state;
      if (!s.desk) return;
      if (!s.scratchKey || !s.open.includes(s.scratchKey)) {
        this.logic.expo?.error('Send a window to the scratchpad with Command+Shift+S first.');
        return;
      }
      this.logic.set({
        scratchVisible: !s.scratchVisible,
        focus: s.scratchVisible ? null : s.scratchKey,
        kb: false,
        ov: false,
      });
    }
    stashWindow() {
      const s = this.logic.state,
        key = cur(s);
      if (!s.desk || key === 'home') return;
      if (key === s.scratchKey) {
        const target = s.ws === 0 || desks(s)[s.ws].length >= MAX_TILES ? desks(s).length : s.ws;
        const ns = { ...s, scratchKey: null, tiles: { ...normalize(s), [key]: target } };
        this.logic.set({
          scratchKey: null,
          scratchVisible: false,
          tiles: normalize(ns),
          ws: deskOf(ns, key),
          focus: key,
        });
        return;
      }
      if (s.scratchKey) {
        this.logic.expo?.error('Return the existing scratchpad window before sending another.');
        return;
      }
      const others = desks(s)[s.ws].filter(k => k !== key);
      const ns = { ...s, scratchKey: key };
      this.logic.set({
        scratchKey: key,
        scratchVisible: false,
        full: (s.full || []).filter(k => k !== key),
        ws: Math.max(0, deskOf(ns, others[0] || 'home')),
        focus: others[0] || 'home',
      });
    }
    previousWorkspace() {
      const s = this.logic.state;
      if (s.previousWindow && s.open.includes(s.previousWindow)) this.logic.jump(s.previousWindow);
    }
    cycleLayout() {
      const modes = Object.keys(MODES),
        current = mode(this.logic.state);
      this.logic.set({ windowLayout: modes[(modes.indexOf(current) + 1) % modes.length] });
    }
    moveWindow(target, follow = true) {
      const s = this.logic.state;
      if (!s.desk) return;
      if (target < 1) return;
      this.patch(move(s, cur(s), target, follow));
    }
    focusDir(dir) {
      const s = this.logic.state;
      if (!s.desk) {
        if (dir === 'left') this.logic.go(s.ws - 1);
        else if (dir === 'right') this.logic.go(s.ws + 1);
        else if (dir === 'up') this.logic.set({ ov: true, kb: false });
        else this.logic.go(0);
        return;
      }
      const next = neighbor(s, s.deskW, s.deskH, cur(s), dir);
      if (next) this.logic.focusApp(next);
    }
    swapDir(dir) {
      const s = this.logic.state;
      if (!s.desk) return;
      this.patch(swap(s, cur(s), neighbor(s, s.deskW, s.deskH, cur(s), dir)));
    }
    cycle(step) {
      const s = this.logic.state;
      if (!s.desk) return;
      const apps = desks(s)[s.ws] || [];
      if (apps.length < 2) return;
      const i = apps.indexOf(cur(s));
      const next = apps[(i + step + apps.length) % apps.length];
      if (apps.some(k => (s.full || []).includes(k)))
        this.logic.set({ full: [...(s.full || []).filter(k => !apps.includes(k)), next] });
      this.logic.focusApp(next);
    }
    toggleFull() {
      const s = this.logic.state;
      if (!s.desk || s.ws === 0) return;
      const key = cur(s),
        full = (s.full || []).includes(key)
          ? (s.full || []).filter(k => k !== key)
          : [...(s.full || []).filter(k => deskOf(s, k) !== s.ws), key];
      this.logic.set({ full, focus: key });
    }
    toggleSheet() {
      if (this.sheet) this.closeSheet();
      else this.openSheet();
    }
    openSheet() {
      if (!this.shell) return;
      this.closeSheet();
      const sheet = node('div', 'desk-sheet');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', 'Keyboard shortcuts');
      const close = node('button', 'desk-sheet-close', 'Done');
      close.type = 'button';
      close.onclick = () => this.closeSheet();
      const head = node('div', 'desk-sheet-head');
      head.append(
        node('h2', '', 'Keyboard shortcuts'),
        node(
          'span',
          'widget-muted',
          APPLE
            ? `${MOD} is SUPER · ⇧ Shift · ⌥ Option`
            : 'Ctrl+Alt substitutes for plain Meta shortcuts. Meta combinations with Ctrl or Alt use the physical Meta key.'
        ),
        close
      );
      sheet.append(head);
      const grid = node('div', 'desk-sheet-grid');
      const all = this.actions().filter(a => a.code && a.code !== 'NumpadEnter');
      for (const group of [...new Set(all.map(a => a.group))]) {
        const section = node('section', 'desk-sheet-group');
        section.append(node('h3', '', group));
        for (const action of all.filter(a => a.group === group)) {
          const row = node('div', 'desk-sheet-row');
          row.append(node('kbd', '', actionKeys(action)), node('span', '', action.label));
          section.append(row);
        }
        grid.append(section);
      }
      sheet.append(
        grid,
        node(
          'p',
          'widget-muted desk-sheet-foot',
          `Drag a divider to resize. Hold ${APPLE ? 'Command' : 'Meta or Ctrl+Alt'} and left-drag to swap tiled windows, or right-drag to resize. 0 selects workspace 10. J needs two or more tiled windows in the same workspace. Use [ / ] to switch workspaces. Text editing keys stay with the focused field. ${APPLE ? '⌘Space and ⌘` are left to iPadOS. ' : ''}Esc or Done closes this list.`
        )
      );
      sheet.addEventListener('pointerdown', e => {
        if (e.target === sheet) this.closeSheet();
        e.stopPropagation();
      });
      this.returnFocus = document.activeElement;
      this.shell.append(sheet);
      this.sheet = sheet;
      this.logic.remote?.update?.();
      this.updateDividers();
      close.focus({ preventScroll: true });
    }
    closeSheet() {
      if (!this.sheet) return;
      this.keyRecorder = null;
      this.sheet.remove();
      this.sheet = null;
      this.publishActions();
      if (this.returnFocus?.matches('button')) this.returnFocus.focus({ preventScroll: true });
      this.returnFocus = null;
      this.logic.remote?.update?.();
      this.updateDividers();
    }
    dispose() {
      this.cancelDrag();
      clearTimeout(this.scrollEnd);
      this.columnScroll.remove();
      this.dividers.remove();
      this.closeSheet();
      this.abort.abort();
    }
  }
  let activeDesk;
  const nativeKey = ({
    code,
    shift = false,
    alt = false,
    ctrl = false,
    plain = false,
    meta = !ctrl && !plain,
  }) => {
    if (!activeDesk) return false;
    const event = {
      code,
      key: code === 'Slash' ? '/' : code === 'Escape' ? 'Escape' : code,
      shiftKey: shift,
      metaKey: meta,
      ctrlKey: ctrl,
      altKey: alt,
      repeat: false,
      target: document.activeElement,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {},
    };
    activeDesk.keydown(event);
    return event.defaultPrevented;
  };
  window.HyprlandDesk = {
    attach: logic => (activeDesk = new Desk(logic)),
    nativeKey,
    nativeBack: ({ keyboard = false } = {}) => {
      if (!activeDesk) return false;
      const { logic } = activeDesk;
      if (keyboard) {
        document.activeElement?.blur();
        logic.set({ kb: false });
        return true;
      }
      if (activeDesk.sheet) activeDesk.closeSheet();
      else if (logic.state.launch) logic.set({ launch: false, kb: false, query: '' });
      else if (logic.state.ov) logic.set({ ov: false });
      else if (logic.state.map) logic.set({ map: false });
      else return false;
      return true;
    },
    actionKeys,
    actions: () => activeDesk?.actions() || [],
    nativePointer: event => {
      if (!activeDesk) return;
      const e = { clientX: event.x, clientY: event.y, button: event.button };
      if (event.phase === 'begin') activeDesk.startDrag(e);
      else if (event.phase === 'move') activeDesk.dragMove(e);
      else if (event.phase === 'end') activeDesk.dragEnd(e);
      else activeDesk.cancelDrag();
    },
    MODES,
    isDesk,
    desks,
    visible: s =>
      [...layout(s, s.deskW, s.deskH).rects]
        .filter(([, r]) => r.desk === s.ws && !r.hidden)
        .map(([k]) => k),
    groupMembers,
    deskOf,
    cur,
    go,
    open,
    close,
    move,
    swap,
    layout,
    render,
    get BINDINGS() {
      return bindings();
    },
    MOD,
    CHROME,
  };
})();
