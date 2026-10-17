import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Explicit files keep this design-only server out of profiles and source files.
const files = new Set([
  'roster-preview.html', 'roster-preview.js', 'roster-preview.css',
  'channel-tree.js', 'model.js', 'app.css', 'voice-icons.css',
  'assets/mark.svg', 'assets/favicon.svg', 'assets/fonts/strife-voice.woff2'
]);
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2' };
const server = createServer(async (req, res) => {
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname.slice(1) || 'roster-preview.html'; }
  catch { res.writeHead(400); res.end('Invalid request URL.'); return; }
  if (!files.has(path)) { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(new URL('../src/Strife.Desktop/wwwroot/' + path, import.meta.url));
    res.setHeader('Content-Type', types[path.split('.').at(-1)]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.end(body);
  } catch { res.writeHead(500); res.end('Preview asset unavailable.'); }
});
server.listen(Number(process.env.STRIFE_PREVIEW_PORT || 4173), '127.0.0.1', () => {
  console.log(`Voice roster preview: http://127.0.0.1:${server.address().port}/roster-preview.html`);
  console.log('Dummy data only. Press Ctrl+C to stop.');
});
