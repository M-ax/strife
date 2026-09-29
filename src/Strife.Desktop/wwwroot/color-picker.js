export function parseColor(value, document = globalThis.document) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const hex = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(text)?.[1];
  if (hex) return '#' + (hex.length === 3 ? [...hex].map(c => c + c).join('') : hex).toLowerCase();
  // Resolve named sRGB colors through the browser, without inserting CSS or
  // accepting contextual keywords, functions, declarations or transparent ink.
  if (!/^[a-z]+$/i.test(text) || /^(transparent|currentcolor|inherit|initial|unset|revert|revertlayer)$/i.test(text)
    || !document?.defaultView.CSS.supports('color', text)) return null;
  const context = document.createElement('canvas').getContext('2d');
  context.fillStyle = text;
  return /^#[\da-f]{6}$/i.test(context.fillStyle) ? context.fillStyle.toLowerCase() : null;
}

export function hexToHsv(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: hue * 60, s: max ? delta / max * 100 : 0, v: max * 100 };
}

export function hsvToHex({ h, s, v }) {
  const hue = ((h % 360) + 360) % 360 / 60, saturation = Math.max(0, Math.min(100, s)) / 100;
  const value = Math.max(0, Math.min(100, v)) / 100;
  const c = value * saturation, x = c * (1 - Math.abs(hue % 2 - 1)), m = value - c;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue)];
  return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}

export function createColorPicker(onChange) {
  const $ = id => document.getElementById(id), dialog = $('color-dialog'), plane = $('color-plane');
  const input = $('color-value');
  let hsv = { h: 0, s: 0, v: 0 }, color = '#000000', original, key, accepted = false;
  function paint(updateText = true) {
    plane.style.setProperty('--hue-color', hsvToHex({ h: hsv.h, s: 100, v: 100 }));
    $('color-cursor').style.left = hsv.s + '%'; $('color-cursor').style.top = (100 - hsv.v) + '%';
    plane.setAttribute('aria-valuenow', String(Math.round(hsv.s)));
    plane.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s)}%, value ${Math.round(hsv.v)}%`);
    for (const [name, field] of [['hue', 'h'], ['saturation', 's'], ['value', 'v']]) {
      $('color-' + name + '-range').value = hsv[field];
      $('color-' + name + '-output').value = Math.round(hsv[field]) + (field === 'h' ? '°' : '%');
    }
    $('color-sample').style.backgroundColor = color;
    if (updateText) { input.value = color.toUpperCase(); input.setCustomValidity(''); input.removeAttribute('aria-invalid'); }
    $('color-input-error').hidden = true;
    $('color-copy-status').textContent = '';
  }
  function publish() { color = hsvToHex(hsv); paint(); onChange(key, color); }
  input.addEventListener('input', () => {
    const value = parseColor(input.value);
    input.setCustomValidity(value ? '' : 'Enter a hex code or CSS color name.');
    input.setAttribute('aria-invalid', String(!value)); $('color-input-error').hidden = !!value;
    if (!value) return;
    color = value;
    const next = hexToHsv(color);
    hsv = { ...next, h: next.s === 0 ? hsv.h : next.h }; paint(false); onChange(key, color);
  });
  input.addEventListener('change', () => { if (parseColor(input.value)) paint(); });
  for (const [name, field] of [['hue', 'h'], ['saturation', 's'], ['value', 'v']]) {
    $('color-' + name + '-range').addEventListener('input', event => { hsv[field] = Number(event.target.value); publish(); });
  }
  function point(event) {
    const rect = plane.getBoundingClientRect();
    hsv.s = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100));
    hsv.v = Math.max(0, Math.min(100, (1 - (event.clientY - rect.top) / rect.height) * 100)); publish();
  }
  plane.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    plane.focus(); plane.setPointerCapture(event.pointerId); point(event);
  });
  plane.addEventListener('pointermove', event => { if (plane.hasPointerCapture(event.pointerId)) point(event); });
  plane.addEventListener('pointerup', event => { if (plane.hasPointerCapture(event.pointerId)) plane.releasePointerCapture(event.pointerId); });
  plane.addEventListener('keydown', event => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') hsv.s = Math.max(0, hsv.s - step);
    else if (event.key === 'ArrowRight') hsv.s = Math.min(100, hsv.s + step);
    else if (event.key === 'ArrowDown') hsv.v = Math.max(0, hsv.v - step);
    else if (event.key === 'ArrowUp') hsv.v = Math.min(100, hsv.v + step);
    else return;
    event.preventDefault(); publish();
  });
  $('color-copy').onclick = async () => {
    const value = parseColor(input.value);
    if (!value) { input.reportValidity(); return; }
    input.value = value.toUpperCase(); input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      $('color-copy-status').textContent = 'Copied.';
    } catch { $('color-copy-status').textContent = 'Color selected. Press Ctrl+C (⌘C on Mac) to copy.'; input.focus(); input.select(); }
  };
  $('color-form').onsubmit = event => { event.preventDefault(); accepted = true; dialog.close(); };
  dialog.addEventListener('close', () => { if (!accepted) onChange(key, original); });
  return {
    open(field, label, value) {
      key = field; color = original = value; hsv = hexToHsv(value); accepted = false;
      $('color-title').textContent = label; paint(); dialog.showModal();
    }
  };
}
