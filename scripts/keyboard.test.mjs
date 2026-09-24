import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const apps = readFileSync(new URL('../public/apps.js', import.meta.url), 'utf8');
function terminal() {
  const window = { innerWidth: 402, innerHeight: 874 };
  const ctx = vm.createContext({
    window,
    DCLogic: class {
      setState(p) {
        Object.assign(this.state, p);
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(apps, ctx);
  const c = vm.runInContext(source + ';new Component()', ctx);
  c.openApp('terminal');
  c.set({ kb: true });
  return c;
}
test('bottom swipes favor expo while either corner opens native input', () => {
  for (const width of [375, 402, 440]) {
    for (const fraction of [0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.85]) {
      const c = terminal();
      c.set({ kb: false });
      c.ptr = { x: width * fraction, y: 870, cx: width * fraction, cy: 870, w: width, h: 874 };
      c.up({ clientX: width * 0.5, clientY: 700 });
      assert.equal(c.state.ov, true, 'expo at ' + fraction);
      assert.equal(c.state.kb, false);
    }
    for (const fraction of [0.1, 0.9]) {
      const c = terminal();
      c.set({ kb: false });
      c.ptr = { x: width * fraction, y: 870, cx: width * fraction, cy: 870, w: width, h: 874 };
      c.up({ clientX: width * fraction, clientY: 700 });
      assert.equal(c.state.kb, true);
      assert.equal(c.state.ov, false);
    }
  }
});

test('workspace limit preserves existing navigation and permits opening after close', async () => {
  const c = terminal();
  for (const key of Object.keys(c.APPS)) c.openApp(key);
  assert.equal(c.state.open.length, 10);
  c.APPS.extra = { name: 'extra', description: '' };
  c.openApp('extra');
  assert.equal(c.state.open.length, 10);
  assert.ok(!c.state.open.includes('extra'));
  c.openApp('files');
  assert.equal(c.cur(), 'files');
  await c.closeApp('files');
  c.openApp('extra');
  assert.equal(c.state.open.length, 10);
  assert.equal(c.cur(), 'extra');
});

test('bottom corners do not request a shell keyboard for a non-input app', () => {
  const c = terminal();
  c.openApp('files');
  for (const x of [20, 380]) {
    c.ptr = { x, y: 870, cx: x, cy: 870, w: 402, h: 874 };
    c.up({ clientX: x, clientY: 700 });
    assert.equal(c.state.kb, false);
    assert.equal(c.state.ov, false);
  }
});
