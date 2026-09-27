export const PANEL_IDS = ['rooms', 'chat', 'controls', 'video'];
export const GAP = 0;
export const BAR = 42;
const split = (axis, ratio, first, second) => ({ axis, ratio, first, second });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function defaultLayout(chatCollapsed = false) {
  return {
    version: 1,
    root: split('x', .17, split('y', .73, 'rooms', 'controls'), split('x', .24, 'chat', 'video')),
    floating: [],
    collapsed: Object.fromEntries(PANEL_IDS.map(id => [id, id === 'chat' && chatCollapsed]))
  };
}

// Treat saved layouts as untrusted input. Every panel must occur exactly once.
export function restoreLayout(value, chatCollapsed = false) {
  const fallback = () => defaultLayout(chatCollapsed);
  if (!value || value.version !== 1 || !Array.isArray(value.floating) || value.floating.length > 4) return fallback();
  const seen = new Set();
  function panel(id) {
    if (!PANEL_IDS.includes(id) || seen.has(id)) throw new Error('Invalid panel');
    seen.add(id); return id;
  }
  function node(input, depth = 0) {
    if (typeof input === 'string') return panel(input);
    if (!input || depth > 6 || !['x', 'y'].includes(input.axis) || !Number.isFinite(input.ratio)) throw new Error('Invalid split');
    return split(input.axis, clamp(input.ratio, .05, .95), node(input.first, depth + 1), node(input.second, depth + 1));
  }
  try {
    const root = value.root === null ? null : node(value.root);
    const floating = value.floating.map(item => {
      if (!item || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key]))) throw new Error('Invalid bounds');
      return { id: panel(item.id), x: clamp(item.x, 0, 20000), y: clamp(item.y, 0, 20000),
        width: clamp(item.width, 220, 4000), height: clamp(item.height, 180, 4000) };
    });
    if (seen.size !== PANEL_IDS.length) return fallback();
    return { version: 1, root, floating, collapsed: Object.fromEntries(PANEL_IDS.map(id => [id, value.collapsed?.[id] === true])) };
  } catch { return fallback(); }
}

export function containsPanel(node, id) {
  return typeof node === 'string' ? node === id : !!node && (containsPanel(node.first, id) || containsPanel(node.second, id));
}
function remove(node, id) {
  if (!node || typeof node === 'string') return node === id ? null : node;
  const first = remove(node.first, id), second = remove(node.second, id);
  return !first ? second : !second ? first : { ...node, first, second };
}
export function dockPanel(layout, id, target, side) {
  if (!PANEL_IDS.includes(id) || !['top', 'bottom', 'left', 'right'].includes(side) || target === id ||
      (target && !containsPanel(layout.root, target))) return layout;
  const next = structuredClone(layout);
  next.root = remove(next.root, id);
  next.floating = next.floating.filter(item => item.id !== id);
  const axis = ['left', 'right'].includes(side) ? 'x' : 'y';
  const before = ['left', 'top'].includes(side);
  const wrap = node => before ? split(axis, target ? .5 : .25, id, node) : split(axis, target ? .5 : .75, node, id);
  function insert(node) {
    if (node === target) return wrap(node);
    return typeof node === 'string' ? node : { ...node, first: insert(node.first), second: insert(node.second) };
  }
  next.root = !next.root ? id : target ? insert(next.root) : wrap(next.root);
  return next;
}
export function floatPanel(layout, id, bounds) {
  const next = structuredClone(layout);
  next.root = remove(next.root, id);
  next.floating = next.floating.filter(item => item.id !== id);
  next.floating.push({ id, ...bounds });
  return next;
}
export function floatingRect(item, width, height, collapsed = false) {
  const w = Math.min(width, Math.max(220, item.width));
  const h = Math.min(height, collapsed ? BAR : Math.max(180, item.height));
  return { x: clamp(item.x, 0, width - w), y: clamp(item.y, 0, height - h), width: w, height: h };
}

// Layout by coordinates keeps the live video iframe in its original DOM parent.
export function measureLayout(layout, width, height) {
  const panels = new Map(), dividers = [];
  function minimum(node, axis) {
    if (typeof node === 'string') return layout.collapsed[node] ? BAR : axis === 'x' ? (node === 'video' ? 280 : 220) : (node === 'controls' ? 200 : 180);
    const a = minimum(node.first, axis), b = minimum(node.second, axis);
    return node.axis === axis ? a + b + GAP : Math.max(a, b);
  }
  function fixed(node, axis) {
    if (typeof node === 'string') return layout.collapsed[node] ? BAR : null;
    const a = fixed(node.first, axis), b = fixed(node.second, axis);
    return a === null || b === null ? null : node.axis === axis ? a + b + GAP : Math.max(a, b);
  }
  function visit(node, rect, path = '') {
    if (typeof node === 'string') { panels.set(node, rect); return; }
    const horizontal = node.axis === 'x', size = horizontal ? rect.width : rect.height;
    const gap = Math.min(GAP, size), available = Math.max(0, size - gap);
    const minA = minimum(node.first, node.axis), minB = minimum(node.second, node.axis);
    const fixedA = fixed(node.first, node.axis), fixedB = fixed(node.second, node.axis);
    let a = fixedA ?? (fixedB === null ? available * node.ratio : available - fixedB);
    a = minA + minB > available ? available * minA / (minA + minB) : clamp(a, minA, available - minB);
    const first = { ...rect, [horizontal ? 'width' : 'height']: a };
    const divider = { ...rect, [horizontal ? 'x' : 'y']: (horizontal ? rect.x : rect.y) + a, [horizontal ? 'width' : 'height']: gap };
    const second = { ...rect, [horizontal ? 'x' : 'y']: (horizontal ? rect.x : rect.y) + a + gap, [horizontal ? 'width' : 'height']: available - a };
    dividers.push({ path, node, rect: divider, parent: rect, resizable: fixedA === null && fixedB === null });
    visit(node.first, first, path + '0'); visit(node.second, second, path + '1');
  }
  if (layout.root) visit(layout.root, { x: 0, y: 0, width, height });
  return { panels, dividers };
}
