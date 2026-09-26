import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('desktop UI: channel events, safe chat, pane collapse, menus, and Helltube isolation', async () => {
  const video = createServer((_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Helltube fixture</h1><input placeholder="Room name">'); });
  const assets = new Map(['index.html', 'app.js', 'model.js', 'app.css'].map(name => ['/' + (name === 'index.html' ? '' : name), name]));
  const server = createServer(async (req, res) => {
    const file = assets.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(new URL('../../src/Strife.Desktop/wwwroot/' + file, import.meta.url)));
  });
  await new Promise(resolve => video.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const videoUrl = 'http://127.0.0.1:' + video.address().port;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.STRIFE_TEST_BROWSER || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ videoUrl }) => {
      if (window !== window.top) return;
      let receiver;
      window.commands = [];
      const prefs = { helltubeUrl: videoUrl, mumbleHost: 'voice.example.test', username: 'Alice', chatCollapsed: false };
      const state = { type: 'state', connected: true, session: 7, rnnoise: true, transmitMode: 2, pttBound: true, muted: false, deafened: false,
        channels: [{ id: 0, parent: -1, position: 0, name: 'Root' }, { id: 4, parent: 0, position: 0, name: 'Lounge' }],
        users: [{ id: 7, name: 'Alice', channel: 4, talking: true }] };
      window.deliver = value => receiver(JSON.stringify(value));
      window.external = {
        receiveMessage(callback) { receiver = callback; },
        sendMessage(raw) {
          const m = JSON.parse(raw); window.commands.push(m);
          queueMicrotask(() => {
            if (m.command === 'ready') window.deliver({ type: 'preferences', value: prefs });
            if (m.command === 'start') { window.deliver({ type: 'engine', ready: true }); window.deliver(state); }
            if (m.command === 'preferences') {
              if ('chatCollapsed' in m) prefs.chatCollapsed = m.chatCollapsed;
              if (m.helltubeUrl) prefs.helltubeUrl = m.helltubeUrl;
              window.deliver({ type: 'preferences', value: prefs });
            }
            window.deliver({ type: 'result', id: m.id, ok: true });
          });
        }
      };
    }, { videoUrl });
    await page.goto('http://127.0.0.1:' + server.address().port + '/#test-capability');
    await page.getByText('RNNoise · enabled').waitFor();
    await page.frameLocator('#helltube').getByRole('heading', { name: 'Helltube fixture' }).waitFor();
    assert.equal(await page.locator('.channel-user.talking').count(), 1);
    const before = await page.locator('#helltube').boundingBox();
    await page.getByRole('button', { name: 'Collapse chat', exact: true }).click();
    const after = await page.locator('#helltube').boundingBox();
    assert.ok(after.width > before.width + 200);
    await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
    await page.evaluate(() => window.deliver({ type: 'log', text: '<img src=x onerror="window.pwned=true"> unsafe server text' }));
    assert.equal(await page.locator('#chat-log img').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    await page.getByRole('button', { name: '◈  Root', exact: true }).click();
    await page.getByLabel('Message your current voice channel').fill('hello room');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('chat-message').value === '');
    await page.locator('#menu summary').click();
    await page.getByRole('button', { name: 'Voice settings & shortcuts', exact: false }).click();
    const commands = await page.evaluate(() => window.commands);
    assert.ok(commands.some(m => m.command === 'join' && m.channel === 0));
    assert.ok(commands.some(m => m.command === 'chat' && m.text === 'hello room'));
    assert.ok(commands.some(m => m.command === 'settings'));
    assert.ok(commands.every(m => m.token === 'test-capability'));
    assert.equal(await page.locator('#helltube').evaluate(frame => {
      try { return !!frame.contentWindow.document; } catch { return false; }
    }), false);
    await page.evaluate(() => window.deliver({ type: 'engine', ready: false, error: 'Fixture disconnect' }));
    assert.equal(await page.locator('#chat-message').isDisabled(), true);
    assert.equal(await page.locator('.channel-user').count(), 0);
    await page.screenshot({ path: 'artifacts/strife-ui.png' });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => video.close(resolve))]);
  }
});
