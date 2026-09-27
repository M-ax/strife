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
      const prefs = JSON.parse(localStorage.getItem('fixture-preferences')) || { helltubeUrl: videoUrl, mumbleHost: 'voice.example.test', mumblePort: 64738, username: 'Alice', chatCollapsed: false };
      const state = { type: 'state', connected: true, session: 7, rnnoise: true, transmitMode: 2, pttBound: true, muted: false, deafened: false,
        channels: [{ id: 0, parent: -1, position: 0, name: 'Root' }, { id: 4, parent: 0, position: 0, name: 'Lounge' }],
        users: [{ id: 7, name: 'Alice', channel: 4, talking: true }] };
      window.deliver = value => receiver(JSON.stringify(value));
      window.external = {
        receiveMessage(callback) { receiver = callback; },
        sendMessage(raw) {
          const m = JSON.parse(raw); window.commands.push(m);
          if (m.token !== 'test-capability') return;
          queueMicrotask(() => {
            if (m.command === 'ready') {
              window.deliver({ type: 'preferences', value: prefs, videoUrl: prefs.helltubeUrl });
              window.deliver(state); window.deliver({ type: 'engine', ready: true });
            }
            if (m.command === 'start') { window.deliver({ type: 'engine', ready: true }); window.deliver(state); }
            if (m.command === 'preferences') {
              if ('chatCollapsed' in m) prefs.chatCollapsed = m.chatCollapsed;
              if (m.helltubeUrl) prefs.helltubeUrl = m.helltubeUrl;
              localStorage.setItem('fixture-preferences', JSON.stringify(prefs));
              window.deliver({ type: 'preferences', value: prefs, videoUrl: prefs.helltubeUrl });
            }
            if (m.command === 'disconnect') { state.connected = false; window.deliver(state); }
            if (m.command === 'connect') {
              Object.assign(prefs, { mumbleHost: m.host.trim(), mumblePort: m.port, username: m.username.trim() });
              localStorage.setItem('fixture-preferences', JSON.stringify(prefs));
              window.deliver({ type: 'preferences', value: prefs });
              state.connected = true; window.deliver(state);
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
    const savedVideo = videoUrl + '/watch?room=lounge#player';
    await page.locator('#video-settings').click();
    await page.locator('#helltube-url').fill(savedVideo);
    await page.locator('#video-form button[type="submit"]').click();
    await page.frameLocator('#helltube').getByPlaceholder('Room name').fill('Keep this iframe');
    await page.locator('#disconnect-button').click();
    await page.locator('#connect-button').click();
    await page.locator('#host').fill('saved.voice.test');
    await page.locator('#port').fill('64739');
    await page.locator('#username').fill('SavedUser');
    await page.locator('#password').fill('not-saved');
    await page.locator('#submit-connect').click();
    await page.waitForFunction(() => !document.getElementById('connect-dialog').open);
    assert.equal(await page.frameLocator('#helltube').getByPlaceholder('Room name').inputValue(), 'Keep this iframe');
    await page.locator('#collapse-chat').click();
    await page.reload();
    await page.waitForFunction(() => document.getElementById('engine-label').textContent === 'Voice engine ready');
    await page.frameLocator('#helltube').getByRole('heading', { name: 'Helltube fixture' }).waitFor();
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#server-name').textContent(), 'saved.voice.test');
    assert.equal(await page.locator('#chat-message').isDisabled(), false);
    assert.equal(await page.locator('.channel-user.talking').count(), 1);
    assert.equal(await page.locator('#expand-chat').isVisible(), true);
    assert.equal(await page.locator('#helltube').getAttribute('src'), savedVideo);
    assert.ok((await page.evaluate(() => window.commands)).every(m => m.token === 'test-capability'));
    assert.ok(!(await page.evaluate(() => window.commands)).some(m => m.command === 'connect' || m.command === 'start'));
    await page.locator('#disconnect-button').click();
    await page.locator('#connect-button').click();
    assert.equal(await page.locator('#host').inputValue(), 'saved.voice.test');
    assert.equal(await page.locator('#port').inputValue(), '64739');
    assert.equal(await page.locator('#username').inputValue(), 'SavedUser');
    assert.equal(await page.locator('#password').inputValue(), '');
    await page.locator('#connect-dialog button.close-dialog').last().click();
    await page.locator('#video-settings').click();
    assert.equal(await page.locator('#helltube-url').inputValue(), savedVideo);
    await page.locator('#video-dialog button.close-dialog').last().click();
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
