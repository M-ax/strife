import { createChannelTree } from './channel-tree.js';

const $ = id => document.getElementById(id);
function examples() {
  return {
    connected: true, session: 7,
    channels: [
      { id: 0, parent: -1, position: 0, name: 'After Hours' },
      { id: 1, parent: 0, position: 0, name: 'The lounge' },
      { id: 2, parent: 0, position: 1, name: 'One more round' },
      { id: 3, parent: 0, position: 2, name: 'Quiet corner' },
      { id: 4, parent: 0, position: 3, name: 'Watch party' },
      { id: 5, parent: 2, position: 0, name: 'Co-op' }
    ],
    users: [
      { id: 7, name: 'M-ax', channel: 1 },
      { id: 8, name: 'Aria', channel: 1, talking: true },
      { id: 9, name: 'Finch', channel: 1, muted: true },
      { id: 10, name: 'Nova', channel: 1, muted: true, deafened: true },
      { id: 11, name: 'Rowan', channel: 1 },
      { id: 12, name: 'Cassiopeia_with_a_very_long_name', channel: 2, muted: true, deafened: true },
      { id: 13, name: 'Jules', channel: 2, talking: true },
      { id: 14, name: '雪ねこ', channel: 5 },
      { id: 15, name: '🌙 Luna', channel: 3, deafened: true }
    ]
  };
}
let state = examples();
const tree = createChannelTree($('channel-tree'), channel => {
  state.users.find(user => user.id === state.session).channel = channel;
  render();
});
function render() {
  tree.render(state, $('channel-search').value);
  $('user-count').textContent = `${state.users.length} online`;
}
function selectSelf() {
  const self = state.users.find(user => user.id === state.session);
  $('preview-state').value = self.deafened ? (self.muted ? 'deafened' : 'deafened-only') : self.muted ? 'muted' : self.talking ? 'talking' : 'idle';
  render();
}
function applyWidth() {
  const value = $('preview-width').value;
  document.documentElement.style.setProperty('--roster-width', `${value}px`);
  $('preview-width-label').textContent = `${value} px`;
}
function applyAccent() {
  const value = $('preview-accent').value;
  document.documentElement.style.setProperty('--accent-color', value);
  document.documentElement.style.setProperty('--accent-soft', value + '22');
}
$('preview-self').replaceChildren(...state.users.map(user => new Option(user.name, String(user.id))));
$('preview-self').value = String(state.session);
$('preview-self').onchange = () => { state.session = Number($('preview-self').value); selectSelf(); };
$('preview-state').onchange = () => {
  const value = $('preview-state').value, self = state.users.find(user => user.id === state.session);
  Object.assign(self, { talking: value === 'talking', muted: value === 'muted' || value === 'deafened', deafened: value.startsWith('deafened') });
  render();
};
$('channel-search').oninput = render;
$('preview-width').oninput = applyWidth;
$('preview-accent').onchange = applyAccent;
$('preview-reset').onclick = () => {
  tree.render({ connected: false, channels: [], users: [] });
  state = examples();
  $('channel-search').value = ''; $('preview-self').value = String(state.session);
  $('preview-width').value = '320'; $('preview-accent').value = '#00e0bb';
  applyWidth(); applyAccent(); selectSelf();
};
render();
