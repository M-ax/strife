import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_IDS, defaultLayout, restoreLayout, dockPanel, floatPanel, measureLayout, floatingRect } from '../../src/Strife.Desktop/wwwroot/layout-model.js';

test('chat and user controls can dock on every side of rooms without losing panels', () => {
  for (const id of ['chat', 'controls', 'video']) for (const side of ['top', 'bottom', 'left', 'right']) {
    const initial = defaultLayout(), next = dockPanel(initial, id, 'rooms', side);
    assert.deepEqual(restoreLayout(next), next);
    assert.deepEqual(initial, defaultLayout(), 'layout operations leave the previous layout intact');
    const rects = measureLayout(next, 1480, 837).panels, room = rects.get('rooms'), panel = rects.get(id);
    if (side === 'top') assert.ok(panel.y + panel.height < room.y);
    if (side === 'bottom') assert.ok(panel.y > room.y + room.height);
    if (side === 'left') assert.ok(panel.x + panel.width < room.x);
    if (side === 'right') assert.ok(panel.x > room.x + room.width);
  }
});

test('every panel can float and return to an empty workspace', () => {
  let layout = defaultLayout();
  for (const id of PANEL_IDS) layout = floatPanel(layout, id, { x: 200, y: 100, width: 320, height: 400 });
  assert.equal(layout.root, null);
  assert.deepEqual(restoreLayout(layout), layout);
  for (const [index, id] of PANEL_IDS.entries()) {
    layout = dockPanel(layout, id, null, ['top', 'bottom', 'left', 'right'][index]);
    assert.deepEqual(restoreLayout(layout), layout);
  }
  assert.equal(layout.floating.length, 0);
  assert.equal(measureLayout(layout, 900, 557).panels.size, 4);
});

test('invalid saved layouts recover all panels and migrate legacy chat collapse', () => {
  for (const saved of [null, {}, { version: 99 }, { ...defaultLayout(), root: 'rooms' },
    { ...defaultLayout(), root: { axis: 'x', ratio: .5, first: 'rooms', second: 'rooms' } },
    { ...defaultLayout(), floating: [{ id: 'unknown' }] },
    { ...defaultLayout(), root: { axis: 'x', ratio: Infinity, first: 'chat', second: 'video' } }]) {
    assert.deepEqual(restoreLayout(saved, true), defaultLayout(true));
  }
});

test('collapsed chat returns its width to video and restores its previous size', () => {
  const layout = defaultLayout(), before = measureLayout(layout, 1480, 837).panels;
  layout.collapsed.chat = true;
  const collapsed = measureLayout(layout, 1480, 837).panels;
  assert.ok(collapsed.get('video').width > before.get('video').width + 200);
  assert.ok(collapsed.get('chat').width < 50);
  layout.collapsed.chat = false;
  assert.deepEqual(measureLayout(layout, 1480, 837).panels, before);
});

test('small windows and offscreen floating preferences keep panels reachable', () => {
  const offscreen = { id: 'chat', x: 10000, y: 10000, width: 900, height: 1000 };
  for (const collapsed of [false, true]) {
    const r = floatingRect(offscreen, 400, 300, collapsed);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 400 && r.y + r.height <= 300);
  }
  let layout = defaultLayout();
  for (let index = 0; index < 80; index++) {
    layout = dockPanel(layout, PANEL_IDS[index % 4], null, ['left', 'top', 'right', 'bottom'][Math.floor(index / 4) % 4]);
    layout.collapsed[PANEL_IDS[(index + 1) % 4]] = index % 2 === 0;
    assert.deepEqual(restoreLayout(layout), layout);
    for (const r of measureLayout(layout, 400, 300).panels.values()) {
      assert.ok(r.width >= 0 && r.height >= 0 && r.x >= 0 && r.y >= 0 && r.x + r.width <= 400.001 && r.y + r.height <= 300.001);
    }
  }
});
