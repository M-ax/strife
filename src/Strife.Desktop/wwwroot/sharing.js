import {createHelltubeEmbed} from './helltube-embed.js';
import {qualityOptions, selectedQuality, customQuality, validateAudioBitrate} from './sharing-quality.js';
import {filterSources, resolveAudio} from './sharing-selection.js';

export function createSharing({request, notice}) {
  const $ = id => document.getElementById(id);
  let share = null, phase = 'idle', context = null, timer = null;
  let quality = null, publishing = null;
  let sources = [], audioTargets = [];
  let previewEpoch = 0, previewTimer = null, previewWork = Promise.resolve(), previewBusy = false, thumbnailPage = 0;
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
    cancelPreview();
    $('sharing-thumbnails').replaceChildren();
    const old = share; share = null; phase = 'idle'; clearTimeout(timer);
    if (old) embed.status(old.id, error ? 'error' : 'idle', error);
    if ($('sharing-dialog').open) $('sharing-dialog').close();
    showStatus('');
    await request('streamStop').catch(() => {});
    if (error) notice(error);
  }
  async function choose(value) {
    cancelPreview(); thumbnailPage = 0;
    share = value; phase = 'choosing';
    $('sharing-room').textContent = value.roomName;
    $('sharing-sources').replaceChildren(new Option('Finding windows and displays…', ''));
    quality = null;
    $('sharing-quality').replaceChildren(new Option('Loading quality presets…', ''));
    $('sharing-start').disabled = true; $('sharing-audio').checked = false;
    sources = []; audioTargets = [];
    $('sharing-audio-mode').value = 'automatic';
    $('sharing-audio-target').replaceChildren(new Option('Choose audio…', ''));
    $('sharing-audio-scope').textContent = 'No audio';
    $('sharing-search').value = '';
    $('sharing-refresh').disabled = true;
    $('sharing-error').textContent = '';
    $('sharing-dialog').showModal(); showStatus('Choosing a screen for ' + value.roomName);
    try {
      const [result, capabilities] = await Promise.all([
        request('streamSources', {shareId: value.id}),
        embed.request('capabilities').catch(() => null),
      ]);
      if (share !== value || !embed.isCurrent(value.id)) return;
      sources = result.value.sources; audioTargets = result.value.audioTargets;
      quality = result.value.quality;
      publishing = capabilities?.publishing ?? null;
      $('sharing-quality').replaceChildren(...qualityOptions(quality, publishing).map(p => {
        const option = new Option(p.label + (p.disabled ? ' — unavailable' : ''), p.id, p.selected, p.selected);
        option.disabled = p.disabled; option.title = p.reason;
        return option;
      }));
      $('sharing-quality').append(new Option('Custom…', 'custom'));
      $('sharing-custom').hidden = true;
      $('sharing-encoder').replaceChildren(...result.value.encoders.map(e => {
        const option = new Option(e.name + (e.available ? '' : ' — unavailable'), e.id, e.id === 'obs_x264', e.id === 'obs_x264');
        option.disabled = !e.available; return option;
      }));
      $('sharing-kind').value = sources.some(s => s.kind === 'screen') ? 'screen' : 'window';
      $('sharing-audio-target').replaceChildren(new Option('Choose audio…', ''),
        ...audioTargets.map(t => new Option(t.name, t.id)));
      $('sharing-refresh').disabled = false;
      renderSources();
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
      $('sharing-audio-meter').value = result.audioLevelDb ?? -60;
      embed.status(value.id, phase);
      showStatus((phase === 'streaming' ? 'Sharing to ' : 'Connecting to ') + value.roomName +
        (value.summary ? ' · ' + value.summary : '') + (result.audioWarning ? ' · ' + result.audioWarning : ''));
      timer = setTimeout(() => void poll(value), 1000);
    } catch (error) { if (share === value) await stop(error.message); }
  }
  $('sharing-form').onsubmit = async event => {
    event.preventDefault();
    const value = share;
    if (!value || phase !== 'choosing' || !embed.isCurrent(value.id)) return;
    phase = 'starting'; $('sharing-start').disabled = true;
    cancelPreview();
    embed.status(value.id, 'starting');
    try {
      // Snapshot before awaiting credentials; later UI edits cannot retarget this start.
      const preset = chosenQuality();
      const sourceId = $('sharing-sources').value, audio = currentAudio();
      const settings = selectionSettings(preset, audio, sourceId);
      await previewWork;
      const preflight = (await request('streamPreview', settings)).value;
      if (preflight.status !== 'preview') throw new Error('The selected source is no longer available.');
      if (share !== value || !embed.isCurrent(value.id)) return;
      const result = await embed.request('credential', {shareId: value.id});
      if (share !== value || !embed.isCurrent(value.id)) return;
      if (result.credential?.roomId !== value.roomId) throw new Error('The publishing room changed. Choose Share desktop again.');
      if (preset.id === 'custom') customQuality(quality, preset, result.credential.publishing ?? null);
      else selectedQuality(quality, preset.id, result.credential.publishing ?? null);
      await request('streamStart', {...settings, credential: result.credential});
      if (share !== value || !embed.isCurrent(value.id)) return;
      value.summary = `${preflight.quality.width}×${preflight.quality.height} ${preset.fps} fps · ${preset.bitrateKbps / 1000} Mbps · ${audio.name}`;
      $('sharing-dialog').close(); embed.status(value.id, 'starting');
      showStatus('Connecting to ' + value.roomName); void poll(value);
    } catch (error) { if (share === value) await stop(error.message); }
  };
  function currentAudio() {
    return resolveAudio(sources, audioTargets, $('sharing-sources').value, $('sharing-audio').checked,
      $('sharing-audio-mode').value, $('sharing-audio-target').value);
  }
  function chosenQuality() {
    if ($('sharing-quality').value !== 'custom') return selectedQuality(quality, $('sharing-quality').value, publishing);
    const [width, height] = $('sharing-resolution').value.split('x').map(Number);
    return customQuality(quality, {width, height, fps:Number($('sharing-fps').value),
      bitrateKbps:Number($('sharing-bitrate').value)}, publishing);
  }
  function selectionSettings(preset = chosenQuality(), audio = currentAudio(), sourceId = $('sharing-sources').value) {
    if (!sources.some(source => source.id === sourceId)) throw new Error('Choose a screen or window.');
    return {shareId:share.id, sourceId, audioId:audio.id, qualityId:preset.id,
      customQuality:preset.id === 'custom' ? {width:preset.width,height:preset.height,fps:preset.fps,bitrateKbps:preset.bitrateKbps} : null,
      publishing, audioBitrateKbps:validateAudioBitrate(Number($('sharing-audio-bitrate').value), publishing),
      encoderId:$('sharing-encoder').value};
  }
  function cancelPreview() {
    previewEpoch++; clearTimeout(previewTimer);
    $('sharing-preview-image').hidden = true;
    $('sharing-preview-image').removeAttribute('src');
    $('sharing-audio-meter').value = -60;
  }
  function checkImage(image) {
    if (typeof image !== 'string' || image.length > 256 * 1024 || !/^data:image\/bmp;base64,[A-Za-z0-9+/]+=*$/.test(image))
      throw new Error('Invalid native preview image.');
    return image;
  }
  function schedulePreview() {
    cancelPreview();
    const epoch = previewEpoch;
    $('sharing-start').disabled = true;
    async function tick() {
      if (epoch !== previewEpoch || phase !== 'choosing' || !share) return;
      if (previewBusy) { previewTimer = setTimeout(tick, 100); return; }
      let settings;
      try { settings = selectionSettings(); } catch { return; }
      previewBusy = true;
      previewWork = (async () => {
        try {
          const result = (await request('streamPreview', settings)).value;
          if (epoch !== previewEpoch || phase !== 'choosing') return;
          if (result.status !== 'preview') throw new Error('The selected source is no longer available.');
          $('sharing-preview-image').src = checkImage(result.image);
          $('sharing-preview-image').hidden = false;
          $('sharing-preview-description').textContent = `Local preview · ${result.quality.width}×${result.quality.height} at ${result.quality.fps} fps · nothing published`;
          $('sharing-audio-meter').value = result.audioLevelDb ?? -60;
          $('sharing-error').textContent = result.audioWarning || '';
          $('sharing-start').disabled = !!result.audioWarning;
          previewTimer = setTimeout(tick, 500);
        } catch (error) {
          if (epoch === previewEpoch) {
            $('sharing-preview-description').textContent = error.message;
            $('sharing-start').disabled = true;
          }
        } finally { previewBusy = false; }
      })();
      await previewWork;
    }
    previewTimer = setTimeout(tick, 200);
  }
  function updateAudio() {
    $('sharing-custom').hidden = $('sharing-quality').value !== 'custom';
    $('sharing-audio-mode').disabled = !$('sharing-audio').checked;
    $('sharing-audio-target').disabled = !$('sharing-audio').checked || $('sharing-audio-mode').value !== 'manual';
    try {
      const target = currentAudio();
      $('sharing-audio-scope').textContent = target.name + (target.kind === 'system' ? ' — includes all audio on this output.' :
        target.kind === 'application' ? ' — includes this application’s process tree, not just this window.' : '');
      selectionSettings();
      if (phase === 'choosing' && $('sharing-sources').value) schedulePreview();
    } catch (error) {
      $('sharing-audio-scope').textContent = error.message;
      $('sharing-start').disabled = true;
      cancelPreview();
      if (share && phase === 'choosing') void request('streamPreviewStop', {shareId:share.id}).catch(() => {});
    }
  }
  function renderSources() {
    const previous = $('sharing-sources').value;
    const filtered = filterSources(sources, $('sharing-kind').value, $('sharing-search').value);
    $('sharing-sources').replaceChildren(...filtered.map(s => new Option(s.name, s.id)));
    $('sharing-error').textContent = filtered.length ? '' : 'No sources match this selection. Change the filter or refresh sources.';
    if (filtered.some(s => s.id === previous)) $('sharing-sources').value = previous;
    // A manual choice must be confirmed again when the video selection changes.
    if ($('sharing-sources').value !== previous) $('sharing-audio-target').value = '';
    updateAudio();
    renderThumbnails();
  }
  function renderThumbnails() {
    const filtered = filterSources(sources, $('sharing-kind').value, $('sharing-search').value);
    thumbnailPage = Math.min(thumbnailPage, Math.max(0, Math.ceil(filtered.length / 6) - 1));
    $('sharing-thumbnails-prev').disabled = thumbnailPage === 0;
    $('sharing-thumbnails-next').disabled = (thumbnailPage + 1) * 6 >= filtered.length;
    $('sharing-thumbnails').replaceChildren(...filtered.slice(thumbnailPage * 6, thumbnailPage * 6 + 6).map(source => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.sourceId = source.id;
      const image = document.createElement('img'); image.alt = ''; image.hidden = true;
      const name = document.createElement('span'); name.textContent = source.name;
      button.append(image, name);
      button.onclick = () => { $('sharing-sources').value = source.id; $('sharing-audio-target').value = ''; updateAudio(); };
      return button;
    }));
  }
  $('sharing-thumbnails-prev').onclick = () => { thumbnailPage--; renderThumbnails(); };
  $('sharing-thumbnails-next').onclick = () => { thumbnailPage++; renderThumbnails(); };
  $('sharing-thumbnails-load').onclick = async () => {
    if (phase !== 'choosing' || !share) return;
    cancelPreview(); const epoch = previewEpoch; const value = share;
    $('sharing-start').disabled = true;
    await previewWork;
    for (const button of $('sharing-thumbnails').children) {
      if (epoch !== previewEpoch || phase !== 'choosing' || share !== value) return;
      try {
        const result = (await request('streamThumbnail', {shareId:value.id, sourceId:button.dataset.sourceId,
          audioId:'', qualityId:'480p30', encoderId:'obs_x264', audioBitrateKbps:128})).value;
        if (epoch !== previewEpoch || !button.isConnected) return;
        button.querySelector('img').src = checkImage(result.image); button.querySelector('img').hidden = false;
      } catch { button.title = 'Thumbnail unavailable; select to retry the live preview.'; }
    }
    if (epoch === previewEpoch && share === value) schedulePreview();
  };
  $('sharing-kind').onchange = renderSources;
  $('sharing-search').oninput = renderSources;
  $('sharing-sources').onchange = () => { $('sharing-audio-target').value = ''; updateAudio(); };
  for (const id of ['sharing-audio', 'sharing-audio-mode', 'sharing-audio-target', 'sharing-quality',
    'sharing-resolution', 'sharing-fps', 'sharing-bitrate', 'sharing-audio-bitrate', 'sharing-encoder']) $(id).onchange = updateAudio;
  $('sharing-refresh').onclick = async () => {
    if (!share || phase !== 'choosing' || $('sharing-refresh').disabled) return;
    const value = share;
    $('sharing-dialog').close();
    await choose(value);
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
