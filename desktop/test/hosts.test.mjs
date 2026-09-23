import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, clean, normalize, seed } from '../src/hosts.js';
import { match, register } from '../src/keys.js';

test('host addresses canonicalize to the /native/ shell over HTTPS or loopback HTTP', () => {
  assert.equal(normalize('machine.tailnet.ts.net'), 'https://machine.tailnet.ts.net/native/');
  assert.equal(normalize('https://machine.example/native'), 'https://machine.example/native/');
  assert.equal(normalize('http://127.0.0.1:4187/'), 'http://127.0.0.1:4187/native/');
  for (const bad of [
    'http://machine.example',
    'https://user:pass@machine.example',
    'https://machine.example/other',
    'https://machine.example/?q=1',
    'file:///etc/passwd',
    '',
  ])
    assert.throws(() => normalize(bad), bad);
});

test('picker actions save, connect, disconnect and remove hosts', () => {
  let { directory, navigate } = apply(clean({}), 'save', { url: 'a.example', name: ' A ' });
  assert.equal(navigate, false);
  assert.deepEqual(directory.hosts, [
    { id: 'https://a.example/native/', url: 'https://a.example/native/', name: 'A' },
  ]);
  ({ directory, navigate } = apply(directory, 'connect', { id: 'https://a.example/native/' }));
  assert.equal(navigate, true);
  assert.equal(directory.selected, 'https://a.example/native/');
  assert.equal(directory.disconnected, false);
  ({ directory } = apply(directory, 'disconnect'));
  assert.equal(directory.disconnected, true);
  ({ directory } = apply(directory, 'remove', { id: 'https://a.example/native/' }));
  assert.deepEqual(directory, { hosts: [], selected: null, disconnected: true });
  assert.throws(() => apply(directory, 'connect', { id: 'https://missing.example/native/' }));
  assert.throws(() => apply(directory, 'launch'));
  let full = clean({});
  for (let i = 0; i < 10; i++) full = apply(full, 'save', { url: `h${i}.example` }).directory;
  assert.throws(() => apply(full, 'save', { url: 'h10.example' }), /up to 10/);
});

test('a configured address seeds and selects a host once', () => {
  const directory = seed(clean({}), 'http://localhost:4187');
  assert.equal(directory.selected, 'http://localhost:4187/native/');
  assert.equal(seed(directory, 'http://localhost:4187').hosts.length, 1);
  const chosen = seed(apply(directory, 'save', { url: 'b.example' }).directory, 'c.example');
  assert.equal(chosen.selected, 'http://localhost:4187/native/');
});

test('website keys match the shell registry, including the Ctrl+Alt spelling of Super', () => {
  const commands = register([
    { code: 'Digit2', meta: true, ctrl: false, alt: false, shift: false, label: 'Workspace 2' },
    { code: 'ArrowLeft', meta: true, ctrl: false, alt: false, shift: false, editing: true },
    { code: 'KeyF', meta: false, ctrl: true, alt: false, shift: false, label: 'Find' },
  ]);
  const key = (code, mods = {}) => ({
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  });
  assert.equal(match(commands, key('Digit2', { meta: true }))?.label, 'Workspace 2');
  assert.equal(match(commands, key('Digit2', { control: true, alt: true }))?.label, 'Workspace 2');
  assert.equal(match(commands, key('Digit2', { control: true })), null);
  assert.equal(match(commands, key('Digit2', { meta: true, shift: true })), null);
  assert.equal(match(commands, key('KeyF', { control: true }))?.label, 'Find');
  // Editing keys stay with a focused website.
  assert.equal(match(commands, key('ArrowLeft', { meta: true }), true), null);
  assert.equal(register([{ code: 'x'.repeat(40) }]), null);
  assert.equal(register(new Array(257).fill({ code: 'KeyA' })), null);
});
