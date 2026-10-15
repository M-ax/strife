const channel = 'helltube.strife';

// Only messages from this iframe's current document can reach the host callbacks.
export function createHelltubeEmbed(frame, {onContext, onShare, onStop, onReset, windowTarget = window}) {
  let target = null, ready = false, context = null, generation = -1, currentShare = null, connection = null;
  let nativeShare = false;
  const pending = new Map();
  function send(type, data = {}) {
    if (target) frame.contentWindow.postMessage({channel, version: 1, session: target.session, connection, type, ...data}, target.origin);
  }
  function reset() {
    ready = false; context = null; generation = -1; currentShare = null; connection = crypto.randomUUID();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Helltube changed or reloaded.')); }
    pending.clear(); onReset?.();
  }
  function load(url) {
    reset(); target = null;
    const parsed = new URL(url);
    const session = new URLSearchParams(parsed.hash.slice(1)).get('session');
    if (parsed.pathname === '/embed/strife.html' && /^[\w-]{1,128}$/.test(session || '')) target = {origin: parsed.origin, session};
  }
  function hello() { send('hello', {nativeShare}); }
  function loaded() { reset(); hello(); }
  function request(action, data = {}) {
    if (!ready) return Promise.reject(new Error('Helltube’s desktop integration is not connected.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Helltube did not respond.')); }, 15000);
      pending.set(id, {resolve, reject, timer}); send('command', {id, action, ...data});
    });
  }
  function receive(event) {
    const m = event.data;
    if (!target || event.source !== frame.contentWindow || event.origin !== target.origin || !m ||
        m.channel !== channel || m.version !== 1 || m.session !== target.session || m.connection !== connection) return;
    if (m.type === 'ready') { ready = true; return; }
    if (!ready) return;
    if (m.type === 'state' && Number.isSafeInteger(m.generation) && m.generation >= Math.max(generation, 0) && m.context &&
        Array.isArray(m.context.rooms) && m.context.rooms.length <= 10000) {
      if (m.generation !== generation) { currentShare = null; onStop?.(); }
      generation = m.generation; context = m.context; onContext?.(context); return;
    }
    if (m.type === 'result') {
      const item = pending.get(m.id); if (!item) return;
      pending.delete(m.id); clearTimeout(item.timer);
      m.ok === true ? item.resolve(m) : item.reject(new Error(typeof m.error === 'string' ? m.error : 'Helltube rejected the request.'));
    } else if (m.type === 'share-request' && nativeShare && context?.connected && !context.room?.automated &&
        m.share?.generation === generation && m.share.roomId === context.room?.id &&
        /^[\w-]{1,128}$/.test(m.share.id) && !currentShare) {
      currentShare = m.share.id; onShare?.({...m.share, roomName: context.room.name});
    } else if (m.type === 'stop-request' && m.shareId === currentShare) { onStop?.(); currentShare = null; }
  }
  windowTarget.addEventListener('message', receive);
  frame.addEventListener('load', loaded);
  return {load, request,
    available(value) { nativeShare = value === true; if (target) hello(); },
    isCurrent: id => !!id && currentShare === id,
    status(shareId, status, error = '') {
      if (shareId !== currentShare) return;
      send('share-status', {shareId, status, error});
      if (['idle', 'error'].includes(status)) currentShare = null;
    },
    dispose() { reset(); target = null; windowTarget.removeEventListener('message', receive); frame.removeEventListener('load', loaded); },
  };
}
