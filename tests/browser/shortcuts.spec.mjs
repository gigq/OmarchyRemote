import { test, expect } from './fixtures.mjs';
// Exercise browser key delivery and real Desk operations, with host actions isolated.
// These do not simulate iPadOS hardware-key interception.
test.use({ viewport: { width: 1194, height: 834 }, isMobile: false, hasTouch: false });
test.beforeEach(async ({ page: p }) => {
  await p.goto('/util.js');
  await p.setContent(
    '<div id="phone-viewport" style="width:1194px;height:834px"><div id="touch-shell"><textarea aria-label="Draft"></textarea></div></div>'
  );
  await p.addScriptTag({ url: '/util.js' });
  await p.addScriptTag({ url: '/apps.js' }); // app bindings come from the catalog
  await p.addScriptTag({ url: '/desk.js' });
  await p.evaluate(() => {
    const D = HyprlandDesk;
    window.reset = (tiled = false) => {
      window.desk?.dispose();
      const open = [
        'home',
        'terminal',
        'browser',
        'files',
        'herdr',
        'settings',
        'lazydocker',
        'dua',
        'lnav',
        'btop',
      ];
      window.logic = {
        state: {
          desk: true,
          deskW: 1194,
          deskH: 834,
          open,
          tiles: Object.fromEntries(open.slice(1).map((k, i) => [k, tiled && i < 3 ? 1 : i + 1])),
          ws: 1,
          focus: 'terminal',
          full: [],
          ov: false,
          launch: false,
        },
        calls: [],
        set(patch) {
          Object.assign(this.state, patch);
        },
        cur() {
          return D.cur(this.state);
        },
        go(i) {
          this.set(D.go(this.state, i));
        },
        focusApp(key) {
          this.set({ focus: key });
        },
        openApp(key) {
          this.calls.push(['open', key]);
          this.set(D.open(this.state, key));
        },
        closeWs() {
          const key = this.cur();
          this.calls.push(['close', key]);
          if (key !== 'home') this.set(D.close(this.state, key));
        },
        openLauncher() {
          this.set({ launch: true });
        },
      };
      window.desk = D.attach(logic);
    };
    reset();
  });
});
const state = p => p.evaluate(() => logic.state);
for (const mod of ['Meta', 'Control+Alt']) {
  test(`${mod}: workspace numbers, neighbors and Expo`, async ({ page: p }) => {
    for (const [key, index] of [
      ...Array.from({ length: 9 }, (_, i) => [String(i + 1), i]),
      ['0', 9],
    ]) {
      await p.keyboard.press(`${mod}+${key}`);
      expect((await state(p)).ws).toBe(index);
    }
    await p.keyboard.press(`${mod}+BracketLeft`);
    expect((await state(p)).ws).toBe(8);
    await p.keyboard.press(`${mod}+BracketRight`);
    expect((await state(p)).ws).toBe(9);
    await p.keyboard.press(`${mod}+KeyE`);
    expect((await state(p)).ov).toBe(true);
    await p.keyboard.press('Escape');
    expect((await state(p)).ov).toBe(false);
  });
  test(`${mod}: every app binding, launcher and help`, async ({ page: p }) => {
    await p.evaluate(() => logic.go(0)); // T launches Terminal from Home; in Terminal it adds a tab.
    for (const [key, app] of [
      ['KeyT', 'terminal'],
      ['Enter', 'terminal'],
      ['NumpadEnter', 'terminal'],
      ['Shift+Enter', 'browser'],
      ['Shift+NumpadEnter', 'browser'],
      ['Shift+KeyB', 'browser'],
      ['Shift+KeyF', 'files'],
      ['Shift+KeyA', 'herdr'],
      ['Shift+KeyD', 'lazydocker'],
      ['Comma', 'settings'],
    ]) {
      await p.keyboard.press(`${mod}+${key}`);
      expect(await p.evaluate(() => logic.calls.at(-1))).toEqual(['open', app]);
    }
    await p.keyboard.press(`${mod}+KeyK`);
    expect((await state(p)).launch).toBe(true);
    await p.keyboard.press(`${mod}+KeyK`);
    expect((await state(p)).launch).toBe(false);
    await p.keyboard.press(`${mod}+Slash`);
    await expect(p.getByRole('dialog')).toBeVisible();
    await p.keyboard.press(`${mod}+Slash`);
    await expect(p.getByRole('dialog')).toHaveCount(0);
  });
  test(`${mod}: cycle, fullscreen and close`, async ({ page: p }) => {
    await p.evaluate(() => reset(true));
    await p.keyboard.press(`${mod}+KeyJ`);
    expect((await state(p)).focus).toBe('browser');
    await p.keyboard.press(`${mod}+Shift+KeyJ`);
    expect((await state(p)).focus).toBe('terminal');
    await p.keyboard.press(`${mod}+KeyF`);
    expect((await state(p)).full).toEqual(['terminal']);
    await p.keyboard.press(`${mod}+KeyJ`);
    expect((await state(p)).full).toEqual(['browser']);
    expect((await state(p)).focus).toBe('browser');
    await p.keyboard.press(`${mod}+KeyF`);
    expect((await state(p)).full).toEqual([]);
    for (const key of ['KeyW', 'Backspace']) {
      const before = (await state(p)).open.length;
      await p.keyboard.press(`${mod}+${key}`);
      expect((await state(p)).open).toHaveLength(before - 1);
      expect(await p.evaluate(() => logic.calls.at(-1)[0])).toBe('close');
    }
  });
  test(`${mod}: directional focus and swap`, async ({ page: p }) => {
    for (const [direction, start, next] of [
      ['ArrowRight', 'terminal', 'browser'],
      ['ArrowLeft', 'browser', 'terminal'],
      ['ArrowDown', 'browser', 'files'],
      ['ArrowUp', 'files', 'browser'],
    ]) {
      await p.evaluate(start => {
        reset(true);
        logic.state.focus = start;
      }, start);
      await p.keyboard.press(`${mod}+${direction}`);
      expect((await state(p)).focus).toBe(next);
      await p.evaluate(start => {
        reset(true);
        logic.state.focus = start;
      }, start);
      const before = (await state(p)).open;
      await p.keyboard.press(`${mod}+Shift+${direction}`);
      const after = await state(p);
      expect(after.focus).toBe(start);
      expect(after.open.indexOf(start)).toBe(before.indexOf(next));
    }
  });
  test(`${mod}: moving windows with every number and brackets`, async ({ page: p }) => {
    for (const key of [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '0',
      'BracketLeft',
      'BracketRight',
    ]) {
      await p.evaluate(() => reset());
      await p.keyboard.press(`${mod}+Shift+${key}`);
      const apps = await p.evaluate(() => HyprlandDesk.desks(logic.state));
      if (['1', '2', 'BracketLeft'].includes(key))
        expect(apps[1]).toEqual(['terminal']); // Home is protected; own workspace is unchanged.
      else {
        const target = key === 'BracketRight' ? 3 : Number(key) || 10;
        expect(
          apps.some(
            row =>
              row.includes('terminal') &&
              row.includes(
                [
                  'home',
                  'terminal',
                  'browser',
                  'files',
                  'herdr',
                  'settings',
                  'lazydocker',
                  'dua',
                  'lnav',
                  'btop',
                ][target - 1]
              )
          )
        ).toBe(true);
      }
    }
  });
}
test('reserved chords stay unhandled; field editing wins over window shortcuts', async ({
  page: p,
}) => {
  expect(
    await p.evaluate(() =>
      ['Space', 'Backquote'].map(code => {
        const e = new KeyboardEvent('keydown', {
          code,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(e);
        return e.defaultPrevented;
      })
    )
  ).toEqual([false, false]);
  await p.getByRole('textbox').focus();
  for (const code of [
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
  ]) {
    expect(
      await p.evaluate(code => {
        const e = new KeyboardEvent('keydown', {
          code,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.activeElement.dispatchEvent(e);
        return e.defaultPrevented;
      }, code)
    ).toBe(false);
  }
  await p.evaluate(() => reset(true));
  await p.getByRole('textbox').focus();
  await p.keyboard.press('Meta+KeyJ');
  expect((await state(p)).focus).toBe('browser');
  await p.keyboard.press('Meta+KeyK');
  expect((await state(p)).launch).toBe(true);
});

test('native command bridge uses the same actions and preserves editing keys', async ({
  page: p,
}) => {
  await p.evaluate(() => reset(true));
  expect(await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'KeyJ' }))).toBe(true);
  expect((await state(p)).focus).toBe('browser');
  await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'KeyJ', shift: true }));
  expect((await state(p)).focus).toBe('terminal');
  await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'KeyW' }));
  expect((await state(p)).open).not.toContain('terminal');
  await p.getByRole('textbox').focus();
  expect(await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'Backspace' }))).toBe(false);
  expect(await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'Space' }))).toBe(false);
});

