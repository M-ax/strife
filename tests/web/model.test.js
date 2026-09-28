import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeChannels, validateVideoUrl } from '../../src/Strife.Desktop/wwwroot/model.js';

const channels = [
  { id: 2, parent: 0, position: 1, name: 'Lounge' },
  { id: 0, parent: -1, position: 0, name: 'Root' },
  { id: 1, parent: 0, position: 0, name: 'Games' }
];
test('server ordering, hierarchy and current users', () => {
  const tree = organizeChannels(channels, [{ id: 8, name: 'Alice', channel: 2 }]);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map(c => c.id), [1, 2]);
  assert.equal(tree[0].children[1].users[0].name, 'Alice');
});
test('search preserves ancestors and finds users', () => {
  const tree = organizeChannels(channels, [{ id: 8, name: 'Alice', channel: 2 }], 'alice');
  assert.equal(tree[0].name, 'Root');
  assert.deepEqual(tree[0].children.map(c => c.id), [2]);
});
test('occupied descendants keep their entire path out of empty channel groups', () => {
  const nested = [...channels,
    { id: 3, parent: 1, position: 0, name: 'Co-op' },
    { id: 4, parent: 1, position: 1, name: 'Quiet' }
  ];
  const users = [{ id: 8, name: 'Alice', channel: 3 }];
  const [root] = organizeChannels(nested, users);
  const [games, lounge] = root.children;
  assert.equal(root.populated, true);
  assert.equal(games.populated, true);
  assert.equal(games.children[0].populated, true);
  assert.equal(games.children[1].populated, false);
  assert.equal(lounge.populated, false);
  const [vacant] = organizeChannels(nested, []);
  assert.equal(vacant.populated, false, 'occupancy is recalculated when users leave');
  assert.equal(vacant.children[0].populated, false);
  assert.equal(nested[0].populated, undefined, 'native state is not mutated');
});

test('missing parents and malicious cycles cannot hang the renderer', () => {
  const tree = organizeChannels([
    { id: 1, parent: 2, name: 'A', position: 0 }, { id: 2, parent: 1, name: 'B', position: 0 },
    { id: 3, parent: 99, name: 'C', position: 0 }
  ], []);
  assert.equal(tree.length, 3);
});
test('Helltube addresses permit local development and reject active schemes/credentials', () => {
  assert.equal(validateVideoUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  for (const value of ['javascript:alert(1)', 'file:///C:/foo', 'https://user:pass@host'])
    assert.throws(() => validateVideoUrl(value));
});
