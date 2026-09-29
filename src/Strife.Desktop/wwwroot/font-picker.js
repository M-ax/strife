export const fallbackFonts = Object.freeze({
  system: ['System default', '"Segoe UI", system-ui, sans-serif'],
  sans: ['Sans serif', 'Arial, Helvetica, sans-serif'],
  verdana: ['Sans serif (Verdana)', 'Verdana, Geneva, sans-serif'],
  trebuchet: ['Sans serif (Trebuchet MS)', '"Trebuchet MS", sans-serif'],
  serif: ['Serif (Georgia)', 'Georgia, "Times New Roman", serif'],
  mono: ['Monospace', 'Consolas, "SFMono-Regular", "Liberation Mono", monospace'],
  courier: ['Monospace (Courier New)', '"Courier New", Courier, monospace']
});
export function isLocalFont(value) {
  return typeof value === 'string' && value.startsWith('local:') && value.length > 6 && value.length <= 262
    && !!value.slice(6).trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
export function fontLabel(value) { return isLocalFont(value) ? value.slice(6) : fallbackFonts[value]?.[0] || fallbackFonts.system[0]; }
export function fontCss(value) {
  // A single quoted CSS family, never a user-supplied CSS font stack.
  return isLocalFont(value) ? '"' + value.slice(6).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", system-ui, sans-serif'
    : fallbackFonts[value]?.[1] || fallbackFonts.system[1];
}

export function createFontCatalog(fetchBatch) {
  const fonts = Object.entries(fallbackFonts).map(([value, [name]]) => ({ value, name }));
  const seen = new Set(), listeners = new Set();
  let loading = false, started = false, error = '', browserFonts, browserAccessPending = false;
  const notify = () => listeners.forEach(listener => listener());
  async function browserBatch(offset) {
    if (!window.queryLocalFonts) throw new Error('Open Strife’s desktop app to browse all installed fonts.');
    if (!browserFonts) {
      browserAccessPending = true; notify();
      try { browserFonts = await window.queryLocalFonts(); }
      catch (e) {
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError')
          throw new Error('The preview browser did not allow access to installed fonts. Allow local font access in the browser and retry, or use the desktop app.');
        throw e;
      } finally { browserAccessPending = false; }
    }
    return { families: browserFonts.slice(offset, offset + 32).map(font => font.family), next: Math.min(offset + 32, browserFonts.length),
      complete: offset + 32 >= browserFonts.length };
  }
  return {
    fonts,
    get loading() { return loading; },
    get error() { return error; },
    get browserAccessPending() { return browserAccessPending; },
    get canRetry() { return !fetchBatch && !loading && !!error && typeof globalThis.window?.queryLocalFonts === 'function'; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async start() {
      if (started && !this.canRetry) return;
      started = loading = true; error = ''; notify();
      try {
        let offset = 0;
        while (true) {
          const batch = await (fetchBatch || browserBatch)(offset);
          for (const name of batch.families) {
            if (!isLocalFont('local:' + name) || seen.has(name.toLocaleLowerCase())) continue;
            seen.add(name.toLocaleLowerCase()); fonts.push({ name, value: 'local:' + name });
          }
          offset = batch.next; notify();
          if (batch.complete) { if (batch.error) throw new Error(batch.error); break; }
          // Yield between batches so discovery and previews cannot block the dialog.
          await new Promise(resolve => setTimeout(resolve, batch.families.length ? 16 : 100));
        }
      } catch (e) { error = e.message || 'System fonts could not be loaded.'; }
      finally { loading = false; notify(); }
    }
  };
}

export function createFontPicker(catalog, select) {
  const $ = id => document.getElementById(id), dialog = $('font-dialog'), list = $('font-results'), search = $('font-search');
  let field, current, consumed = 0, query = '', count = 0;
  function append(fonts) {
    const fragment = document.createDocumentFragment();
    for (const font of fonts) {
      if (!font.name.toLocaleLowerCase().includes(query)) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'font-option';
      button.dataset.font = font.value; button.setAttribute('aria-pressed', String(font.value === current));
      button.setAttribute('aria-label', font.name);
      const name = document.createElement('span'); name.className = 'font-name'; name.textContent = font.name;
      const preview = document.createElement('span'); preview.className = 'font-preview';
      preview.style.fontFamily = fontCss(font.value); preview.textContent = 'The quick brown fox · Aa Bb 0123456789'; preview.setAttribute('aria-hidden', 'true');
      button.append(name, preview);
      button.onclick = () => { select(field, font.value); dialog.close(); };
      fragment.append(button); count++;
    }
    list.append(fragment);
  }
  function status() {
    list.setAttribute('aria-busy', String(catalog.loading));
    $('font-spinner').hidden = !catalog.loading;
    $('font-progress').textContent = `${count} ${count === 1 ? 'font' : 'fonts'}${catalog.loading
      ? catalog.browserAccessPending ? ' · Waiting for browser font permission…' : ' · Loading system fonts…' : ''}`;
    $('font-browser-hint').hidden = !catalog.browserAccessPending;
    $('font-retry').hidden = !catalog.canRetry;
    $('font-empty').hidden = count > 0;
    $('font-empty').textContent = catalog.loading ? 'No matches yet. More fonts are loading…' : 'No fonts match your search.';
    $('font-error').textContent = catalog.error; $('font-error').hidden = !catalog.error;
  }
  function rebuild(sort) {
    count = 0; list.replaceChildren(); consumed = catalog.fonts.length;
    const fonts = [...catalog.fonts];
    if (isLocalFont(current) && !fonts.some(font => font.value === current)) fonts.unshift({ value: current, name: fontLabel(current) });
    if (sort) fonts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    append(fonts); list.scrollTop = 0; status();
  }
  search.addEventListener('input', () => { query = search.value.trim().toLocaleLowerCase(); rebuild(true); });
  $('font-retry').onclick = () => { void catalog.start(); };
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
  });
  catalog.subscribe(() => {
    if (!dialog.open) return;
    // Never reshuffle existing rows as batches arrive, even during a search.
    append(catalog.fonts.slice(consumed).filter(font => font.value !== current || !list.querySelector('[aria-pressed="true"]')));
    consumed = catalog.fonts.length; status();
  });
  list.addEventListener('keydown', event => {
    const buttons = [...list.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = buttons[Math.min(index + 1, buttons.length - 1)];
    else if (event.key === 'ArrowUp') next = buttons[Math.max(index - 1, 0)];
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons.at(-1);
    if (next) { event.preventDefault(); next.focus(); }
  });
  return {
    open(key, value) {
      field = key; current = value; search.value = query = '';
      $('font-title').textContent = key === 'chatFont' ? 'Choose chat font' : 'Choose UI font';
      dialog.showModal(); rebuild(false); search.focus(); void catalog.start();
    }
  };
}
