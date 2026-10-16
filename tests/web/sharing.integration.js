import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const soakSeconds = Number(process.env.STRIFE_STREAM_SOAK_SECONDS || 0);
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 300) throw new Error('STRIFE_STREAM_SOAK_SECONDS must be 0–300.');
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw new Error('Timed out'); }
const qualityCatalog = JSON.parse(await readFile(new URL('../../src/Strife.Desktop/streaming-quality.json', import.meta.url)));
const qualityDescription = {...qualityCatalog, presets: qualityCatalog.presets.map(p => ({
  ...p, label: `${p.resolution}${p.fps} ${p.bitrateKbps / 1000} Mbps`,
}))};
function qualityFor(id) {
  const preset = qualityCatalog.presets.find(p => p.id === id && p.enabled);
  assert.ok(preset, 'only enabled quality presets reach the helper');
  return {width: preset.width, height: preset.height, fps: preset.fps, bitrateKbps: preset.bitrateKbps};
}

test('dedicated Helltube frame delegates sharing to Strife and real OBS WHIP', {timeout: 240000 + soakSeconds * 3000}, async t => {
  const cleanup = [];
  const measurements = [];
  if (soakSeconds) cleanup.push(() => writeFile(path.resolve('artifacts/streaming-soak.json'),
    JSON.stringify({scope:'one local Chrome receiver, generated high-motion 4K source', seconds:soakSeconds, measurements}, null, 2)));
  t.after(async () => { for (const action of cleanup.reverse()) await action(); });
  const source = process.env.HELLTUBE_SOURCE || 'C:/Users/Max/WebstormProjects/helltube';
  const {createApp} = await import(pathToFileURL(path.join(source, 'server/app.js')));
  const directory = await mkdtemp(path.resolve('artifacts/sharing-test-'));
  cleanup.push(() => rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  const fixture = path.join(directory, 'pattern.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i',
    soakSeconds ? 'testsrc2=s=3840x2160:r=60' : 'color=c=red:s=3840x2160:r=60',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac',fixture], {windowsHide: true});
  const app = await createApp({dataDir: path.join(directory, 'data'), port: 0, desktopPort: 0, ffmpeg: 'missing-test-ffmpeg', ytdlp: 'missing-test-ytdlp'});
  const url = await app.listen(0); cleanup.push(() => app.close());
  const shell = createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve('src/Strife.Desktop/wwwroot', '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(path.resolve('src/Strife.Desktop/wwwroot') + path.sep)) throw new Error('Invalid path');
      res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { shell.closeAllConnections(); shell.close(resolve); }));
  const origin = 'http://127.0.0.1:' + shell.address().port;
  let helper = null, lines = null, diagnostics = '', commands = [], serial = Promise.resolve(), useGeneratedVideo = true;
  const stop = async () => {
    const child = helper; helper = null;
    if (child) {
      const done = new Promise(resolve => child.once('close', resolve)); child.stdin.end();
      await Promise.race([done, sleep(6000).then(() => { if (child.exitCode === null) child.kill(); })]);
    }
  };
  cleanup.push(stop);
  async function exchange(value) {
    helper.stdin.write(JSON.stringify(value) + '\n');
    const next = await lines.next();
    if (next.done) throw new Error('Helper stopped: ' + diagnostics.slice(-1800));
    const result = JSON.parse(next.value);
    if (!result.ok) throw new Error(result.error);
    return result;
  }
  const browser = await chromium.launch({channel: process.env.STRIFE_TEST_BROWSER || 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  cleanup.push(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const videoUrl = url + '/embed/strife.html#parent=' + encodeURIComponent(origin) + '&session=test-session';
  await page.exposeFunction('nativeCommand', raw => {
    const operation = serial.then(async () => {
      const m = JSON.parse(raw); commands.push(m.command);
      let value;
      if (m.command === 'streamSources') {
        await stop();
        diagnostics = '';
        const executable = path.resolve('artifacts/streaming/bin/64bit/strife-stream.exe');
        const env = {...process.env};
        if (useGeneratedVideo) env.STRIFE_STREAM_TEST_FIXTURE = fixture;
        else delete env.STRIFE_STREAM_TEST_FIXTURE;
        helper = spawn(executable, [], {cwd: path.dirname(executable), windowsHide: true,
          env});
        helper.stderr.on('data', data => diagnostics += data);
        lines = createInterface({input: helper.stdout})[Symbol.asyncIterator]();
        value = await exchange({command: 'sources'});
        assert.equal(value.qualityVersion, 3);
        value.quality = qualityDescription;
      } else if (m.command === 'streamPreview' || m.command === 'streamThumbnail') {
        value = await exchange({command:m.command === 'streamPreview' ? 'preview' : 'thumbnail',
          sourceId:m.sourceId, audioId:m.audioId, encoderId:m.encoderId, audioBitrateKbps:m.audioBitrateKbps,
          quality:m.customQuality || qualityFor(m.qualityId)});
      } else if (m.command === 'streamPreviewStop') {
        if (helper) value = await exchange({command:'stop'});
      } else if (m.command === 'streamStart') {
        value = await exchange({command: 'start', sourceId: m.sourceId, audioId: m.audioId,
          encoderId:m.encoderId, audioBitrateKbps:m.audioBitrateKbps, quality: m.customQuality || qualityFor(m.qualityId),
          server: url + m.credential.path, bearer_token: m.credential.token});
        const requested = m.customQuality || qualityFor(m.qualityId);
        assert.equal(value.quality.fps, requested.fps);
        assert.equal(value.quality.bitrateKbps, requested.bitrateKbps);
        assert.ok(value.quality.width <= requested.width && value.quality.height <= requested.height, 'native fits the source without upscaling');
      } else if (m.command === 'streamStatus') value = helper ? await exchange({command: 'status'}) : {status: 'idle'};
      else if (m.command === 'streamStop') await stop();
      await page.evaluate(message => window.deliver(JSON.stringify(message)), {type: 'result', id: m.id, ok: true, value});
    });
    serial = operation.catch(() => {}); return operation;
  });
  await page.addInitScript(({videoUrl, url}) => {
    if (window.top !== window) return;
    window.external = {
      receiveMessage: callback => window.deliver = callback,
      sendMessage: raw => {
        const m = JSON.parse(raw);
        if (m.command === 'ready') {
          queueMicrotask(() => {
            for (const message of [{type:'streaming', available:true}, {type:'preferences', value:{helltubeUrl:url}, videoUrl},
              {type:'engine', ready:true}, {type:'result', id:m.id, ok:true}]) window.deliver(JSON.stringify(message));
          });
        } else window.nativeCommand(raw).catch(error => window.deliver(JSON.stringify({type:'result',id:m.id,ok:false,error:error.message})));
      },
    };
  }, {videoUrl, url});
  try {
  await page.goto(origin + '/#test-token');
  t.diagnostic('Shell loaded');
  const frame = page.frameLocator('#helltube');
  await frame.getByLabel('Username', {exact:true}).fill('admin');
  await frame.getByLabel('Password', {exact:true}).fill('garbageTime_');
  await frame.getByRole('button', {name:'Enter Helltube'}).click();
  t.diagnostic('Signed in');
  await page.locator('#helltube-room option[value="lobby"]').waitFor({state:'attached'});
  await page.locator('#helltube-room').selectOption('lobby');
  await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
  await page.getByRole('dialog', {name:'Share your screen.'}).waitFor();
  await page.locator('#sharing-sources option').filter({hasText:'Generated test pattern'}).waitFor({state:'attached'});
  assert.equal(await page.locator('#sharing-quality').inputValue(), '1080p60');
  assert.equal(await page.locator('#sharing-quality option:checked').textContent(), '1080p60 8 Mbps');
  assert.equal(await page.locator('#sharing-quality option:disabled').count(), 0);
  await page.locator('#sharing-preview-image').waitFor({state:'visible'});
  assert.equal(app.obs.keys.size, 0, 'preview does not mint publishing credentials');
  assert.equal(app.desktop.sessions.size, 0, 'preview does not publish');
  const previewPixel = await page.locator('#sharing-preview-image').evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(image,0,0,1,1);
    return [...context.getImageData(0,0,1,1).data];
  });
  if (!soakSeconds) assert.ok(previewPixel[0] > 180 && previewPixel[1] < 50, 'local preview matches the selected red source');
  await page.locator('#sharing-thumbnails-load').click();
  await page.locator('#sharing-thumbnails img').first().waitFor({state:'visible'});
  assert.equal(app.obs.keys.size, 0, 'thumbnail generation also stays local');
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready));
  await page.locator('#sharing-status').filter({hasText:'Sharing to The living room'}).waitFor();
  const video = frame.locator('.desktop-tile video').first();
  async function measureStream(encoderId) {
    if (!soakSeconds) return;
    await page.bringToFront();
    await video.scrollIntoViewIfNeeded();
    await video.evaluate(v => v.play());
    const sample = () => video.evaluate(v => {
      const quality = v.getVideoPlaybackQuality();
      const rect = v.getBoundingClientRect();
      return {time:performance.now(), frames:quality.totalVideoFrames, dropped:quality.droppedVideoFrames,
        width:v.videoWidth, height:v.videoHeight, paused:v.paused, visibility:document.visibilityState,
        onScreen:rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight};
    });
    const nativeSample = () => {
      const operation = serial.then(() => exchange({command:'status'}));
      serial = operation.catch(() => {});
      return operation;
    };
    const nativeBefore = await nativeSample();
    const before = await sample(); await sleep(soakSeconds * 1000); const after = await sample();
    const nativeAfter = await nativeSample();
    const result = {encoderId, width:after.width, height:after.height,
      totalVideoFps:(after.frames-before.frames) / ((after.time-before.time)/1000),
      presentedFps:(after.frames-before.frames-after.dropped+before.dropped) / ((after.time-before.time)/1000),
      droppedFrames:after.dropped-before.dropped, paused:after.paused, visibility:after.visibility, onScreen:after.onScreen,
      nativeBefore:nativeBefore.performance, nativeAfter:nativeAfter.performance};
    result.meets60FpsTarget = result.presentedFps >= 54;
    measurements.push(result); t.diagnostic('Local high-motion soak: ' + JSON.stringify(result));
    assert.ok(result.presentedFps >= 1, 'receiver does not stall during soak');
  }
  await until(() => video.evaluateAll(videos => videos[0]?.videoWidth === 1920 && videos[0]?.videoHeight === 1080 && videos[0]?.readyState >= 2));
  const pixel = await video.evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1); return [...context.getImageData(0,0,1,1).data];
  });
  if (!soakSeconds) assert.ok(pixel[0] > 180 && pixel[1] < 50 && pixel[2] < 50, JSON.stringify(pixel));
  assert.equal([...app.desktop.sessions.values()][0].producers.size, 1, 'No audio means no transmitted audio track');
  assert.ok(commands.includes('streamSources') && commands.includes('streamStart'));
  assert.equal(await frame.getByRole('button', {name:'Choose screen to share',exact:true}).count(), 0);
  await page.getByRole('button', {name:'Mute video',exact:true}).click();
  await page.getByRole('button', {name:'Unmute video',exact:true}).waitFor();
  const otherRoom = await page.locator('#helltube-room option').evaluateAll(options => options.find(o => o.value && o.value !== 'lobby')?.value);
  assert.ok(otherRoom);
  await page.locator('#helltube-room').selectOption(otherRoom);
  await until(() => app.desktop.sessions.size === 0 && helper === null);
  assert.equal(await page.locator('#sharing-bar').isVisible(), false);
  await page.locator('#helltube-room').selectOption('lobby');
  await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
  await page.getByRole('dialog', {name:'Share your screen.'}).waitFor();
  await page.locator('#sharing-sources option').filter({hasText:'Generated test pattern'}).waitFor({state:'attached'});
  await page.locator('#sharing-quality').selectOption('720p30');
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready));
  await until(() => video.evaluateAll(videos => videos[0]?.videoWidth === 1280 && videos[0]?.videoHeight === 720 && videos[0]?.readyState >= 2));
  // Exercise each high-resolution preset through the actual picker and decoder.
  for (const presetId of ['1440p30', '1440p60', '4K30', '4K60', 'custom']) {
    await page.locator('#sharing-stop').click();
    await until(() => app.desktop.sessions.size === 0 && helper === null);
    await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
    await page.locator('#sharing-sources option').filter({hasText:'Generated test pattern'}).waitFor({state:'attached'});
    await page.locator('#sharing-quality').selectOption(presetId);
    if (presetId === 'custom') {
      await page.locator('#sharing-resolution').selectOption('1920x1080');
      await page.locator('#sharing-fps').selectOption('15');
      await page.locator('#sharing-bitrate').fill('2300');
      await page.locator('#sharing-bitrate').blur();
    }
    await page.getByRole('button', {name:'Start sharing',exact:true}).click();
    const quality = presetId === 'custom' ? {width:1920,height:1080,fps:15,bitrateKbps:2300} : qualityFor(presetId);
    await until(() => video.evaluateAll((videos, quality) =>
      videos[0]?.videoWidth === quality.width && videos[0]?.videoHeight === quality.height && videos[0]?.readyState >= 2, quality));
    const producer = [...app.desktop.sessions.values()][0].producers.values().next().value;
    assert.match(producer.rtpParameters.codecs[0].parameters['profile-level-id'], /^42[a-f0-9]{4}$/);
    t.diagnostic(`Decoded ${presetId} at ${quality.width}x${quality.height}; native reports ${quality.fps} fps / ${quality.bitrateKbps} Kbps`);
    if (presetId === '4K60') await measureStream('obs_x264');
  }
  await page.locator('#sharing-stop').click();
  await until(() => app.desktop.sessions.size === 0 && helper === null);
  await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
  await page.locator('#sharing-preview-image').waitFor({state:'visible'});
  const hardware = await page.locator('#sharing-encoder option').evaluateAll(options =>
    options.filter(o => !o.disabled && o.value !== 'obs_x264').map(o => o.value));
  for (const encoderId of hardware) {
    t.diagnostic(`Testing hardware encoder ${encoderId}`);
    await page.locator('#sharing-encoder').selectOption(encoderId);
    if (soakSeconds) await page.locator('#sharing-quality').selectOption('4K60');
    if (soakSeconds) {
      await until(async () => !(await page.locator('#sharing-start').isDisabled()) ||
        /encoder cannot|encoder is unavailable/.test(await page.locator('#sharing-preview-description').textContent()));
      if (await page.locator('#sharing-start').isDisabled()) {
        const reason = await page.locator('#sharing-preview-description').textContent();
        measurements.push({encoderId, status:'4K60 preflight rejected', reason});
        t.diagnostic(`${encoderId}: ${reason}`);
        await page.locator('#sharing-cancel').click(); await until(() => helper === null);
        await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
        await page.locator('#sharing-preview-image').waitFor({state:'visible'});
        continue;
      }
    }
    await page.getByRole('button', {name:'Start sharing',exact:true}).click();
    await until(() => video.evaluateAll((v, width) => v[0]?.videoWidth === width && v[0]?.readyState >= 2, soakSeconds ? 3840 : 1920));
    t.diagnostic(`Decoded hardware H.264 from ${encoderId}`);
    await measureStream(encoderId);
    await page.locator('#sharing-stop').click();
    await until(() => app.desktop.sessions.size === 0 && helper === null);
    await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
    await page.locator('#sharing-preview-image').waitFor({state:'visible'});
  }
  await page.locator('#sharing-cancel').click();
  await until(() => helper === null);
  await promisify(execFile)('dotnet', ['build','tests/Strife.Tests','-c','Release','--nologo'], {windowsHide:true, timeout:60000});
  async function audioApplication(title, frequency) {
    const wav = path.join(directory, `${frequency}.wav`);
    await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi',
      '-i',`sine=frequency=${frequency}:sample_rate=48000`,'-t','2','-c:a','pcm_s16le',wav], {windowsHide:true});
    const child = spawn('dotnet', ['tests/Strife.Tests/bin/Release/net10.0/Strife.Tests.dll',
      '--capture-fixture',title,wav], {windowsHide:true});
    child.stderr.resume();
    const done = new Promise(resolve => child.once('close', resolve));
    cleanup.push(async () => { child.stdin.end(); await Promise.race([done, sleep(3000).then(() => child.kill())]); });
    const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const first = await Promise.race([lines.next(), sleep(10000).then(() => {throw new Error('Audio fixture did not start');})]);
    assert.equal(JSON.parse(first.value).ready, true);
    return {child, done};
  }
  const targetTitle = `Strife selected tone ${Date.now()}`;
  const selectedApp = await audioApplication(targetTitle, 440);
  await audioApplication(`Strife excluded tone ${Date.now()}`, 880);
  await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
  const audioOption = page.locator('#sharing-audio-target option').filter({hasText:targetTitle});
  await audioOption.waitFor({state:'attached'});
  await page.locator('#sharing-audio').check();
  await page.locator('#sharing-audio-mode').selectOption('manual');
  assert.equal(await page.locator('#sharing-start').isDisabled(), true);
  await page.locator('#sharing-audio-target').selectOption(await audioOption.getAttribute('value'));
  await page.locator('#sharing-audio-bitrate').selectOption('192');
  await page.locator('#sharing-quality').selectOption('720p30');
  await until(() => page.locator('#sharing-audio-meter').evaluate(meter => meter.value > -60));
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready && s.producers.has('audio')));
  await until(() => video.evaluateAll(v => v[0]?.srcObject?.getAudioTracks().length === 1 && v[0].readyState >= 2));
  const tones = await video.evaluate(async video => {
    const context = new AudioContext({sampleRate:48000});
    const input = context.createMediaStreamSource(video.srcObject);
    const analyser = context.createAnalyser(); analyser.fftSize = 8192;
    const silent = context.createGain(); silent.gain.value = 0;
    input.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
    await context.resume();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
    const peak = hz => {
      const center = Math.round(hz * analyser.fftSize / context.sampleRate);
      return Math.max(...bins.slice(center - 2, center + 3));
    };
    const result = {selected:peak(440), excluded:peak(880)};
    await context.close(); return result;
  });
  assert.ok(tones.selected > -65 && tones.selected > tones.excluded + 20, JSON.stringify(tones));
  t.diagnostic(`Application audio isolation: selected 440 Hz ${tones.selected.toFixed(1)} dB, excluded 880 Hz ${tones.excluded.toFixed(1)} dB`);
  selectedApp.child.stdin.end(); await selectedApp.done;
  await page.locator('#sharing-status').filter({hasText:'Audio target lost'}).waitFor();
  assert.equal(app.desktop.sessions.size, 1, 'audio loss leaves video running, without system fallback');
  await page.locator('#sharing-stop').click();
  await until(() => app.desktop.sessions.size === 0 && helper === null);
  const windowTitle = `Strife actual window ${Date.now()}`;
  const windowApp = await audioApplication(windowTitle, 660);
  useGeneratedVideo = false;
  await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
  await page.locator('#sharing-refresh').waitFor();
  await until(() => page.locator('#sharing-refresh').isEnabled());
  await page.locator('#sharing-kind').selectOption('window');
  await page.locator('#sharing-search').fill(windowTitle);
  assert.equal(await page.locator('#sharing-sources option').count(), 1);
  await page.locator('#sharing-audio').check();
  assert.equal(await page.locator('#sharing-audio-mode').inputValue(), 'automatic');
  assert.match(await page.locator('#sharing-audio-scope').textContent(), /Strife actual window/);
  await page.locator('#sharing-quality').selectOption('720p30');
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready && s.producers.size === 2));
  await until(() => video.evaluateAll(v => v[0]?.videoWidth > 0 && v[0]?.videoWidth <= 640 && v[0]?.readyState >= 2));
  windowApp.child.stdin.end(); await windowApp.done;
  await until(() => app.desktop.sessions.size === 0 && helper === null);
  t.diagnostic('Real window capture with automatic application audio stopped when the selected window closed');
  // Restore a generated source for the reload teardown check.
  useGeneratedVideo = true;
  await frame.getByRole('button', {name:'Share desktop',exact:true}).click();
  await page.locator('#sharing-sources option').filter({hasText:'Generated test pattern'}).waitFor({state:'attached'});
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready));
  // A frame reload must tear down the publishing resource and discard credentials.
  await page.getByRole('button', {name:'Reload Helltube',exact:true}).click();
  await until(() => app.desktop.sessions.size === 0 && helper === null);
  assert.equal(await page.locator('#sharing-bar').isVisible(), false);
  assert.deepEqual(errors, []);
  } catch (error) {
    console.error(error); console.error(errors);
    console.error(diagnostics.split('\n').filter(line => /nvenc|whip|encoder|error|fail/i.test(line))
      .map(line => line.replace(/[a-f0-9]{64}/gi, '[redacted]')).join('\n'));
    throw error;
  }
});

