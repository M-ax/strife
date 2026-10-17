import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';

test('roster preview rejects malformed URLs without stopping and serves only preview assets', { timeout: 10000 }, async t => {
  const server = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/preview-roster.mjs', import.meta.url))], {
    env: { ...process.env, STRIFE_PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => server.kill());
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Voice roster preview: (http:\/\/127\.0\.0\.1:\d+\/roster-preview\.html)/);
      if (match) resolve(new URL(match[1]));
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Preview exited with ${code}: ${errors}`)));
  });
  const malformed = await new Promise((resolve, reject) => {
    get({ hostname: url.hostname, port: url.port, path: '//' }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
  assert.equal(malformed, 400);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DESIGN LAB · DUMMY DATA/);
  const font = await fetch(new URL('assets/fonts/strife-voice.woff2', url));
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
  assert.equal((await fetch(new URL('/app.js', url))).status, 404);
  assert.equal(errors, '');
});
