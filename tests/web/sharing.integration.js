import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw new Error('Timed out'); }

test('dedicated Helltube frame delegates sharing to Strife and real OBS WHIP', {timeout: 90000}, async t => {
  const cleanup = [];
  t.after(async () => { for (const action of cleanup.reverse()) await action(); });
  const source = process.env.HELLTUBE_SOURCE || 'C:/Users/Max/WebstormProjects/helltube';
  const {createApp} = await import(pathToFileURL(path.join(source, 'server/app.js')));
  const directory = await mkdtemp(path.resolve('artifacts/sharing-test-'));
  cleanup.push(() => rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  const fixture = path.join(directory, 'pattern.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=640x360:r=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',fixture], {windowsHide: true});
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
  let helper = null, lines = null, diagnostics = '', commands = [], serial = Promise.resolve();
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
        const executable = path.resolve('artifacts/streaming/bin/64bit/strife-stream.exe');
        helper = spawn(executable, [], {cwd: path.dirname(executable), windowsHide: true,
          env: {...process.env, STRIFE_STREAM_TEST_FIXTURE: fixture}});
        helper.stderr.on('data', data => diagnostics += data);
        lines = createInterface({input: helper.stdout})[Symbol.asyncIterator]();
        value = await exchange({command: 'sources'});
      } else if (m.command === 'streamStart') {
        value = await exchange({command: 'start', sourceId: m.sourceId, audio: false,
          server: url + m.credential.path, bearer_token: m.credential.token});
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
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready));
  await page.locator('#sharing-status').filter({hasText:'Sharing to The living room'}).waitFor();
  const video = frame.locator('.desktop-tile video').first();
  await until(() => video.evaluateAll(videos => videos[0]?.videoWidth === 1280 && videos[0]?.readyState >= 2));
  const pixel = await video.evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1); return [...context.getImageData(0,0,1,1).data];
  });
  assert.ok(pixel[0] > 180 && pixel[1] < 50 && pixel[2] < 50, JSON.stringify(pixel));
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
  await page.getByRole('button', {name:'Start sharing',exact:true}).click();
  await until(() => [...app.desktop.sessions.values()].some(s => s.ready));
  // A frame reload must tear down the publishing resource and discard credentials.
  await page.getByRole('button', {name:'Reload Helltube',exact:true}).click();
  await until(() => app.desktop.sessions.size === 0 && helper === null);
  assert.equal(await page.locator('#sharing-bar').isVisible(), false);
  assert.deepEqual(errors, []);
  } catch (error) { console.error(error); console.error(errors); throw error; }
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
  for (mode of ['redirect', 'resource']) {
    received = false;
    assert.equal((await exchange({command:'start',sourceId:sources.sources[0].id,audio:false,
      server:'http://127.0.0.1:' + endpoint.address().port + '/whip',bearer_token:'a'.repeat(64)})).ok,true);
    await until(async () => (await exchange({command:'status'})).status === 'error');
    assert.equal(received,true); assert.equal(leaked,false);
  }
});
