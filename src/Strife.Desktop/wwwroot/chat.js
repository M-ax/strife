// External schemes accepted by Mumble's Log::allowedSchemes(). Its clientid and
// channelid links address native UI objects and are left as text in this pane.
const schemes = new Set(['mumble:', 'http:', 'https:', 'gemini:', 'ftp:', 'spotify:', 'steam:',
  'irc:', 'gg:', 'mailto:', 'xmpp:', 'skype:', 'rtmp:', 'magnet:']);

export function chatUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return schemes.has(url.protocol) ? url.href : null;
  } catch { return null; }
}

function trimUrl(value) {
  // Keep balanced parentheses in paths (e.g. Wikipedia), leaving prose outside.
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const counts = {};
  for (const char of value) if ('()[]{}'.includes(char)) counts[char] = (counts[char] || 0) + 1;
  while (value) {
    const last = value.at(-1);
    if (/[.,!?;:]/.test(last)) value = value.slice(0, -1);
    else if (pairs[last] && counts[last] > (counts[pairs[last]] || 0)) {
      counts[last]--; value = value.slice(0, -1);
    } else break;
  }
  return value;
}

function parseUrls(text) {
  const parts = [];
  let position = 0;
  for (const match of text.matchAll(/\b(?:[a-z][a-z0-9+.-]*:|www\.)[^\s<>"'\ufffc]+/gi)) {
    if (match.index && /[\w@/]/.test(text[match.index - 1])) continue;
    const label = trimUrl(match[0]);
    const href = chatUrl(/^www\./i.test(label) ? 'https://' + label : label);
    if (!href) continue;
    if (match.index > position) parts.push({ text: text.slice(position, match.index) });
    parts.push({ text: label, href });
    position = match.index + label.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position) });
  return parts;
}

function textParts(text, links) {
  const parts = [];
  let position = 0;
  // Explicit Mumble link labels take precedence over URLs found in plain text.
  for (const link of (Array.isArray(links) ? links : []).filter(link => link &&
    Number.isInteger(link.start) && Number.isInteger(link.length) && link.start >= 0 &&
    link.length > 0 && link.start + link.length <= text.length).sort((a, b) => a.start - b.start)) {
    if (link.start < position) continue;
    parts.push(...parseUrls(text.slice(position, link.start)));
    const href = chatUrl(link.href);
    parts.push({ text: text.slice(link.start, link.start + link.length), ...(href ? { href } : {}),
      ...(typeof link.href === 'string' && /^clientid:\/\//i.test(link.href) ? { kind: 'username' } : {}) });
    position = link.start + link.length;
  }
  parts.push(...parseUrls(text.slice(position)));
  return parts;
}

export function chatImageUrl(value) {
  if (typeof value !== 'string' || value.length > 512 * 1024) return null;
  // Image attachments are embedded raster data. Keep remote/local resources
  // and active formats out of the desktop shell, independently of its CSP.
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)
    && (value.length - value.indexOf(',') - 1) % 4 === 0 ? value : null;
}

export function chatParts(text, links = [], images = []) {
  const attachments = new Map();
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || !Number.isInteger(image.start) || image.start < 0 || text[image.start] !== '\ufffc'
      || attachments.has(image.start)) continue;
    const src = chatImageUrl(image.src);
    if (!src) continue;
    const dimensions = Number.isInteger(image.width) && Number.isInteger(image.height)
      && image.width > 0 && image.height > 0 && image.width <= 8192 && image.height <= 8192
      && image.width * image.height <= 16 * 1024 * 1024;
    attachments.set(image.start, { src, alt: typeof image.alt === 'string' ? image.alt.slice(0, 200) : '',
      ...(dimensions ? { width: image.width, height: image.height } : {}) });
  }
  const parts = [];
  let offset = 0;
  for (const part of textParts(text, links)) {
    let start = 0;
    for (const match of part.text.matchAll(/\ufffc/g)) {
      if (match.index > start) parts.push({ ...part, text: part.text.slice(start, match.index) });
      parts.push({ ...part, text: '\ufffc', image: attachments.get(offset + match.index) || null });
      start = match.index + 1;
    }
    if (start < part.text.length) parts.push({ ...part, text: part.text.slice(start) });
    offset += part.text.length;
  }
  return parts;
}