test('native list restores Return and omits the browser-only Delete alias', async ({ page: p }) => {
  await p.evaluate(() => {
    desk.dispose();
    window.webkit = { messageHandlers: { shellKeyboard: {} } };
  });
  await p.addScriptTag({ url: '/desk.js' });
  await p.evaluate(() => {
    window.desk = HyprlandDesk.attach(logic);
  });
  expect(await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'Digit3', shift: true }))).toBe(
    false
  );
  expect(await p.evaluate(() => HyprlandDesk.nativeKey({ code: 'Digit3', alt: true }))).toBe(true);
  expect(
    await p.evaluate(() =>
      HyprlandDesk.desks(logic.state).some(
        row => row.includes('terminal') && row.includes('browser')
      )
    )
  ).toBe(true);
  for (const code of ['Backspace'])
    expect(await p.evaluate(code => HyprlandDesk.nativeKey({ code }), code)).toBe(false);
  await p.keyboard.press('Meta+Enter');
  expect(await p.evaluate(() => logic.calls.at(-1))).toEqual(['open', 'terminal']);
  await p.keyboard.press('Meta+KeyT');
  expect(await p.evaluate(() => logic.calls.at(-1))).toEqual(['open', 'terminal']);
  await p.keyboard.press('Meta+Slash');
  await expect(p.locator('.desk-sheet')).toContainText('↩');
  await expect(p.locator('.desk-sheet')).not.toContainText('⌫');
});

