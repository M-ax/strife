import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

async function checkNativeDialogs(page, hostPid) {
  const probe = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('tests/windows/dialog-probe.ps1'), '-HostProcessId', String(hostPid)], { windowsHide: true });
  const lines = createInterface({ input: probe.stdout })[Symbol.asyncIterator]();
  let errors = '';
  probe.stderr.on('data', chunk => errors += chunk);
  probe.stdin.on('error', error => errors += error.message);
  async function read() {
    let timer;
    try {
      const line = await Promise.race([lines.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Window probe timed out: ' + errors)), 10000);
      })]);
      assert.equal(line.done, false, 'Window probe exited: ' + errors);
      return JSON.parse(line.value);
    } finally { clearTimeout(timer); }
  }
  async function command(command, handle) {
    probe.stdin.write(JSON.stringify({ command, handle }) + '\n');
    return read();
  }
  try {
    assert.equal((await read()).ready, true);
    const initial = await command('inspect');
    const main = initial.windows.find(window => window.Title === 'Mumble');
    assert.ok(main, 'hidden Mumble main window exists: ' + JSON.stringify(initial));
    assert.equal(main.Visible, false);
    const host = initial.host.find(window => window.Title === 'Strife' && window.Visible);
    assert.ok(host, 'Strife main window exists: ' + JSON.stringify(initial));
    for (const action of ['accept', 'cancel', 'accept']) {
      await command('foreground');
      await delay(200);
      const activeHost = await command('inspect');
      assert.equal(activeHost.foreground, host.Handle, 'test starts with Strife in the foreground');
      await page.locator('button[aria-label="Voice settings"]').click();
      let settings, snapshot;
      for (let attempt = 0; attempt < 100; attempt++) {
        snapshot = await command('inspect');
        settings = snapshot.windows.find(window => window.Visible && /configuration/i.test(window.Title));
        if (settings && settings.Handle === snapshot.foreground && settings.Owner === host.Handle) break;
        await delay(50);
      }
      assert.ok(settings, 'Mumble settings opened: ' + JSON.stringify(snapshot));
      assert.equal(settings.Owner, host.Handle, 'settings are owned by Strife');
      assert.equal(snapshot.foreground, settings.Handle, 'settings receive foreground focus');
      assert.equal(snapshot.windows.find(window => window.Handle === main.Handle)?.Visible, false);
      await command(action, settings.Handle);
      for (let attempt = 0; attempt < 100; attempt++) {
        snapshot = await command('inspect');
        if (!snapshot.windows.some(window => window.Handle === settings.Handle && window.Visible)) break;
        await delay(50);
      }
      assert.ok(!snapshot.windows.some(window => window.Handle === settings.Handle && window.Visible),
        'settings close on ' + action);
      // Catch the deferred upstream showRaiseWindow(), not just the immediate close.
      await delay(400);
      snapshot = await command('inspect');
      assert.equal(snapshot.windows.find(window => window.Handle === main.Handle)?.Visible, false,
        'Mumble stays hidden after ' + action);
      assert.ok(!snapshot.shown.includes(main.Handle), 'Mumble never flashes during ' + action);
    }
  } finally {
    if (!probe.stdin.destroyed) probe.stdin.end('{"command":"quit"}\n');
    if (probe.exitCode === null) {
      await Promise.race([new Promise(resolve => probe.once('exit', resolve)), delay(2000)]);
      if (probe.exitCode === null) probe.kill();
    }
  }
}

