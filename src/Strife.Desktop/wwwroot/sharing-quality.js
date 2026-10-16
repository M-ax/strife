export function supportsQuality(preset, publishing) {
  if (publishing == null) return preset.width <= 1920 && preset.height <= 1080 && preset.bitrateKbps <= 12000;
  return publishing.version === 1 && publishing.codec === 'h264' && publishing.profile === 'baseline' &&
    publishing.level === '5.2' && ['width', 'height', 'fps', 'bitrateKbps'].every(key =>
      Number.isSafeInteger(publishing[key]) && preset[key] <= publishing[key]);
}

export function qualityOptions(catalog, publishing = null) {
  if (catalog?.version !== 1 || !Array.isArray(catalog.presets) ||
      !catalog.presets.some(p => p.id === catalog.defaultPreset && p.enabled === true)) {
    throw new Error('Rebuild native sharing to use quality presets.');
  }
  return catalog.presets.map(p => ({
    ...p, disabled: p.enabled !== true || !supportsQuality(p, publishing),
    reason: p.reason || '', selected: p.id === catalog.defaultPreset,
  }));
}

export function selectedQuality(catalog, id, publishing = null) {
  const preset = qualityOptions(catalog, publishing).find(p => p.id === id && !p.disabled);
  if (!preset) throw new Error('Choose an available streaming quality preset.');
  return preset;
}

export function customQuality(catalog, value, publishing = null) {
  const resolution = catalog.presets.find(p => p.width === value.width && p.height === value.height);
  if (!resolution || ![15, 30, 60].includes(value.fps) || !Number.isInteger(value.bitrateKbps) ||
      value.bitrateKbps < 500 || value.bitrateKbps > 40000 || value.bitrateKbps % 100 ||
      !supportsQuality(value, publishing)) throw new Error('Choose supported custom resolution, FPS, and bitrate.');
  return {...value, id:'custom', label:`${resolution.resolution}${value.fps} ${value.bitrateKbps / 1000} Mbps`};
}

export function validateAudioBitrate(value, publishing = null) {
  if (![64, 96, 128, 160, 192].includes(value) ||
      (publishing?.audioBitrateKbps !== undefined && (!Number.isSafeInteger(publishing.audioBitrateKbps) ||
        value > publishing.audioBitrateKbps))) throw new Error('Choose a supported audio bitrate.');
  return value;
}
