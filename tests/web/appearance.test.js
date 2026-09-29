import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceDefaults, normalizeAppearance } from '../../src/Strife.Desktop/wwwroot/appearance.js';
import { parseColor, hsvToHex, hexToHsv } from '../../src/Strife.Desktop/wwwroot/color-picker.js';
import { fontCss, createFontCatalog } from '../../src/Strife.Desktop/wwwroot/font-picker.js';

test('old or malformed appearance preferences fall back per field', () => {
  for (const value of [null, undefined, [], 'invalid']) assert.deepEqual(normalizeAppearance(value), appearanceDefaults);
  assert.deepEqual(normalizeAppearance({ accentColor: '#AABBCC', timestampColor: 'red; background:url(x)',
    usernameColor: null, linkColor: '#123', uiFont: '__proto__', chatFont: 'mono' }),
  { ...appearanceDefaults, accentColor: '#aabbcc', chatFont: 'mono' });
});

test('hex input supports trimmed, bare and short codes; HSV round trips saturated and grayscale colors', () => {
  for (const [input, expected] of [[' abc ', '#aabbcc'], ['#AbC', '#aabbcc'], ['A1b2c3', '#a1b2c3'], ['#000', '#000000']])
    assert.equal(parseColor(input), expected);
  for (const value of ['', '#12', 'abcd', '#12345678', 'red; color: blue', 'url(x)', 'currentColor', 'transparent'])
    assert.equal(parseColor(value), null);
  for (const hex of ['#ffffff', '#000000', '#808080', '#ff0000', '#00ff00', '#0000ff', '#ac98f3', '#f4a460'])
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
  assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), '#ff0000');
});

test('installed font families persist and are escaped as a single CSS family', () => {
  const value = 'local:Font "Quoted" \\ Unicode 雪';
  assert.equal(normalizeAppearance({ chatFont: value }).chatFont, value);
  assert.equal(fontCss(value), '"Font \\"Quoted\\" \\\\ Unicode 雪", system-ui, sans-serif');
  for (const value of ['local:', 'local: ', 'local:a\nother', 'local:' + 'a'.repeat(257)])
    assert.equal(normalizeAppearance({ chatFont: value }).chatFont, 'system');
});

test('the font cache loads once, deduplicates families and preserves batch arrival order', async () => {
  let calls = 0, release;
  const pause = new Promise(resolve => { release = resolve; });
  const catalog = createFontCatalog(async offset => {
    calls++;
    if (offset === 0) return { families: ['Zulu', 'Alpha', 'zulu'], next: 3, complete: false };
    await pause;
    return { families: ['Beta'], next: 4, complete: true };
  });
  let first;
  const firstBatch = new Promise(resolve => { first = resolve; });
  catalog.subscribe(() => { if (catalog.fonts.some(font => font.name === 'Alpha')) first(); });
  const loading = catalog.start(); await firstBatch;
  assert.equal(catalog.loading, true);
  assert.deepEqual(catalog.fonts.slice(7).map(font => font.name), ['Zulu', 'Alpha']);
  await catalog.start(); release(); await loading; await catalog.start();
  assert.equal(calls, 2);
  assert.equal(catalog.loading, false);
  assert.deepEqual(catalog.fonts.slice(7).map(font => font.name), ['Zulu', 'Alpha', 'Beta']);
});

test('font discovery failure stops the loading indicator and keeps usable cached entries', async () => {
  const catalog = createFontCatalog(async () => { throw new Error('Discovery unavailable'); });
  await catalog.start();
  assert.equal(catalog.loading, false);
  assert.equal(catalog.error, 'Discovery unavailable');
  assert.equal(catalog.fonts.length, 7);
});