test('real PhotinoX, native voice engine and Helltube sign-in in one window', { timeout: 90000 }, async t => {
  const checkout = process.env.HELLTUBE_SOURCE || 'C:/Users/Max/WebstormProjects/helltube';
  const { createApp } = await import(pathToFileURL(path.join(checkout, 'server/app.js')));
  const directory = await mkdtemp(path.resolve('artifacts/desktop-test-'));
  const helltube = await createApp({ dataDir: path.join(directory, 'helltube'), port: 0, desktopPort: 0,
    ffmpeg: 'missing-test-ffmpeg', ytdlp: 'missing-test-ytdlp' });
  const videoUrl = await helltube.listen(0);
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  await writeFile(path.join(directory, 'preferences.json'), JSON.stringify({ helltubeUrl: videoUrl, mumbleHost: '', mumblePort: 64738, username: '', chatCollapsed: false }));
  await writeFile(path.join(directory, 'mumble-settings.json'), JSON.stringify({ settings_version: 1, mumble_has_quit_normally: true, audio: { transmit_mode: 'PTT' } }));
  const app = spawn(path.resolve(process.env.STRIFE_DESKTOP_EXE || 'src/Strife.Desktop/bin/Release/net10.0/Strife.exe'), [], {
    windowsHide: false, env: { ...process.env, STRIFE_PROFILE: directory,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }
  });
  let output = ''; app.stdout.on('data', chunk => output += chunk); app.stderr.on('data', chunk => output += chunk);
  let browser, page;
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) throw new Error('PhotinoX exited: ' + output);
      try { const response = await fetch('http://127.0.0.1:' + port + '/json/version'); if (response.ok) break; } catch {}
      await delay(200);
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const context = browser.contexts()[0];
    for (let i = 0; i < 100; i++) {
      page = context.pages().find(page => page.url().startsWith('http://127.0.0.1:'));
      if (page) break;
      await delay(100);
    }
    assert.ok(page, 'PhotinoX WebView page exists');
    await page.getByText('RNNoise · enabled').waitFor({ timeout: 40000 });
    assert.equal(await page.locator('#engine-label').textContent(), 'Voice engine ready');
    await t.test('native dialog foreground and ownership', () => checkNativeDialogs(page, app.pid));
    const frame = page.frameLocator('#helltube');
    await frame.getByLabel('Username', { exact: true }).fill('admin');
    await frame.getByLabel('Password', { exact: true }).fill('garbageTime_');
    await frame.getByRole('button', { name: 'Enter Helltube' }).click();
    await frame.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button', { name: /^The living room(?: |$)/ }).click();
    await frame.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    const before = await page.locator('#helltube').boundingBox();
    await page.getByRole('button', { name: 'Collapse chat', exact: true }).click();
    assert.ok((await page.locator('#helltube').boundingBox()).width > before.width + 200);
    await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
    await page.getByRole('button', { name: '♩ Mute', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('mute-button').getAttribute('aria-pressed') === 'true');
    const embeddedUrl = await page.locator('#helltube').getAttribute('src');
    // CDP key events do not invoke WebView2's native F5 accelerator.
    await page.reload();
    await page.waitForFunction(() => document.getElementById('engine-label').textContent === 'Voice engine ready');
    await page.waitForFunction(() => document.getElementById('mute-button').getAttribute('aria-pressed') === 'true');
    await frame.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    assert.equal(await page.locator('#helltube').getAttribute('src'), embeddedUrl);
    await page.locator('#video-settings').click();
    assert.equal(await page.locator('#helltube-url').inputValue(), new URL(videoUrl).href);
    await page.locator('#video-dialog button.close-dialog').last().click();
    // A second refresh catches capabilities accidentally retained for only one load.
    await page.reload();
    await page.waitForFunction(() => document.getElementById('engine-label').textContent === 'Voice engine ready');
    await frame.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    await t.test('Mumble import restarts voice and preserves Helltube', async () => {
      const importDirectory = await mkdtemp(path.resolve('artifacts/mumble-import-test-'));
      const importFile = path.join(importDirectory, 'mumble_settings.json');
      const importContents = JSON.stringify({ settings_version: 1, audio: { transmit_mode: 'PTT', noise_cancel_mode: 'Off' } });
      await writeFile(importFile, importContents);
      await page.locator('#menu summary').click();
      await page.locator('#import-mumble').click();
      await page.waitForFunction(() => !document.getElementById('review-import').disabled);
      await page.locator('#import-settings-source').fill(importFile);
      await page.locator('#import-database-source').fill('');
      await page.locator('#review-import').click();
      await page.locator('#apply-import').waitFor();
      assert.equal(await page.locator('#import-identity').isDisabled(), true);
      assert.equal(await page.locator('#import-database').isDisabled(), true);
      await page.locator('#apply-import').click();
      await page.waitForFunction(() => !document.getElementById('import-dialog').open);
      await page.getByText('RNNoise · disabled in settings').waitFor();
      assert.match(await page.locator('#notice-text').textContent(), /Mumble import complete/);
      assert.equal(await readFile(importFile, 'utf8'), importContents);
      assert.equal(await page.locator('#helltube').getAttribute('src'), embeddedUrl);
      await frame.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    });
    await page.screenshot({ path: 'artifacts/strife-desktop.png' });
    await page.locator('#menu summary').click();
    await page.getByRole('button', { name: 'Quit Strife' }).click();
    const exited = new Promise(resolve => { if (app.exitCode !== null) resolve(); else app.once('exit', resolve); });
    let exitTimer;
    try {
      await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('Desktop did not shut down.')), 10000); })]);
    } finally { clearTimeout(exitTimer); }
    assert.equal(app.exitCode, 0, output);
    assert.equal(await stat(path.join(directory, 'mumble.dmp')).then(() => true, () => false), false, 'native shutdown must not crash');
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(await page.locator('body').innerText().catch(() => 'Unable to read the desktop.'));
      await page.screenshot({ path: 'artifacts/desktop-failure.png' }).catch(() => {});
    }
    throw error;
  } finally {
    if (app.exitCode === null) app.kill();
    await browser?.close().catch(() => {});
    await helltube.close();
  }
});
