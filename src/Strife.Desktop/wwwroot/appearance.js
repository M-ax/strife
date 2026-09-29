import { renderChat } from './chat.js';
import { fallbackFonts, isLocalFont, fontCss, fontLabel, createFontCatalog, createFontPicker } from './font-picker.js';
import { parseColor, createColorPicker } from './color-picker.js';

export const appearanceDefaults = Object.freeze({
  accentColor: '#00e0bb', timestampColor: '#8fa9bf', usernameColor: '#e8b87e', linkColor: '#c7b5ff',
  chatFont: 'system', uiFont: 'system'
});

export function normalizeAppearance(value) {
  const result = { ...appearanceDefaults };
  for (const key of Object.keys(result)) {
    const candidate = value?.[key];
    if (typeof candidate !== 'string') continue;
    if (key.endsWith('Color') ? /^#[\da-f]{6}$/i.test(candidate) : Object.hasOwn(fallbackFonts, candidate) || isLocalFont(candidate))
      result[key] = key.endsWith('Color') ? candidate.toLowerCase() : candidate;
  }
  return result;
}

export function applyAppearance(value, root = document.documentElement) {
  const appearance = normalizeAppearance(value);
  for (const key of ['accentColor', 'timestampColor', 'usernameColor', 'linkColor'])
    root.style.setProperty('--' + key.replace('Color', '-color'), appearance[key]);
  root.style.setProperty('--chat-font', fontCss(appearance.chatFont));
  root.style.setProperty('--ui-font', fontCss(appearance.uiFont));
  const rgb = appearance.accentColor.slice(1).match(/../g).map(value => parseInt(value, 16));
  const linear = rgb.map(value => value / 255 <= .04045 ? value / 255 / 12.92 : ((value / 255 + .055) / 1.055) ** 2.4);
  const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  root.style.setProperty('--accent-ink', luminance > .179 ? '#101115' : '#ffffff');
  root.style.setProperty('--accent-soft', appearance.accentColor + '22');
}

export function createAppearanceSettings(save, fetchFonts) {
  const $ = id => document.getElementById(id);
  const dialog = $('appearance-dialog'), form = $('appearance-form');
  let saved = normalizeAppearance(), draft = { ...saved }, busy = false;
  const fontPicker = createFontPicker(createFontCatalog(fetchFonts), (key, value) => {
    draft[key] = value; updateFont(key); applyAppearance(draft);
  });
  const colorPicker = createColorPicker((key, value) => {
    draft[key] = value; updateColor(key); applyAppearance(draft);
  });
  function updateFont(key) {
    const button = form.querySelector(`[data-font-picker="${key}"]`);
    button.querySelector('.font-choice-name').textContent = fontLabel(draft[key]);
    button.querySelector('.font-choice-preview').style.fontFamily = fontCss(draft[key]);
  }
  function updateColor(key) {
    const input = form.elements.namedItem(key);
    input.value = draft[key].toUpperCase(); input.setCustomValidity(''); input.removeAttribute('aria-invalid');
    input.closest('.color-field').querySelector('.color-error').hidden = true;
    form.querySelector(`[data-color-picker="${key}"]`).style.backgroundColor = draft[key];
  }
  for (const key of ['chatFont', 'uiFont']) {
    form.querySelector(`[data-font-picker="${key}"]`).onclick = () => fontPicker.open(key, draft[key]);
  }
  for (const key of Object.keys(appearanceDefaults).filter(key => key.endsWith('Color'))) {
    const input = form.elements.namedItem(key), button = form.querySelector(`[data-color-picker="${key}"]`);
    input.addEventListener('input', () => {
      const value = parseColor(input.value);
      input.setCustomValidity(value ? '' : 'Enter a hex code or CSS color name.'); input.setAttribute('aria-invalid', String(!value));
      input.closest('.color-field').querySelector('.color-error').hidden = !!value;
      if (value) { draft[key] = value; button.style.backgroundColor = value; applyAppearance(draft); }
    });
    input.addEventListener('change', () => { if (parseColor(input.value)) updateColor(key); });
    button.onclick = () => { updateColor(key); colorPicker.open(key, input.getAttribute('aria-label'), draft[key]); };
  }
  const sample = '[14:32:08] (Channel) Alex: Ready when you are.\n[14:32:16] (Channel) Morgan: See you in the Lounge! https://example.com';
  renderChat($('appearance-preview'), sample, ['Alex', 'Morgan'].map(name => ({
    start: sample.indexOf(name), length: name.length, href: 'clientid://preview/' + name
  })));
  function fill(value) {
    draft = { ...value };
    for (const key of Object.keys(appearanceDefaults)) key.endsWith('Color') ? updateColor(key) : updateFont(key);
    applyAppearance(draft);
  }
  $('appearance-settings').onclick = () => {
    $('menu').open = false; $('appearance-error').hidden = true; fill(saved); dialog.showModal();
  };
  $('reset-appearance').onclick = () => fill(appearanceDefaults);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => applyAppearance(saved));
  form.onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const value = normalizeAppearance(draft); busy = true;
    $('appearance-error').hidden = true;
    form.querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
    try { await save(value); saved = value; dialog.close(); }
    catch (error) { $('appearance-error').textContent = error.message; $('appearance-error').hidden = false; }
    finally {
      busy = false;
      form.querySelectorAll('button, input, select').forEach(control => { control.disabled = false; });
    }
  };
  return {
    restore(value) { saved = normalizeAppearance(value); if (!dialog.open) applyAppearance(saved); }
  };
}
