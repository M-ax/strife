export function filterSources(sources, kind, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return sources.filter(source => source.kind === kind && source.name.toLocaleLowerCase().includes(needle));
}

export function resolveAudio(sources, targets, sourceId, enabled, mode, manualId) {
  if (!enabled) return {id: '', name: 'No audio', kind: 'none'};
  const source = sources.find(s => s.id === sourceId);
  if (!source) throw new Error('Choose a screen or window first.');
  if (!['automatic', 'manual'].includes(mode)) throw new Error('Choose an audio selection mode.');
  const id = mode === 'automatic' ? source.automaticAudioId : manualId;
  const target = targets.find(t => t.id === id);
  if (!target) throw new Error(mode === 'automatic'
    ? 'Automatic audio is unavailable for this source. Select audio manually or disable audio.'
    : 'Choose an audio application or playback output, or disable audio.');
  return target;
}
