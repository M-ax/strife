import { organizeChannels } from './model.js';

function userRow(user, session) {
  const self = user.id === session;
  const line = document.createElement('div');
  line.className = 'channel-user' + (self ? ' is-self' : '') + (user.talking ? ' talking' : '');
  const label = [user.name, self && 'you', user.talking && 'speaking', user.muted && 'muted', user.deafened && 'deafened'].filter(Boolean).join(', ');
  line.setAttribute('role', 'treeitem'); line.setAttribute('aria-label', label); line.title = label;
  const avatar = document.createElement('span'); avatar.className = 'user-avatar';
  avatar.textContent = Array.from(user.name).slice(0, 2).join('').toUpperCase(); avatar.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span'); name.className = 'user-name'; name.textContent = user.name;
  line.append(avatar, name);
  const status = document.createElement('span'); status.className = 'user-status'; status.setAttribute('aria-hidden', 'true');
  for (const [active, icon, title] of [[user.muted, 'microphone', 'Muted'], [user.deafened, 'headphones', 'Deafened']]) {
    if (!active) continue;
    const symbol = document.createElement('i'); symbol.className = `voice-icon icon-${icon} is-off`; symbol.title = title;
    status.append(symbol);
  }
  if (status.childElementCount) line.append(status);
  return line;
}

// Shared by the desktop and the dummy-data design preview.
export function createChannelTree(tree, onJoin) {
  const folded = new Set(), expandedEmpty = new Set();
  function render(state, query = '') {
    if (!state.connected) { folded.clear(); expandedEmpty.clear(); }
    query = query.trim();
    const fragment = document.createDocumentFragment();
    const self = state.users.find(user => user.id === state.session);
    const active = document.activeElement?.dataset?.treeFocus;
    function appendSiblings(nodes, parent, key) {
      if (query) { nodes.forEach(node => append(node, parent)); return; }
      const empty = [];
      for (const node of nodes) {
        if (node.populated) append(node, parent); else empty.push(node);
      }
      if (!empty.length) return;
      const expanded = expandedEmpty.has(key);
      const label = empty.length + (empty.length === 1 ? ' channel' : ' channels');
      const row = document.createElement('div'); row.className = 'channel-row empty-channels';
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-label', label);
      const toggle = document.createElement('button'); toggle.className = 'empty-channels-toggle';
      toggle.textContent = label; toggle.dataset.treeFocus = 'empty:' + key;
      toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + empty.length + (empty.length === 1 ? ' empty channel' : ' empty channels'));
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.onclick = () => { if (expanded) expandedEmpty.delete(key); else expandedEmpty.add(key); render(state, query); };
      row.append(toggle); parent.append(row);
      // The disclosure and its rooms are siblings; only real channel hierarchy adds indentation.
      if (expanded) empty.forEach(node => append(node, parent));
    }
    function append(node, parent) {
      const item = document.createElement('div'); item.setAttribute('role', 'treeitem'); item.setAttribute('aria-label', node.name);
      const row = document.createElement('div'); row.className = 'channel-row' + (node.id === self?.channel ? ' current' : '');
      const fold = document.createElement('button'); fold.className = 'fold';
      const collapsed = folded.has(node.id) && !query;
      fold.dataset.treeFocus = 'fold:' + node.id;
      fold.disabled = !node.children.length && !node.users.length;
      fold.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + node.name);
      fold.setAttribute('aria-expanded', String(!collapsed));
      fold.onclick = () => { if (folded.has(node.id)) folded.delete(node.id); else folded.add(node.id); render(state, query); };
      const join = document.createElement('button'); join.className = 'join'; join.dataset.channel = String(node.id);
      join.dataset.treeFocus = 'join:' + node.id;
      join.textContent = node.name; join.title = 'Join ' + node.name; join.disabled = !state.connected;
      join.onclick = () => onJoin(node.id);
      row.append(fold, join); item.append(row);
      if (!collapsed) {
        for (const user of node.users) item.append(userRow(user, state.session));
        const children = document.createElement('div'); children.className = 'channel-group'; children.setAttribute('role', 'group');
        appendSiblings(node.children, children, node.id); item.append(children);
      }
      parent.append(item);
    }
    const roots = organizeChannels(state.connected ? state.channels : [], state.users, query);
    // Keep the server's root visible even when everyone is offline.
    if (roots.length === 1) append(roots[0], fragment); else appendSiblings(roots, fragment, 'root');
    tree.replaceChildren(fragment);
    if (active) tree.querySelector('[data-tree-focus="' + CSS.escape(active) + '"]')?.focus({ preventScroll: true });
  }
  return { render };
}