test('Return focuses Terminal while T explicitly adds a terminal tab', async ({ page: p }) => {
  await p.evaluate(() => {
    logic.remote = { app: () => ({ reopen: () => logic.calls.push(['new-tab']) }) };
  });
  await p.keyboard.press('Meta+Enter');
  await p.keyboard.press('Meta+NumpadEnter');
  await expect
    .poll(() => p.evaluate(() => logic.calls))
    .toEqual([
      ['open', 'terminal'],
      ['open', 'terminal'],
    ]);
  await p.keyboard.press('Meta+t');
  await expect.poll(() => p.evaluate(() => logic.calls.at(-1))).toEqual(['new-tab']);
});

test('app handlers cannot consume reserved shell shortcuts', async ({ page: p }) => {
  const results = await p.evaluate(() => {
    const codes = [
      'KeyT',
      'KeyF',
      'KeyW',
      'KeyJ',
      'KeyE',
      'KeyK',
      'KeyB',
      'KeyA',
      'KeyD',
      'Comma',
      'Slash',
      'Enter',
      'NumpadEnter',
      'BracketLeft',
      'BracketRight',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      ...Array.from({ length: 10 }, (_, n) => `Digit${n}`),
    ];
    const failures = [];
    for (const binding of HyprlandDesk.BINDINGS) {
      for (const code of codes.filter(code => binding.code.test(code))) {
        reset();
        let intercepted = false;
        logic.remote = {
          app: () => ({
            shortcut: () => {
              intercepted = true;
              return true;
            },
          }),
        };
        HyprlandDesk.nativeKey({ code, shift: !!binding.shift, alt: !!binding.alt });
        if (intercepted) failures.push(code);
      }
    }
    return failures;
  });
  expect(results).toEqual([]);
});

test('pointer focus is opt-in, desk-only and ignores dragging, touch and overlays', async ({
  page: p,
}) => {
  await p.evaluate(() => {
    reset(true);
    const shell = document.querySelector('#touch-shell');
    for (const key of ['terminal', 'browser', 'files']) {
      const tile = document.createElement('div');
      tile.dataset.workspace = key;
      shell.append(tile);
    }
    window.hover = (key, options = {}) => {
      document.querySelector(`[data-workspace="${key}"]`).dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: Math.random() * 1000,
          ...options,
        })
      );
    };
    HyprlandUtil.storage.set('omarchy-focus-follows-pointer', null);
    hover('browser');
  });
  expect((await state(p)).focus).toBe('terminal');
  await p.evaluate(() => {
    HyprlandUtil.storage.set('omarchy-focus-follows-pointer', 'true');
    hover('browser');
  });
  expect((await state(p)).focus).toBe('browser');
  for (const options of [{ buttons: 1 }, { pointerType: 'touch' }, { pointerType: 'pen' }]) {
    await p.evaluate(options => hover('files', options), options);
    expect((await state(p)).focus).toBe('browser');
  }
  for (const flag of ['ov', 'launch', 'shade']) {
    await p.evaluate(flag => {
      logic.state[flag] = true;
      hover('files');
    }, flag);
    expect((await state(p)).focus).toBe('browser');
    await p.evaluate(flag => {
      logic.state[flag] = false;
    }, flag);
  }
  await p.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.textContent = 'Dialog';
    document.body.append(dialog);
    hover('files');
  });
  expect((await state(p)).focus).toBe('browser');
  await p.evaluate(() => {
    document.querySelector('[role="dialog"]').remove();
    logic.state.desk = false;
    hover('files');
  });
  expect((await state(p)).focus).toBe('browser');
  await p.evaluate(() => {
    logic.state.desk = true;
    hover('files');
  });
  expect((await state(p)).focus).toBe('files');
  await p.evaluate(() => {
    HyprlandUtil.storage.set('omarchy-focus-follows-pointer', 'false');
    hover('terminal');
  });
  expect((await state(p)).focus).toBe('files');
});
