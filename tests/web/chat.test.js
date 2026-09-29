import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatParts, chatUrl, chatImageUrl, chatMessages } from '../../src/Strife.Desktop/wwwroot/chat.js';

test('chat URLs preserve text, whitespace, query strings, Unicode and balanced punctuation', () => {
  const text = 'See (https://example.com/Path_(one)?a=1&b=2#part),\n\nwww.example.com/test. ' +
    '<HTTPS://example.org/雪> ftp://files.example.com/file; mailto:friend@example.com';
  const parts = chatParts(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.href).map(part => part.href), [
    'https://example.com/Path_(one)?a=1&b=2#part', 'https://www.example.com/test',
    'https://example.org/%E9%9B%AA', 'ftp://files.example.com/file', 'mailto:friend@example.com'
  ]);
});

test('Mumble link labels retain their targets and take precedence over automatic links', () => {
  const text = '😀 Docs and https://label.example/ then https://other.example/';
  const parts = chatParts(text, [
    { start: 3, length: 4, href: 'https://docs.example/?x=1&y=2' },
    { start: 12, length: 22, href: 'https://target.example/' }
  ]);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.href), [
    { text: 'Docs', href: 'https://docs.example/?x=1&y=2' },
    { text: 'https://label.example/', href: 'https://target.example/' },
    { text: 'https://other.example/', href: 'https://other.example/' }
  ]);
});

test('Mumble external schemes are allowed, active/local/internal URLs stay inert', () => {
  for (const url of ['mumble://voice.example/Room', 'steam://run/123', 'spotify:track:123',
    'magnet:?xt=urn:btih:123', 'gemini://example.com', 'irc://example.com/room',
    'gg:123', 'xmpp:friend@example.com', 'skype:friend?chat', 'rtmp://example.com/live'])
    assert.ok(chatUrl(url), url);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/test', 'qrc:/test',
    'clientid://id.1/test', 'channelid://id.1/test', '/relative', '//example.com',
    'https://', 'https://exa\nmple.com', ' https://example.com', 'https://example.com/\0', 'custom:run']) {
    assert.equal(chatUrl(url), null, url);
    assert.equal(chatParts('label', [{ start: 0, length: 5, href: url }])[0].href, undefined);
  }
  assert.equal(chatParts('javascript:alert(1) file:///www.example.com data:text/html,<b>hello</b>')
    .filter(part => part.href).length, 0);
});

test('malformed native link ranges never duplicate or discard log text', () => {
  const text = 'test https://example.com/';
  const parts = chatParts(text, [null, { start: -1, length: 3 }, { start: 0.5, length: 3 },
    { start: 0, length: 999 }, { start: 0, length: 0 },
    { start: 0, length: 4, href: 'https://first.example/' },
    { start: 1, length: 2, href: 'https://overlap.example/' }]);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.href).map(part => part.href),
    ['https://first.example/', 'https://example.com/']);
  assert.equal(chatParts(text, null).filter(part => part.href).length, 1);
});

const imageSrc = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('Mumble messages style timestamps and native user references without losing multiline content', () => {
  const text = '[Date changed to 2026-09-28]\n[14:32:08] (Channel) 雪😀: First line\n\nSecond line\n' +
    '[02:33:10 PM] (Private) Bob: Photo \ufffc and Guide\n[14:34:00] Connected.';
  const messages = chatMessages(text, [
    { start: text.indexOf('雪'), length: 3, href: 'clientid://id.1/test' },
    { start: text.indexOf('Bob'), length: 3, href: 'clientid://id.2/test' },
    { start: text.indexOf('Guide'), length: 5, href: 'https://example.com/' }
  ], [{ start: text.indexOf('\ufffc'), src: imageSrc }]);
  assert.equal(messages.length, 4);
  assert.equal(messages.flat().map(part => part.text).join(''), text);
  assert.deepEqual(messages.flat().filter(part => part.kind === 'timestamp').map(part => part.text),
    ['[14:32:08]', '[02:33:10 PM]', '[14:34:00]']);
  const names = messages.flat().filter(part => part.kind === 'username');
  assert.deepEqual(names.map(part => part.text), ['雪😀', 'Bob']);
  assert.ok(names.every(part => !part.href), 'native user links remain inert');
  assert.match(messages[1].map(part => part.text).join(''), /First line\n\nSecond line\n$/);
  assert.equal(messages[2].find(part => part.image).image.src, imageSrc);
  assert.equal(messages[2].find(part => part.href).href, 'https://example.com/');
});

test('truncated history, unframed text and invalid timestamps retain their original text', () => {
  for (const text of ['', 'truncated\n[14:00:00] New entry', '[99:99:99] plain\n[14:00:00]body',
    '[14:00:00] Message mentions [15:00:00] inline\ncontinuation']) {
    assert.equal(chatMessages(text).flat().map(part => part.text).join(''), text);
  }
  assert.equal(chatMessages('[99:99:99] plain\n[14:00:00]body').length, 1);
  assert.equal(chatMessages('[14:00:00] one\n[14:00:00] two').length, 2);
});

test('inline images preserve UTF-16 positions, surrounding text, and link targets', () => {
  const text = '😀 photo \ufffc\ufffc then https://example.com/\ufffc end';
  const starts = [...text.matchAll(/\ufffc/g)].map(match => match.index);
  const parts = chatParts(text, [{ start: 3, length: 8, href: 'https://photo.example/' }],
    starts.map(start => ({ start, src: imageSrc, width: 1, height: 1, alt: 'A photo' })));
  assert.equal(parts.map(part => part.text).join(''), text);
  const images = parts.filter(part => part.image);
  assert.equal(images.length, 3);
  assert.deepEqual(images.slice(0, 2).map(part => part.href), ['https://photo.example/', 'https://photo.example/']);
  assert.equal(images[2].href, undefined, 'an adjacent plain URL does not swallow an attachment');
  assert.deepEqual(images[0].image, { src: imageSrc, width: 1, height: 1, alt: 'A photo' });
});

test('image URLs accept embedded raster data and reject external or active sources', () => {
  assert.equal(chatImageUrl(imageSrc), imageSrc);
  for (const src of ['https://example.com/photo.png', 'http://127.0.0.1/private', 'file:///C:/photo.png',
    '/assets/strife.png', 'blob:https://example.com/id', 'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PHN2Zy8+',
    'data:image/png;base64,', 'data:image/png;base64,abc', 'data:image/png;base64,%%%%',
    'data:image/png;base64,AAAA\n', 'data:image/png;base64,' + 'A'.repeat(512 * 1024)]) {
    assert.equal(chatImageUrl(src), null, src.slice(0, 80));
    assert.equal(chatParts('\ufffc', [], [{ start: 0, src }])[0].image, null);
  }
});

test('missing and malformed image metadata cannot replace ordinary text or inject attributes', () => {
  const text = 'hello \ufffc\ufffc';
  const parts = chatParts(text, null, [null, { start: 0, src: imageSrc },
    { start: -1, src: imageSrc }, { start: 6.5, src: imageSrc }, { start: 99, src: imageSrc },
    { start: 6, src: imageSrc, width: -10, height: 9000, onerror: 'alert(1)' },
    { start: 6, src: imageSrc, alt: 'Duplicate' }]);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(parts[0].text, 'hello ');
  assert.deepEqual(parts[1].image, { src: imageSrc, alt: '' });
  assert.equal(parts[2].image, null);
  assert.equal(chatParts('\ufffc', [], null)[0].image, null);
});
