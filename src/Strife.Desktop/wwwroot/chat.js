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
    parts.push({ text: text.slice(link.start, link.start + link.length), ...(href ? { href } : {}) });
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

export function renderChat(log, text, links, images) {
  const document = log.ownerDocument, fragment = document.createDocumentFragment();
  for (const part of chatParts(text, links, images)) {
    let content;
    if (part.image) {
      content = document.createElement('img');
      content.alt = part.image.alt || 'Chat image';
      if (part.image.width) { content.width = part.image.width; content.height = part.image.height; }
      content.addEventListener('error', () => {
        content.replaceWith(document.createTextNode('[' + (part.image.alt || 'Image unavailable') + ']'));
      }, { once: true });
      content.src = part.image.src;
    } else content = document.createTextNode(part.image === null ? '[Image unavailable]' : part.text);
    if (!part.href) { fragment.append(content); continue; }
    const anchor = document.createElement('a');
    anchor.append(content); anchor.href = part.href;
    anchor.title = part.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    fragment.append(anchor);
  }
  log.replaceChildren(fragment);
}