test('native WHIP refuses credential-bearing redirects and foreign resource URLs', {timeout: 60000}, async t => {
  const cleanup = []; t.after(async () => { for (const action of cleanup.reverse()) await action(); });
  const directory = await mkdtemp(path.resolve('artifacts/sharing-redirect-test-'));
  cleanup.push(() => rm(directory, {recursive:true, force:true, maxRetries:10, retryDelay:100}));
  const fixture = path.join(directory, 'pattern.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=640x360:r=30','-t','1',
    '-c:v','libx264','-pix_fmt','yuv420p',fixture], {windowsHide:true});
  let leaked = false, received = false, mode = 'redirect';
  const foreign = createServer((_req,res) => { leaked = true; res.writeHead(401).end(); });
  await new Promise(resolve => foreign.listen(0,'127.0.0.1',resolve));
  cleanup.push(() => new Promise(resolve => {foreign.closeAllConnections(); foreign.close(resolve);}));
  const endpoint = createServer((req,res) => {
    received = req.headers.authorization === 'Bearer ' + 'a'.repeat(64);
    res.writeHead(mode === 'redirect' ? 307 : 201, {Location:'http://127.0.0.1:' + foreign.address().port + '/steal',
      'Content-Type':'application/sdp'}).end('v=0\r\n');
  });
  await new Promise(resolve => endpoint.listen(0,'127.0.0.1',resolve));
  cleanup.push(() => new Promise(resolve => {endpoint.closeAllConnections(); endpoint.close(resolve);}));
  const executable = path.resolve('artifacts/streaming/bin/64bit/strife-stream.exe');
  const helper = spawn(executable, [], {cwd:path.dirname(executable), windowsHide:true, env:{...process.env, STRIFE_STREAM_TEST_FIXTURE:fixture}});
  helper.stderr.resume();
  const lines = createInterface({input:helper.stdout})[Symbol.asyncIterator]();
  cleanup.push(async () => {
    if (helper.exitCode !== null) return;
    const closed = new Promise(resolve => helper.once('close', resolve)); helper.stdin.end(); await closed;
  });
  const exchange = async value => { helper.stdin.write(JSON.stringify(value)+'\n'); const line = await lines.next(); assert.equal(line.done,false); return JSON.parse(line.value); };
  const sources = await exchange({command:'sources'}); assert.equal(sources.ok,true);
  for (const quality of [undefined, {}, {...qualityFor('1080p60'), fps: 61},
    {...qualityFor('1080p60'), width: 3842}, {...qualityFor('1080p60'), height: 1079},
    {...qualityFor('1080p60'), bitrateKbps: 40001}, {...qualityFor('1080p60'), fps: '60'},
    {...qualityFor('1080p60'), bitrateKbps: 8000.5}]) {
    const result = await exchange({command:'start',sourceId:sources.sources[0].id,audioId:'', quality,
      server:'http://127.0.0.1:' + endpoint.address().port + '/whip',bearer_token:'a'.repeat(64)});
    assert.equal(result.ok, false);
    assert.equal(received, false, 'invalid quality cannot send credentials or publish');
  }
  for (mode of ['redirect', 'resource']) {
    received = false;
    assert.equal((await exchange({command:'start',sourceId:sources.sources[0].id,audioId:'', quality: qualityFor('720p30'),
      server:'http://127.0.0.1:' + endpoint.address().port + '/whip',bearer_token:'a'.repeat(64)})).ok,true);
    await until(async () => (await exchange({command:'status'})).status === 'error');
    assert.equal(received,true); assert.equal(leaked,false);
  }
});
