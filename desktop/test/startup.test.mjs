import assert from 'node:assert/strict';
import test from 'node:test';
import { windowRequests } from '../src/startup.js';

test('launcher requests during startup open once the desktop client is ready', () => {
  const requests = windowRequests();
  const opened = [];
  requests.request('settings');
  requests.request('canvas');
  requests.request('settings');
  requests.request('chat');
  assert.deepEqual(opened, []);
  requests.ready(key => opened.push(key));
  assert.deepEqual(opened, ['settings', 'canvas', 'chat']);
  requests.request('corral');
  assert.deepEqual(opened, ['settings', 'canvas', 'chat', 'corral']);
});

test('the full-shell launch is retained alongside app requests during startup', () => {
  const requests = windowRequests();
  requests.request('');
  requests.request('herdr');
  const opened = [];
  requests.ready(key => opened.push(key));
  assert.deepEqual(opened, ['', 'herdr']);
});
