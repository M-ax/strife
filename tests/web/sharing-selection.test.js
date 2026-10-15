import test from 'node:test';
import assert from 'node:assert/strict';
import {filterSources, resolveAudio} from '../../src/Strife.Desktop/wwwroot/sharing-selection.js';

const sources = [
  {id:'screen', kind:'screen', name:'Display 1', automaticAudioId:'system'},
  {id:'window', kind:'window', name:'Browser window', automaticAudioId:'app'},
  {id:'unknown', kind:'window', name:'Unidentified app', automaticAudioId:''},
];
const targets = [{id:'system', name:'Speakers', kind:'system'}, {id:'app', name:'Browser', kind:'application'}];
test('screen/window filtering preserves IDs and searches names', () => {
  assert.deepEqual(filterSources(sources, 'window', 'BROWSER').map(s => s.id), ['window']);
  assert.deepEqual(filterSources(sources, 'screen').map(s => s.id), ['screen']);
  assert.equal(filterSources(sources, 'window', 'missing').length, 0);
});
test('automatic maps screens to system and windows to their application', () => {
  assert.equal(resolveAudio(sources, targets, 'screen', true, 'automatic', '').id, 'system');
  assert.equal(resolveAudio(sources, targets, 'window', true, 'automatic', '').id, 'app');
  assert.equal(resolveAudio(sources, targets, 'window', false, 'automatic', '').id, '');
});
test('manual target is independent; unavailable automatic never falls back to system', () => {
  assert.equal(resolveAudio(sources, targets, 'screen', true, 'manual', 'app').id, 'app');
  assert.equal(resolveAudio(sources, targets, 'window', true, 'manual', 'system').id, 'system');
  assert.throws(() => resolveAudio(sources, targets, 'unknown', true, 'automatic', 'system'), /unavailable/);
  assert.throws(() => resolveAudio(sources, [], 'screen', true, 'automatic', ''), /unavailable/);
  assert.throws(() => resolveAudio(sources, targets, 'window', true, 'manual', 'stale'), /Choose an audio/);
  assert.throws(() => resolveAudio(sources, targets, 'missing', true, 'manual', 'app'), /Choose a screen/);
});
