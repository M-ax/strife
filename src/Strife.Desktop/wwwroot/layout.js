import { PANEL_IDS, BAR, GAP, defaultLayout, restoreLayout, dockPanel, floatPanel, floatingRect, measureLayout, containsPanel } from './layout-model.js';

const titles = { rooms: 'Mumble rooms', chat: 'Voice chat', controls: 'User controls', video: 'Helltube' };
const collapseNames = { ...titles, chat: 'chat' };
const sides = ['top', 'bottom', 'left', 'right'];

export function createWorkspace(workspace, onChange) {
  let layout = defaultLayout(), dirty = false, drag = null, geometry, menuPanel = null;
  const panels = new Map(PANEL_IDS.map(id => [id, workspace.querySelector('[data-panel="' + id + '"]')]));
  const buttons = new Map(), separators = new Map();
  const make = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  const position = (element, rect) => {
    for (const key of ['x', 'y', 'width', 'height']) element.style[key === 'x' ? 'left' : key === 'y' ? 'top' : key] = rect[key] + 'px';
  };
  const preview = make('div', 'dock-preview');
  const hint = make('div', 'drag-hint', 'Drop at an edge to dock · Drop elsewhere to float · Esc to cancel');
  const guides = make('div', 'dock-guides');
  const targetGuides = make('div', 'target-guides');
  for (const side of sides) {
    guides.append(make('span', 'dock-guide dock-guide-' + side, 'Dock ' + side));
    targetGuides.append(make('span', 'dock-guide dock-guide-' + side, side === 'top' ? 'Above' : side === 'bottom' ? 'Below' : side));
  }
  const empty = make('div', 'workspace-empty', 'Drag a panel to an edge to dock it here.');
  const menu = make('div', 'panel-menu'); menu.id = 'panel-position-menu'; menu.hidden = true;
  const status = make('div', 'sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  preview.hidden = hint.hidden = guides.hidden = targetGuides.hidden = true;
  workspace.append(empty, preview, guides, targetGuides, hint, menu, status);

  function announce(text) { status.textContent = text; }
  function commit(text) { dirty = true; render(); onChange(structuredClone(layout)); if (text) announce(text); }
  function collapse(id, value) {
    layout.collapsed[id] = value;
    if (id === 'chat' && !value) document.getElementById('unread-dot').hidden = true;
    commit(titles[id] + (value ? ' collapsed.' : ' expanded.'));
    (value && id === 'chat' ? buttons.get(id).expand : buttons.get(id).collapse).focus();
  }
  for (const [id, panel] of panels) {
    const header = panel.querySelector('.panel-header');
    const handle = make('button', 'panel-handle', titles[id]);
    handle.type = 'button'; handle.title = 'Drag to dock or float. Use the position menu for more options.';
    handle.setAttribute('aria-label', 'Drag ' + titles[id]);
    handle.setAttribute('aria-describedby', 'layout-help');
    handle.addEventListener('pointerdown', event => startDrag(event, id, handle));
    const tools = make('div', 'panel-tools');
    const actions = header.querySelector('.video-actions');
    if (actions) tools.append(actions);
    const move = make('button', 'panel-position', '⋮');
    move.type = 'button'; move.title = 'Panel position'; move.setAttribute('aria-label', 'Position ' + titles[id]);
    move.setAttribute('aria-expanded', 'false'); move.setAttribute('aria-controls', menu.id);
    move.onclick = () => menuPanel === id ? closeMenu() : openMenu(id);
    const toggle = make('button', 'panel-collapse', '−');
    toggle.type = 'button'; toggle.setAttribute('aria-controls', panel.querySelector('.panel-body').id);
    toggle.onclick = () => collapse(id, !layout.collapsed[id]);
    let expand;
    if (id === 'chat') {
      toggle.id = 'collapse-chat';
      expand = make('button', 'panel-collapse', '+'); expand.type = 'button'; expand.id = 'expand-chat';
      expand.setAttribute('aria-label', 'Expand chat'); expand.setAttribute('aria-expanded', 'false');
      expand.setAttribute('aria-controls', panel.querySelector('.panel-body').id);
      expand.onclick = () => collapse(id, false);
      const unread = make('span', 'dot live'); unread.id = 'unread-dot'; unread.hidden = true; unread.title = 'Unread messages';
      unread.setAttribute('aria-label', 'Unread messages'); tools.append(unread);
    }
    tools.append(move, toggle); if (expand) tools.append(expand);
    header.replaceChildren(handle, tools);
    const resize = make('button', 'panel-resize');
    resize.type = 'button'; resize.setAttribute('aria-label', 'Resize ' + titles[id]); resize.title = 'Drag to resize, or use arrow keys';
    resize.addEventListener('pointerdown', event => startResize(event, id, resize));
    resize.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const item = layout.floating.find(item => item.id === id); if (!item) return;
      item.width = Math.max(220, item.width + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0));
      item.height = Math.max(180, item.height + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0));
      Object.assign(item, floatingRect(item, workspace.clientWidth, workspace.clientHeight));
      commit();
    };
    panel.append(resize);
    buttons.set(id, { handle, move, collapse: toggle, expand, resize });
    panel.addEventListener('pointerdown', () => {
      const index = layout.floating.findIndex(item => item.id === id);
      if (index >= 0 && index !== layout.floating.length - 1) {
        layout.floating.push(...layout.floating.splice(index, 1)); render();
      }
    });
  }

  function render() {
    const width = workspace.clientWidth, height = workspace.clientHeight;
    geometry = measureLayout(layout, width, height);
    empty.hidden = !!layout.root;
    const floating = new Map(layout.floating.map((item, index) => [item.id, { rect: floatingRect(item, width, height, layout.collapsed[item.id]), index }]));
    for (const [id, panel] of panels) {
      const float = floating.get(id), rect = float?.rect || geometry.panels.get(id);
      const collapsed = layout.collapsed[id], rail = collapsed && !float && rect.width <= BAR + .1 && rect.height > BAR;
      position(panel, rect);
      panel.style.zIndex = float ? String(10 + float.index) : '1';
      panel.classList.toggle('is-floating', !!float); panel.classList.toggle('is-collapsed', collapsed);
      panel.classList.toggle('is-rail', rail); panel.classList.toggle('is-compact', rect.height < 330);
      panel.dataset.mode = float ? 'floating' : 'docked';
      panel.querySelector('.panel-body').hidden = collapsed;
      if (id === 'chat' && !collapsed) document.getElementById('unread-dot').hidden = true;
      const b = buttons.get(id);
      b.collapse.setAttribute('aria-expanded', String(!collapsed));
      b.collapse.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + collapseNames[id]);
      b.collapse.title = (collapsed ? 'Expand ' : 'Collapse ') + collapseNames[id];
      b.collapse.textContent = collapsed ? '+' : '−';
      b.collapse.hidden = id === 'chat' && collapsed;
      if (b.expand) b.expand.hidden = !collapsed;
      b.resize.hidden = !float || collapsed;
    }
    const active = new Set();
    for (const divider of geometry.dividers) {
      if (!divider.resizable) continue;
      active.add(divider.path);
      let element = separators.get(divider.path);
      if (!element) {
        element = make('div', 'layout-divider');
        element.tabIndex = 0; element.setAttribute('role', 'separator');
        element.setAttribute('aria-label', 'Resize docked panels');
        element.addEventListener('pointerdown', event => startSplit(event, element));
        element.onkeydown = event => {
          const d = element.divider, keys = d.node.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
          if (!keys.includes(event.key)) return;
          event.preventDefault(); d.node.ratio = Math.max(.05, Math.min(.95, d.node.ratio + (event.key === keys[0] ? -.03 : .03))); commit();
        };
        workspace.append(element); separators.set(divider.path, element);
      }
      element.divider = divider; element.dataset.axis = divider.node.axis;
      element.setAttribute('aria-orientation', divider.node.axis === 'x' ? 'vertical' : 'horizontal');
      element.setAttribute('aria-valuemin', '5'); element.setAttribute('aria-valuemax', '95');
      element.setAttribute('aria-valuenow', String(Math.round(divider.node.ratio * 100)));
      position(element, divider.rect);
    }
    for (const [path, element] of separators) if (!active.has(path)) { element.remove(); separators.delete(path); }
  }

  function closeMenu(focus = false) {
    const id = menuPanel;
    if (id) buttons.get(id).move.setAttribute('aria-expanded', 'false');
    menuPanel = null; menu.hidden = true;
    if (focus && id) buttons.get(id).move.focus();
  }
  function openMenu(id) {
    closeMenu(); menuPanel = id;
    const add = (text, action) => {
      const button = make('button', '', text); button.type = 'button';
      button.onclick = () => { closeMenu(); action(); buttons.get(id).move.focus(); };
      menu.append(button);
    };
    menu.replaceChildren(make('strong', '', 'Position ' + titles[id]));
    for (const side of sides) add('Dock ' + side, () => { layout = dockPanel(layout, id, null, side); commit(titles[id] + ' docked ' + side + '.'); });
    if (id !== 'rooms' && containsPanel(layout.root, 'rooms')) {
      add('Above Mumble rooms', () => { layout = dockPanel(layout, id, 'rooms', 'top'); commit(titles[id] + ' above Mumble rooms.'); });
      add('Below Mumble rooms', () => { layout = dockPanel(layout, id, 'rooms', 'bottom'); commit(titles[id] + ' below Mumble rooms.'); });
    }
    add('Float panel', () => {
      const rect = panels.get(id).getBoundingClientRect(), base = workspace.getBoundingClientRect();
      layout = floatPanel(layout, id, { x: rect.x - base.x + 24, y: rect.y - base.y + 24, width: Math.max(280, Math.min(480, rect.width)), height: id === 'controls' ? 240 : 400 });
      commit(titles[id] + ' floating.');
    });
    buttons.get(id).move.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const anchor = buttons.get(id).move.getBoundingClientRect(), base = workspace.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(workspace.clientWidth - menu.offsetWidth, anchor.right - base.left - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(0, Math.min(workspace.clientHeight - menu.offsetHeight, anchor.bottom - base.top + 4)) + 'px';
    menu.querySelector('button').focus();
  }
  document.addEventListener('pointerdown', event => {
    if (menuPanel && !menu.contains(event.target) && !buttons.get(menuPanel).move.contains(event.target)) closeMenu();
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  function begin(event, handle, details) {
    if (event.button !== 0 || drag) return false;
    event.preventDefault(); closeMenu(); handle.focus({ preventScroll: true });
    drag = { ...details, pointerId: event.pointerId, handle, startX: event.clientX, startY: event.clientY, before: structuredClone(layout), moved: false };
    handle.setPointerCapture(event.pointerId); return true;
  }
  function startDrag(event, id, handle) {
    const rect = panels.get(id).getBoundingClientRect(), floating = layout.floating.find(item => item.id === id);
    begin(event, handle, { kind: 'move', id, offsetX: Math.min(event.clientX - rect.left, 160), offsetY: Math.min(event.clientY - rect.top, 20),
      width: floating ? rect.width : Math.max(280, Math.min(480, rect.width)), height: floating ? floating.height : Math.max(200, Math.min(500, rect.height)) });
  }
  function startResize(event, id, handle) {
    const item = layout.floating.find(item => item.id === id);
    if (item) begin(event, handle, { kind: 'resize', id, rect: floatingRect(item, workspace.clientWidth, workspace.clientHeight) });
  }
  function startSplit(event, handle) {
    begin(event, handle, { kind: 'split', divider: handle.divider });
  }
  function dropAt(x, y) {
    const width = workspace.clientWidth, height = workspace.clientHeight;
    targetGuides.hidden = true;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    const edge = [[y, 'top'], [height - y, 'bottom'], [x, 'left'], [width - x, 'right']].sort((a, b) => a[0] - b[0])[0];
    if (edge[0] < 28) return { target: null, side: edge[1], rect: { x: 0, y: 0, width, height } };
    for (const item of layout.floating) {
      if (item.id === drag.id) continue;
      const rect = floatingRect(item, width, height, layout.collapsed[item.id]);
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return null;
    }
    for (const [id, rect] of geometry.panels) {
      if (id === drag.id || x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
      targetGuides.hidden = false; position(targetGuides, rect);
      const edges = [[y - rect.y, 'top', rect.height], [rect.y + rect.height - y, 'bottom', rect.height],
        [x - rect.x, 'left', rect.width], [rect.x + rect.width - x, 'right', rect.width]];
      const nearest = edges.filter(([distance, , size]) => distance < Math.min(65, size * .25)).sort((a, b) => a[0] - b[0])[0];
      if (nearest) return { target: id, side: nearest[1], rect };
    }
    return null;
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; workspace.classList.add('layout-interacting');
    const base = workspace.getBoundingClientRect(), x = event.clientX - base.left, y = event.clientY - base.top;
    if (drag.kind === 'move') {
      hint.hidden = guides.hidden = preview.hidden = false;
      drag.drop = dropAt(x, y);
      drag.bounds = floatingRect({ x: x - drag.offsetX, y: y - drag.offsetY, width: drag.width, height: drag.height }, base.width, base.height, layout.collapsed[drag.id]);
      let rect = { ...drag.bounds };
      if (drag.drop) {
        rect = { ...drag.drop.rect }; const { side } = drag.drop;
        if (['top', 'bottom'].includes(side)) { rect.height /= 2; if (side === 'bottom') rect.y += rect.height; }
        else { rect.width /= 2; if (side === 'right') rect.x += rect.width; }
      }
      preview.textContent = drag.drop ? 'Dock ' + (drag.drop.target ? (drag.drop.side + ' of ' + titles[drag.drop.target]) : drag.drop.side) : 'Float ' + titles[drag.id];
      preview.classList.toggle('will-float', !drag.drop); position(preview, rect);
    } else if (drag.kind === 'resize') {
      const item = layout.floating.find(item => item.id === drag.id), rect = drag.rect;
      item.width = Math.max(Math.min(220, base.width), Math.min(base.width - rect.x, rect.width + dx));
      item.height = Math.max(Math.min(180, base.height), Math.min(base.height - rect.y, rect.height + dy));
      item.x = rect.x; item.y = rect.y; render();
    } else {
      const { node, parent } = drag.divider;
      node.ratio = Math.max(.05, Math.min(.95, (node.axis === 'x' ? x - parent.x : y - parent.y) / Math.max(1, (node.axis === 'x' ? parent.width : parent.height) - GAP)));
      render();
    }
  }
  function finish(cancel = false) {
    if (!drag) return;
    const current = drag; drag = null;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    workspace.classList.remove('layout-interacting');
    preview.hidden = guides.hidden = hint.hidden = targetGuides.hidden = true;
    if (cancel) { layout = current.before; render(); announce('Layout change cancelled.'); return; }
    if (!current.moved) return;
    if (current.kind === 'move') {
      layout = current.drop ? dockPanel(layout, current.id, current.drop.target, current.drop.side) :
        floatPanel(layout, current.id, { ...current.bounds, height: layout.collapsed[current.id] ? current.height : current.bounds.height });
    }
    commit(current.kind === 'move' ? titles[current.id] + (current.drop ? ' docked.' : ' floating.') : 'Panel resized.');
  }
  workspace.addEventListener('pointermove', move);
  workspace.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointerId) { move(event); finish(); } });
  workspace.addEventListener('pointercancel', () => finish(true));
  workspace.addEventListener('lostpointercapture', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (drag || menuPanel)) { event.preventDefault(); if (drag) finish(true); else closeMenu(true); }
  });
  new ResizeObserver(() => { if (drag) finish(true); closeMenu(); render(); }).observe(workspace);
  document.getElementById('reset-layout').onclick = () => {
    finish(true); closeMenu(); layout = defaultLayout(); commit('Default layout restored.');
    document.getElementById('menu').open = false;
  };
  render();
  return {
    restore(value, legacyCollapsed) { if (!dirty) { layout = restoreLayout(value, legacyCollapsed); render(); } },
    isCollapsed(id) { return layout.collapsed[id]; }
  };
}
