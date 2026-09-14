import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const window = { addEventListener() {} };
const ctx = { window, document: { createElement: () => ({}), querySelectorAll: () => [] } };
for (const f of ['util', 'remote'])
  vm.runInNewContext(readFileSync(new URL(`../public/${f}.js`, import.meta.url), 'utf8'), ctx);
const key = window.HyprlandRemote.keyInput;
test('terminal and Herdr receive equivalent character, control and navigation keys', () => {
  assert.equal(key('c', { ctrl: true }).data, '\x03');
  assert.equal(key('c', { ctrl: true }).keys[0], 'Ctrl+c');
  assert.equal(key('⏎').data, '\r');
  assert.equal(key('⏎').keys[0], 'Enter');
  assert.equal(key('⏎').text, '');
  assert.equal(key('⌫').data, '\x7f');
  assert.equal(key('←').data, '\x1b[D');
  assert.equal(key('esc').keys[0], 'Escape');
  assert.equal(key('h', { shift: true }).text, 'H');
  assert.equal(key('1', { shift: true }).text, '!');
  assert.equal(key('space').text, ' ');
  assert.equal(key('SUPER'), null);
});

test('Herdr orders workspaces and tabs by attention, work, done, idle then activity', () => {
  const panes = [
    {
      pane_id: 'idle',
      workspace_id: 'w1',
      tab_id: 't1',
      agent_status: 'idle',
      state_change_seq: 999,
    },
    {
      pane_id: 'done',
      workspace_id: 'w2',
      tab_id: 't2',
      agent_status: 'done',
      state_change_seq: 20,
    },
    {
      pane_id: 'working-old',
      workspace_id: 'w3',
      tab_id: 't3',
      agent_status: 'working',
      state_change_seq: 10,
    },
    {
      pane_id: 'blocked',
      workspace_id: 'w4',
      tab_id: 't4',
      agent_status: 'blocked',
      state_change_seq: 1,
    },
    {
      pane_id: 'working-new',
      workspace_id: 'w5',
      tab_id: 't5',
      agent_status: 'working',
      state_change_seq: 30,
    },
  ];
  const snapshot = {
    panes,
    workspaces: panes.map(p => ({ workspace_id: p.workspace_id, label: p.workspace_id })),
    tabs: panes.map(p => ({ tab_id: p.tab_id, label: p.tab_id })),
  };
  const before = JSON.stringify(snapshot);
  const ordered = window.HyprlandRemote.orderHerdr(snapshot);
  assert.equal(
    ordered.map(g => g.panes[0].pane_id).join(','),
    'blocked,working-new,working-old,done,idle'
  );
  assert.equal(JSON.stringify(snapshot), before);
  snapshot.panes = panes.map(p => ({ ...p, workspace_id: 'w1' }));
  assert.equal(
    window.HyprlandRemote.orderHerdr(snapshot)[0]
      .panes.map(p => p.pane_id)
      .join(','),
    'blocked,working-new,working-old,done,idle'
  );
});

test('Herdr uses visual tab order for activity ties, not per-pane revisions', () => {
  const snapshot = {
    workspaces: [{ workspace_id: 'w', label: 'work' }],
    tabs: [
      { tab_id: 't9', number: 9 },
      { tab_id: 't1', number: 1 },
    ],
    panes: [
      { pane_id: 'p1', workspace_id: 'w', tab_id: 't1', agent_status: 'idle', revision: 999 },
      { pane_id: 'p9', workspace_id: 'w', tab_id: 't9', agent_status: 'idle', revision: 1 },
    ],
  };
  assert.equal(
    window.HyprlandRemote.orderHerdr(snapshot)[0]
      .panes.map(p => p.pane_id)
      .join(','),
    'p9,p1'
  );
  snapshot.panes[0].state_change_seq = 5;
  assert.equal(
    window.HyprlandRemote.orderHerdr(snapshot)[0]
      .panes.map(p => p.pane_id)
      .join(','),
    'p1,p9'
  );
  snapshot.panes[1].agent_status = 'blocked';
  snapshot.panes[1].attention_kind = 'chat';
  assert.equal(
    window.HyprlandRemote.orderHerdr(snapshot)[0]
      .panes.map(p => p.pane_id)
      .join(','),
    'p1,p9'
  );
});
