import test from 'node:test';
import assert from 'node:assert/strict';
import {createHelltubeEmbed} from '../../src/Strife.Desktop/wwwroot/helltube-embed.js';

test('host rejects other frames/origins/sessions and retires requests on reload', async () => {
  let receive, loaded; const sent = [], contexts = [], shares = [];
  const contentWindow = {postMessage: message => sent.push(message)};
  const frame = {contentWindow, addEventListener: (_, callback) => loaded = callback, removeEventListener() {}};
  const host = createHelltubeEmbed(frame, {windowTarget: {addEventListener: (_, callback) => receive = callback, removeEventListener() {}},
    onContext: value => contexts.push(value), onShare: value => shares.push(value)});
  host.load('http://127.0.0.1:2000/embed/strife.html#session=session'); host.available(true); loaded();
  const hello = sent.at(-1);
  const send = (data, source = contentWindow, origin = 'http://127.0.0.1:2000') => receive({source, origin, data: {...hello, ...data}});
  send({type: 'ready'}, {}); send({type: 'ready'}, contentWindow, 'http://evil.test');
  await assert.rejects(host.request('selectRoom'), /not connected/);
  send({type: 'ready'});
  const state = {userId: 'u', room: {id: 'lobby', name: 'Lobby'}, rooms: [], connected: true};
  send({type: 'state', generation: 2, context: state});
  send({type: 'state', generation: 1, context: state});
  assert.equal(contexts.length, 1);
  send({type: 'share-request', share: {id: 'share', roomId: 'other', generation: 2}});
  assert.equal(shares.length, 0);
  send({type: 'share-request', share: {id: 'share', roomId: 'lobby', generation: 2}});
  assert.equal(shares.length, 1);
  const pending = host.request('credential', {shareId: 'share'});
  const rejected = assert.rejects(pending, /reloaded/); loaded(); await rejected;
  send({type: 'ready'}); // Old document's handshake cannot become ready again.
  await assert.rejects(host.request('credential'), /not connected/);
  host.dispose();
});
