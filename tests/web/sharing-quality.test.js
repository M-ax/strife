import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {qualityOptions, selectedQuality, customQuality, validateAudioBitrate} from '../../src/Strife.Desktop/wwwroot/sharing-quality.js';

const raw = JSON.parse(readFileSync(new URL('../../src/Strife.Desktop/streaming-quality.json', import.meta.url)));
const catalog = {...raw, presets: raw.presets.map(p => ({
  ...p, label: `${p.resolution}${p.fps} ${p.bitrateKbps / 1000} Mbps`,
}))};

test('custom quality validates the same resolution, rate, and server limits', () => {
  const value = {width:1920,height:1080,fps:15,bitrateKbps:2300};
  assert.equal(customQuality(catalog, value).label, '1080p15 2.3 Mbps');
  for (const invalid of [{...value,fps:0}, {...value,fps:120}, {...value,width:1919},
    {...value,bitrateKbps:499}, {...value,bitrateKbps:2301}, {...value,bitrateKbps:40001},
    {...value,bitrateKbps:NaN}, {...value,bitrateKbps:'2300'}, {...value,width:3840,height:2160}])
    assert.throws(() => customQuality(catalog, invalid));
  for (const rate of [64,96,128,160,192]) assert.equal(validateAudioBitrate(rate), rate);
  for (const rate of [0,63,65,193,'128',NaN]) assert.throws(() => validateAudioBitrate(rate));
  assert.throws(() => validateAudioBitrate(192, {audioBitrateKbps:128}));
});

test('quality picker defaults to 1080p60 8 Mbps and gates high presets on older servers', () => {
  const options = qualityOptions(catalog);
  assert.equal(options.filter(p => p.selected).length, 1);
  assert.equal(options.find(p => p.selected).label, '1080p60 8 Mbps');
  assert.equal(options.filter(p => !p.disabled).length, 5);
  assert.deepEqual(options.filter(p => p.disabled).map(p => p.id), ['1440p30', '1440p60', '4K30', '4K60']);
  for (const preset of options) assert.match(preset.label, /^(?:\d+p|4K)\d+ \d+(?:\.\d+)? Mbps$/);
});

test('quality selection rejects forged, disabled, and missing values', () => {
  assert.equal(selectedQuality(catalog, '720p30').label, '720p30 3 Mbps');
  for (const id of ['4K60', 'unknown', '', undefined, null]) {
    assert.throws(() => selectedQuality(catalog, id), /available streaming quality/);
  }
});

test('incompatible helper catalog is not silently treated as a default', () => {
  for (const value of [null, {}, {...catalog, version: 2}, {...catalog, defaultPreset: 'unknown'}]) {
    assert.throws(() => qualityOptions(value), /Rebuild native sharing/);
  }
});

test('high presets require a complete numeric server capability contract', () => {
  const publishing = {version: 1, width: 3840, height: 2160, fps: 60, bitrateKbps: 40000,
    codec: 'h264', profile: 'baseline', level: '5.2'};
  assert.equal(qualityOptions(catalog, publishing).filter(p => p.disabled).length, 0);
  assert.equal(selectedQuality(catalog, '4K60', publishing).label, '4K60 40 Mbps');
  for (const value of [{}, {...publishing, version: 2}, {...publishing, width: '3840'},
    {...publishing, bitrateKbps: 39999}, {...publishing, codec: 'av1'}, {...publishing, level: '4.2'}]) {
    assert.throws(() => selectedQuality(catalog, '4K60', value));
  }
});
