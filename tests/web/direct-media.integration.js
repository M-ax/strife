// Requires explicit HELLTUBE_SOURCE with npm dependencies, FFmpeg, .NET 10 and Chrome.
// Builds the selected checkout's UI; never substitutes the user's original checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright';

const exec = promisify(execFile);
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(message);
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('real managed proxy negotiates credentialless, origin-bound direct HLS with Helltube', {timeout: 180000}, async t => {
  assert.ok(process.env.HELLTUBE_SOURCE, 'Set HELLTUBE_SOURCE to the Helltube checkout under test.');
  const source = path.resolve(process.env.HELLTUBE_SOURCE);
  t.diagnostic(`Helltube source: ${source}`);
  const load = file => import(pathToFileURL(path.join(source, file)));
  const {createApp} = await load('server/app.js');
  const {makeItem} = await load('server/rooms.js');
  const {create4kFixture} = await load('test/media-4k-fixture.js');
  const sourceRequire = createRequire(path.join(source, 'package.json'));
  const vite = path.join(path.dirname(sourceRequire.resolve('vite/package.json')), 'bin/vite.js');
  await exec(process.execPath, [vite, 'build'],
    {cwd: source, timeout: 60000, maxBuffer: 4 * 1024 * 1024});
  await exec('dotnet', ['build', 'tests/Strife.Tests/Strife.Tests.csproj', '-c', 'Release', '--nologo'],
    {timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});

  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const action of cleanup.reverse()) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
  });
  await mkdir('artifacts', {recursive: true});
  const dir = await mkdtemp(path.resolve('artifacts/direct-media-'));
  cleanup.push(() => rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  let instance, redirect = false, redirectHits = 0, redirectAttempts = 0;
  const mediaRequests = [], upstreamRequests = [], localMediaRequests = [];
  const sink = createServer((_req, res) => { redirectHits++; res.end('must not follow'); });
  const sinkOrigin = await listen(sink);
  cleanup.push(() => close(sink));
  // Bind metal BEFORE createApp: grants must never contain :0. Both listeners
  // dispatch directly into real Helltube, not a JavaScript stand-in for Strife.
  const metal = createServer((req, res) => {
    if (req.url.startsWith('/direct/media/')) {
      const entry = {url: req.url, ...req.headers};
      mediaRequests.push(entry);
      res.on('finish', () => { entry.status = res.statusCode; });
      if (redirect) {
        redirectAttempts++;
        res.writeHead(307, {Location: sinkOrigin + '/stolen-grant',
          'Access-Control-Allow-Origin': req.headers.origin || ''}).end();
        return;
      }
    }
    instance.app(req, res);
  });
  const metalOrigin = await listen(metal);
  cleanup.push(() => close(metal));
  instance = await createApp({dataDir: path.join(dir, 'data'), host: '127.0.0.1', port: 0,
    desktopPort: 0, bareMetalOrigin: metalOrigin, origins: [], maxTranscoders: 2});
  cleanup.push(() => instance.close());
  instance.server.prependListener('request', req => {
    upstreamRequests.push({url: req.url, recipient: req.headers['x-strife-media-origin']});
  });
  const upstream = await instance.listen(0);
  await create4kFixture(t, {instance, dir, url: upstream}, {size: '320x180', duration: 30});

  let proxyUrl;
  // Reuse the app's policy instead of maintaining a subtly different sandbox.
  const html = await readFile('src/Strife.Desktop/wwwroot/index.html', 'utf8');
  const sandbox = html.match(/<iframe\b[^>]*\bsandbox="([^"]+)"/)?.[1];
  assert.ok(sandbox);
  const shell = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<iframe id="helltube" style="width:100%;height:95vh" src="${proxyUrl}"
      sandbox="${sandbox}" referrerpolicy="no-referrer"
      allow="autoplay; fullscreen; display-capture; clipboard-write" allowfullscreen></iframe>`);
  });
  const shellOrigin = await listen(shell);
  cleanup.push(() => close(shell));
  const child = spawn('dotnet', [path.resolve('tests/Strife.Tests/bin/Release/net10.0/Strife.Tests.dll'),
    '--proxy-fixture', upstream, shellOrigin], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', startupError;
  child.stderr.on('data', data => { output += data; });
  child.on('error', error => { startupError = error; });
  child.stdin.on('error', error => { startupError = error; });
  const lines = createInterface({input: child.stdout});
  lines.on('line', line => {
    output += line + '\n';
    try { proxyUrl = JSON.parse(line).proxyFixture || proxyUrl; } catch {}
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  cleanup.push(async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    lines.close();
  });
  await until(() => {
    if (startupError) throw startupError;
    assert.equal(child.exitCode, null, output);
    return proxyUrl;
  }, 'Managed proxy startup timed out');
  const frameOrigin = new URL(proxyUrl).origin;
  assert.notEqual(frameOrigin, shellOrigin);
  assert.notEqual(frameOrigin, metalOrigin);
  const browser = await chromium.launch({channel: process.env.STRIFE_TEST_BROWSER || 'chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  cleanup.push(() => browser.close());
  const context = await browser.newContext();
  // Loopback cookies share a host across ports: omission must work with a nonempty jar.
  await context.addCookies([{name: 'media-credential-canary', value: 'must-not-reach-metal', url: metalOrigin}]);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === frameOrigin && /^\/(?:direct\/media|media)\//.test(url.pathname))
      localMediaRequests.push(url.pathname);
  });
  await page.addInitScript(() => {
    window.mediaFetches = [];
    const original = window.fetch;
    window.fetch = function(input, init) {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith('/direct/media/'))
        window.mediaFetches.push({url: request.url, credentials: request.credentials, redirect: request.redirect});
      return original.call(this, input, init);
    };
  });
  await page.goto(shellOrigin);
  const ui = page.frameLocator('#helltube');
  await ui.getByLabel('Username', {exact: true}).fill('admin');
  await ui.getByLabel('Password', {exact: true}).fill('garbageTime_');
  await ui.getByRole('button', {name: 'Enter Helltube'}).click();
  await ui.getByRole('navigation', {name: 'Screening rooms'})
    .getByRole('button', {name: /^The living room(?: |$)/}).click();
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 1, 'Browser did not join through the managed WebSocket proxy');
  let frame = page.frames().find(value => value.url().startsWith(frameOrigin));
  assert.ok(frame);
  const api = (route, method = 'GET') => frame.evaluate(async ({route, method}) => {
    const response = await fetch(route, {method});
    return {status: response.status, data: await response.json()};
  }, {route, method});
  const config = await api('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.bareMetalOrigin, frameOrigin, 'Uploads and files retain the local route');
  assert.equal(config.data.strifeDirectMedia, 1);
  assert.equal(config.data.strifeDirectMediaOrigin, metalOrigin);
  assert.ok(upstreamRequests.some(req => req.url === '/api/config' && req.recipient === frameOrigin));

  // Only source resolution is synthetic. Helltube really encrypts/packages the fixture;
  // its shipped Player + delivery client + hls.js decode it inside the sandbox.
  const item = makeItem({kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw'}, {duration: 30});
  instance.rooms.add(room, [item]);
  await until(() => {
    assert.notEqual(item.status, 'error', item.error);
    return instance.media.jobs.get(item.id)?.done;
  }, 'Generated HLS did not finish', 40000);
  const job = instance.media.jobs.get(item.id);
  const video = ui.locator('video').first();
  await until(() => video.evaluateAll(videos => videos.some(video =>
    video.videoWidth > 0 && video.readyState >= 2 && video.currentTime > 0)),
  'Real Helltube player did not decode direct HLS', 30000);
  const pixel = await video.evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
  assert.ok(pixel[2] > 150 && pixel[0] < 80 && pixel[1] < 80, `Decoded fixture must be blue: ${pixel}`);
  const fetches = await frame.evaluate(() => window.mediaFetches);
  assert.ok(fetches.length > 0, 'Shipped HLS loader must use fetch');
  assert.ok(fetches.every(req => req.credentials === 'omit' && req.redirect === 'error'),
    'Every playlist, key and segment fetch must omit credentials and refuse redirects');
  for (const pattern of [/index\.m3u8/, /key\.bin/, /segment-\d+\.(?:ts|m4s)/]) {
    assert.ok(mediaRequests.some(req => pattern.test(req.url) && req.status === 200), `Metal delivered ${pattern}`);
  }
  assert.ok(mediaRequests.every(req => req.origin === frameOrigin && !req.cookie && !req.authorization),
    'Metal receives the actual frame Origin and no ambient credentials');
  assert.deepEqual(localMediaRequests, []);
  assert.ok(!upstreamRequests.some(req => /^\/(?:direct\/media|media)\//.test(req.url)));

  // Authorization is kind-independent, including paths previously sent to the edge.
  let granted;
  const originalKind = item.kind;
  try {
    for (const kind of ['youtube', 'twitch', 'soundcloud', 'http', 'upload', 'desktop']) {
      item.kind = kind;
      const access = await api(`/api/media/${job.id}/access`);
      assert.equal(access.status, 200, kind);
      assert.equal(new URL(access.data.url).origin, metalOrigin, kind);
      assert.equal(new URL(access.data.url).pathname, `/direct/media/${job.id}/index.m3u8`);
      assert.equal(access.data.fallbackUrl, undefined, 'Negotiated playback has no proxy/edge fallback');
      granted = access.data.url;
    }
  } finally { item.kind = originalKind; }
  assert.ok(upstreamRequests.filter(req => req.url.endsWith('/access'))
    .every(req => req.recipient === frameOrigin));
  const fetchDirect = (targetFrame, url) => targetFrame.evaluate(async url => {
    try {
      const response = await fetch(url, {credentials: 'omit', redirect: 'error'});
      await response.arrayBuffer();
      return response.status;
    } catch { return 'blocked'; }
  }, url);
  assert.equal(await fetchDirect(frame, granted), 200);
  const wrongResource = new URL(granted);
  wrongResource.pathname = `/direct/media/${randomUUID()}/index.m3u8`;
  assert.notEqual(await fetchDirect(frame, wrongResource.href), 200, 'A grant cannot authorize another job');
  // The shell is a second real loopback origin, not a Node request forging Origin.
  assert.notEqual(await fetchDirect(page, granted), 200, 'Another loopback port cannot replay the grant');
  assert.ok(mediaRequests.some(req => req.origin === shellOrigin && req.status >= 400));

  redirect = true;
  await frame.goto(proxyUrl);
  frame = page.frames().find(value => value.url().startsWith(frameOrigin));
  await until(() => redirectAttempts > 0, 'Reloaded player did not request direct media');
  await sleep(1500);
  assert.equal(redirectHits, 0, 'The real HLS loader must not follow a metal redirect');
  assert.deepEqual(localMediaRequests, [], 'Direct failure must not retry through Strife');
  assert.ok(!upstreamRequests.some(req => /^\/(?:direct\/media|media)\//.test(req.url)));
  redirect = false;
  assert.equal((await api('/api/logout', 'POST')).status, 200);
  assert.notEqual(await fetchDirect(frame, granted), 200, 'Logout revokes already issued URLs');
  t.diagnostic(`Decoded direct HLS; ${mediaRequests.length} metal requests, zero local media requests.`);
});
