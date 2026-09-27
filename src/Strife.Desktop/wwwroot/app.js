import { organizeChannels, validateVideoUrl } from './model.js';
import { createWorkspace } from './layout.js';

const $ = id => document.getElementById(id);
// Keep the per-launch capability in this history entry so F5 can reattach.
const token = location.hash.slice(1) || history.state?.strifeToken || '';
history.replaceState({ strifeToken: token }, '', location.pathname);
const pending = new Map(), folded = new Set();
let state = { connected: false, channels: [], users: [] };
let preferences = {}, engineReady = false, currentVideo = '', lastLog = '', startPending = false;
const native = window.external && typeof window.external.sendMessage === 'function';

function notice(text) { $('notice-text').textContent = text; $('notice').hidden = false; }
function request(command, data = {}) {
  if (!native) return Promise.reject(new Error('Open Strife as a desktop app to use Mumble voice controls.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The voice engine did not respond.')); }, 35000);
    pending.set(id, { resolve, reject, timer });
    window.external.sendMessage(JSON.stringify({ ...data, command, id, token }));
  });
}
async function run(command, data) {
  try { return await request(command, data); } catch (error) { notice(error.message); throw error; }
}
let layoutLoaded = false;
const workspace = createWorkspace($('workspace'), layout => {
  if (native) run('preferences', { workspaceLayout: layout, chatCollapsed: layout.collapsed.chat }).catch(() => {});
  else { try { localStorage.setItem('strife-workspace', JSON.stringify(layout)); } catch {} }
});
if (!native) {
  try { workspace.restore(JSON.parse(localStorage.getItem('strife-workspace'))); } catch {}
}
function openVideoSettings() {
  $('helltube-url').value = preferences.helltubeUrl || 'http://127.0.0.1:3000';
  $('video-dialog').showModal();
}
function loadVideo(value) {
  const url = validateVideoUrl(value);
  if (url === currentVideo) return;
  currentVideo = url; $('helltube').src = url; $('video-welcome').hidden = true;
  $('video-address').textContent = new URL(preferences.helltubeUrl || url).host;
}
function showState(next) {
  state = next;
  const self = state.users.find(user => user.id === state.session);
  const channel = state.channels.find(channel => channel.id === self?.channel);
  $('connection-dot').classList.toggle('live', state.connected);
  $('server-name').textContent = state.connected ? (preferences.mumbleHost || 'Mumble server') : 'Find your people.';
  $('server-description').textContent = state.connected ? 'Connected · native Mumble voice' : 'Connect to any Mumble server.';
  $('connect-button').hidden = state.connected; $('disconnect-button').hidden = !state.connected;
  $('self-name').textContent = self?.name || 'Not connected';
  $('self-avatar').textContent = (self?.name || 'S').slice(0, 1).toUpperCase();
  $('transmit-status').textContent = !state.connected ? 'Microphone offline' : state.muted ? 'Microphone muted' :
    ['Continuous transmission', 'Voice activity detection', 'Push to talk'][state.transmitMode];
  $('noise-label').textContent = state.rnnoise ? 'RNNoise · enabled' : 'RNNoise · disabled in settings';
  $('noise-dot').classList.toggle('live', !!state.rnnoise);
  $('ptt-hint').textContent = state.pttBound ? 'Global PTT configured · edit shortcuts ↗' :
    state.transmitMode === 2 ? 'PTT needs a bind · open Shortcuts ↗' : 'Set a global PTT bind in Shortcuts ↗';
  for (const [id, value] of [['mute-button', state.muted], ['deafen-button', state.deafened]]) {
    $(id).disabled = !engineReady; $(id).setAttribute('aria-pressed', String(!!value));
  }
  $('mute-button').querySelector('span').textContent = state.muted ? 'Unmute' : 'Mute';
  $('deafen-button').querySelector('span').textContent = state.deafened ? 'Undeafen' : 'Deafen';
  $('chat-message').disabled = !state.connected; $('send-chat').disabled = !state.connected;
  $('chat-channel').textContent = channel?.name || 'Say hello.';
  $('chat-target').textContent = channel ? 'To ' + channel.name : 'Connect to start chatting';
  $('user-count').textContent = state.users.length + ' online';
  renderTree();
}
function renderTree() {
  const tree = $('channel-tree'), fragment = document.createDocumentFragment();
  const self = state.users.find(user => user.id === state.session);
  const active = document.activeElement?.dataset?.channel;
  function append(node, parent) {
    const item = document.createElement('div'); item.setAttribute('role', 'treeitem'); item.setAttribute('aria-label', node.name);
    const row = document.createElement('div'); row.className = 'channel-row' + (node.id === self?.channel ? ' current' : '');
    const fold = document.createElement('button'); fold.className = 'fold';
    const collapsed = folded.has(node.id) && !$('channel-search').value;
    fold.textContent = collapsed ? '›' : '⌄'; fold.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + node.name);
    fold.setAttribute('aria-expanded', String(!collapsed));
    fold.onclick = () => { if (folded.has(node.id)) folded.delete(node.id); else folded.add(node.id); renderTree(); };
    const join = document.createElement('button'); join.className = 'join'; join.dataset.channel = String(node.id);
    join.textContent = '◈  ' + node.name; join.title = 'Join ' + node.name; join.disabled = !state.connected;
    join.onclick = () => run('join', { channel: node.id }).catch(() => {});
    row.append(fold, join); item.append(row);
    if (!collapsed) {
      for (const user of node.users) {
        const line = document.createElement('div'); line.className = 'channel-user' + (user.talking ? ' talking' : '');
        line.setAttribute('role', 'treeitem'); line.setAttribute('aria-label', user.name + (user.talking ? ', speaking' : '') + (user.muted ? ', muted' : ''));
        const avatar = document.createElement('span'); avatar.className = 'user-avatar'; avatar.textContent = user.name.slice(0, 2).toUpperCase();
        const name = document.createElement('span'); name.className = 'user-name'; name.textContent = user.name;
        const badge = document.createElement('span'); badge.className = 'user-badge'; badge.textContent = user.deafened ? 'DEAF' : user.muted ? 'MUTED' : user.id === state.session ? 'YOU' : '';
        line.append(avatar, name, badge); item.append(line);
      }
      const children = document.createElement('div'); children.className = 'channel-group'; children.setAttribute('role', 'group');
      node.children.forEach(child => append(child, children)); item.append(children);
    }
    parent.append(item);
  }
  organizeChannels(state.connected ? state.channels : [], state.users, $('channel-search').value).forEach(node => append(node, fragment));
  tree.replaceChildren(fragment);
  if (active) tree.querySelector('[data-channel="' + CSS.escape(active) + '"]')?.focus({ preventScroll: true });
  $('voice-empty').hidden = state.connected;
}
function receive(raw) {
  let message; try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'result') {
    const item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    message.ok ? item.resolve(message) : item.reject(new Error(message.error || 'The command failed.'));
  } else if (message.type === 'preferences') {
    preferences = message.value;
    // Only hydrate once: acknowledgements for earlier drags must not undo newer moves.
    if (!layoutLoaded) { workspace.restore(preferences.workspaceLayout, !!preferences.chatCollapsed); layoutLoaded = true; }
    if (message.videoUrl || (!currentVideo && preferences.helltubeUrl)) loadVideo(message.videoUrl || preferences.helltubeUrl);
    showState(state);
  } else if (message.type === 'engine') {
    engineReady = message.ready; $('engine-label').textContent = engineReady ? 'Voice engine ready' : 'Voice engine offline';
    if (!engineReady) {
      showState({ connected: false, channels: [], users: [] }); $('noise-label').textContent = 'Voice engine offline';
    } else if (state.channels) showState(state);
    if (message.error) notice(message.error);
    document.querySelectorAll('[data-native]').forEach(button => button.disabled = !engineReady);
  } else if (message.type === 'state') showState(message);
  else if (message.type === 'log') {
    if (workspace.isCollapsed('chat') && lastLog && lastLog !== message.text) $('unread-dot').hidden = false;
    const log = $('chat-log'), nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 50;
    lastLog = message.text; log.textContent = message.text;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
}
if (native) window.external.receiveMessage(receive);
$('dismiss-notice').onclick = () => $('notice').hidden = true;
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('[data-native]').forEach(button => button.onclick = () => { $('menu').open = false; run(button.dataset.native).catch(() => {}); });
$('connect-button').onclick = () => {
  $('host').value = preferences.mumbleHost || ''; $('port').value = preferences.mumblePort || 64738;
  $('username').value = preferences.username || ''; $('password').value = ''; $('connect-dialog').showModal();
};
$('connect-form').onsubmit = async event => {
  event.preventDefault(); $('submit-connect').disabled = true;
  try {
    await run('connect', { host: $('host').value, port: Number($('port').value), username: $('username').value, password: $('password').value });
    $('password').value = ''; $('connect-dialog').close();
  } catch {} finally { $('submit-connect').disabled = false; }
};
$('disconnect-button').onclick = () => run('disconnect').catch(() => {});
$('mute-button').onclick = () => run('mute').catch(() => {});
$('deafen-button').onclick = () => run('deafen').catch(() => {});
$('channel-search').oninput = renderTree;
$('chat-form').onsubmit = async event => {
  event.preventDefault(); const text = $('chat-message').value; if (!text.trim()) return;
  $('send-chat').disabled = true;
  try { await run('chat', { text }); if ($('chat-message').value === text) $('chat-message').value = ''; }
  catch {} finally { $('send-chat').disabled = !state.connected; }
};
$('chat-message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!$('send-chat').disabled) $('chat-form').requestSubmit(); } };
for (const id of ['video-settings', 'video-settings-menu', 'video-welcome-connect', 'video-help']) $(id).onclick = () => { $('menu').open = false; openVideoSettings(); };
$('video-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const url = validateVideoUrl($('helltube-url').value);
    await run('preferences', { helltubeUrl: url }); $('video-dialog').close();
  } catch (error) { notice(error.message); }
};
$('reload-video').onclick = () => { if (currentVideo) $('helltube').src = currentVideo; else openVideoSettings(); };
async function startEngine() {
  if (startPending) return; startPending = true; $('engine-label').textContent = 'Starting voice engine…';
  try { await run('start'); } catch { $('engine-label').textContent = 'Voice engine offline'; } finally { startPending = false; }
}
$('retry-engine').onclick = () => { $('menu').open = false; startEngine(); };
$('quit').onclick = () => run('quit').catch(() => {});
renderTree();
if (native) request('ready').then(() => { if (!engineReady) return startEngine(); }).catch(error => notice(error.message));
else { $('engine-label').textContent = 'Desktop preview'; document.querySelectorAll('[data-native]').forEach(b => b.disabled = true); }
