import assert from 'node:assert/strict';
import test from 'node:test';
import { updatePresentation } from '../../src/Strife.Desktop/wwwroot/updates.js';

test('only a verified ready update is actionable; downloads stay unobtrusive', () => {
  const ready = updatePresentation({ available: true, value: { state: 'ready', version: '0.1.0-preview.8' } });
  assert.equal(ready.label, 'Update');
  assert.equal(ready.hidden, false);
  assert.equal(ready.disabled, false);
  assert.match(ready.title, /restart now.*when you quit/);
  const downloading = updatePresentation({ available: true, value: { state: 'downloading', progress: 47 } });
  assert.equal(downloading.label, 'Update 47%');
  assert.equal(downloading.disabled, true);
});

test('unsupported installs and background errors never display a nag button', () => {
  for (const state of ['idle', 'current', 'checking', 'error', 'manual']) {
    assert.equal(updatePresentation({ available: true, value: { state } }).hidden, true);
  }
  assert.equal(updatePresentation({ available: false, value: { state: 'ready' } }).hidden, true);
  assert.equal(updatePresentation(null).hidden, true);
});
