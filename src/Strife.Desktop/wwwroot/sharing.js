import {createHelltubeEmbed} from './helltube-embed.js';

export function createSharing({request, notice}) {
  const $ = id => document.getElementById(id);
  let share = null, phase = 'idle', context = null, timer = null;
  const embed = createHelltubeEmbed($('helltube'), {
    onContext(value) {
      context = value;
      $('helltube-controls').hidden = !value.userId;
      const options = value.rooms.filter(r => typeof r.id === 'string' && typeof r.name === 'string').map(r => new Option(r.name, r.id));
      $('helltube-room').replaceChildren(new Option('Choose a room', ''), ...options);
      $('helltube-room').value = value.room?.id || '';
      $('helltube-sound').textContent = value.playback?.muted ? 'Unmute video' : 'Mute video';
    },
    onShare: choose,
    onStop: () => void stop(),
    onReset() { context = null; $('helltube-controls').hidden = true; void stop(); },
  });
  function showStatus(text) {
    $('sharing-status').textContent = text;
    $('sharing-bar').hidden = !share;
  }
  async function stop(error = '') {
    const old = share; share = null; phase = 'idle'; clearTimeout(timer);
    if (old) embed.status(old.id, error ? 'error' : 'idle', error);
    if ($('sharing-dialog').open) $('sharing-dialog').close();
    showStatus('');
    await request('streamStop').catch(() => {});
    if (error) notice(error);
  }
  async function choose(value) {
    share = value; phase = 'choosing';
    $('sharing-room').textContent = value.roomName;
    $('sharing-sources').replaceChildren(new Option('Finding windows and displays…', ''));
    $('sharing-start').disabled = true; $('sharing-audio').checked = false;
    $('sharing-error').textContent = '';
    $('sharing-dialog').showModal(); showStatus('Choosing a screen for ' + value.roomName);
    try {
      const result = await request('streamSources', {shareId: value.id});
      if (share !== value || !embed.isCurrent(value.id)) return;
      const sources = result.value.sources;
      $('sharing-sources').replaceChildren(...sources.map(s => new Option(s.name, s.id)));
      $('sharing-start').disabled = !sources.length;
      if (!sources.length) $('sharing-error').textContent = 'No windows or displays are available. Restore a window and try again.';
    } catch (error) { if (share === value) await stop(error.message); }
  }
  async function poll(value) {
    if (share !== value) return;
    try {
      const result = (await request('streamStatus')).value;
      if (share !== value) return;
      if (result.status === 'error' || result.status === 'idle') { await stop(result.error || 'Sharing ended.'); return; }
      phase = result.status;
      embed.status(value.id, phase);
      showStatus((phase === 'streaming' ? 'Sharing to ' : 'Connecting to ') + value.roomName);
      timer = setTimeout(() => void poll(value), 1000);
    } catch (error) { if (share === value) await stop(error.message); }
  }
  $('sharing-form').onsubmit = async event => {
    event.preventDefault();
    const value = share;
    if (!value || phase !== 'choosing' || !embed.isCurrent(value.id)) return;
    phase = 'starting'; $('sharing-start').disabled = true;
    embed.status(value.id, 'starting');
    try {
      const result = await embed.request('credential', {shareId: value.id});
      if (share !== value || !embed.isCurrent(value.id)) return;
      if (result.credential?.roomId !== value.roomId) throw new Error('The publishing room changed. Choose Share desktop again.');
      await request('streamStart', {shareId: value.id, sourceId: $('sharing-sources').value,
        audio: $('sharing-audio').checked, credential: result.credential});
      if (share !== value || !embed.isCurrent(value.id)) return;
      $('sharing-dialog').close(); embed.status(value.id, 'starting');
      showStatus('Connecting to ' + value.roomName); void poll(value);
    } catch (error) { if (share === value) await stop(error.message); }
  };
  $('sharing-dialog').addEventListener('cancel', event => { event.preventDefault(); void stop(); });
  $('sharing-cancel').onclick = () => void stop();
  $('sharing-stop').onclick = () => void stop();
  $('helltube-room').onchange = () => {
    if ($('helltube-room').value) embed.request('selectRoom', {roomId: $('helltube-room').value}).catch(error => notice(error.message));
  };
  $('helltube-sound').onclick = () => embed.request('playback', {volume: context?.playback?.volume ?? .8, muted: !context?.playback?.muted}).catch(error => notice(error.message));
  window.addEventListener('pagehide', () => { void stop(); });
  return {load: embed.load, available: embed.available};
}