export function chatMessages(text, links, images) {
  // The existing native log includes Mumble's 24-hour or AM/PM timestamp at
  // each message start. Continuation lines stay with their message. All ranges
  // use the original UTF-16 text, including links and image placeholders.
  const headers = [...text.matchAll(/^\[(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?: [AP]M)?\](?=\s|$)/gm)];
  const messages = [];
  let header = 0, offset = 0, current;
  for (const part of chatParts(text, links, images)) {
    let position = 0;
    while (position < part.text.length) {
      const start = offset + position;
      if (!current || headers[header]?.index === start) {
        current = { parts: [], timestampEnd: headers[header]?.index === start ? start + headers[header++][0].length : 0 };
        messages.push(current);
      }
      const end = Math.min(offset + part.text.length, headers[header]?.index ?? Infinity,
        current.timestampEnd > start ? current.timestampEnd : Infinity);
      current.parts.push({ ...part, text: part.text.slice(position, end - offset),
        ...(start < current.timestampEnd ? { kind: 'timestamp' } : {}) });
      position = end - offset;
    }
    offset += part.text.length;
  }
  return messages.map(message => message.parts);
}

function viewChatImage(log, attachment, trigger) {
  const document = log.ownerDocument;
  const dialog = document.createElement('dialog');
  dialog.className = 'chat-image-viewer';
  dialog.setAttribute('aria-label', 'Chat image viewer');
  const toolbar = document.createElement('div'); toolbar.className = 'chat-image-toolbar';
  const title = document.createElement('strong'); title.textContent = attachment.alt || 'Chat image';
  const zoom = document.createElement('button'); zoom.type = 'button'; zoom.textContent = 'Actual size';
  zoom.setAttribute('aria-pressed', 'false');
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close image viewer'); close.autofocus = true;
  toolbar.append(title, zoom, close);
  const stage = document.createElement('div'); stage.className = 'chat-image-stage';
  const image = document.createElement('img'); image.alt = attachment.alt || 'Chat image';
  image.src = attachment.src;
  image.addEventListener('error', () => {
    stage.textContent = 'Image unavailable'; zoom.disabled = true;
  }, { once: true });
  stage.append(image); dialog.append(toolbar, stage); document.body.append(dialog);
  zoom.onclick = () => {
    const actual = stage.classList.toggle('actual-size');
    zoom.textContent = actual ? 'Fit to window' : 'Actual size';
    zoom.setAttribute('aria-pressed', String(actual));
    stage.scrollTo(0, 0);
  };
  close.onclick = () => dialog.close();
  let backdropPressed = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  dialog.addEventListener('pointerdown', event => { backdropPressed = event.target === dialog && outside(event); });
  dialog.addEventListener('click', event => {
    if (backdropPressed && event.target === dialog && outside(event)) dialog.close();
    backdropPressed = false;
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    // A log update can replace the thumbnail while the viewer is open.
    const target = trigger.isConnected ? trigger : [...log.querySelectorAll('.chat-image-button')]
      .find(button => button.querySelector('img')?.src === attachment.src);
    if (target) target.focus({ preventScroll: true });
    else { log.tabIndex = -1; log.focus({ preventScroll: true }); }
  }, { once: true });
  dialog.showModal();
}

export function renderChat(log, text, links, images) {
  const document = log.ownerDocument, fragment = document.createDocumentFragment();
  for (const parts of chatMessages(text, links, images)) {
    const row = document.createElement('div'); row.className = 'chat-entry';
    for (const part of parts) {
      let content;
      if (part.image) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'chat-image-button';
        button.setAttribute('aria-label', 'View image: ' + (part.image.alt || 'Chat image'));
        button.setAttribute('aria-haspopup', 'dialog'); button.title = 'View image';
        const image = document.createElement('img');
        image.alt = part.image.alt || 'Chat image';
        if (part.image.width) { image.width = part.image.width; image.height = part.image.height; }
        image.addEventListener('error', () => {
          button.replaceWith(document.createTextNode('[' + (part.image.alt || 'Image unavailable') + ']'));
        }, { once: true });
        image.src = part.image.src; button.append(image);
        button.onclick = () => viewChatImage(log, part.image, button);
        row.append(button);
        if (!part.href) continue;
        content = document.createTextNode('Open image link');
      } else content = document.createTextNode(part.image === null ? '[Image unavailable]' : part.text);
      if (part.kind) {
        const span = document.createElement('span'); span.className = 'chat-' + part.kind;
        span.append(content); content = span;
      }
      if (!part.href) { row.append(content); continue; }
      const anchor = document.createElement('a');
      anchor.append(content); anchor.href = part.href;
      anchor.title = part.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      row.append(anchor);
    }
    fragment.append(row);
  }
  log.replaceChildren(fragment);
}
