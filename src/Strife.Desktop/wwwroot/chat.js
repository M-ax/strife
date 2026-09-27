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
  for (const match of text.matchAll(/\b(?:[a-z][a-z0-9+.-]*:|www\.)[^\s<>"']+/gi)) {
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

export function chatParts(text, links = []) {
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

export function renderChat(log, text, links) {
  const document = log.ownerDocument, fragment = document.createDocumentFragment();
  for (const part of chatParts(text, links)) {
    if (!part.href) { fragment.append(document.createTextNode(part.text)); continue; }
    const anchor = document.createElement('a');
    anchor.textContent = part.text; anchor.href = part.href;
    anchor.title = part.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    fragment.append(anchor);
  }
  log.replaceChildren(fragment);
}
