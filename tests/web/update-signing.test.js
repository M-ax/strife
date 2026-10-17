import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, verify, constants } from 'node:crypto';
import { validDotNetFrameworks } from '../../scripts/sign-update.mjs';

const frameworks = [
  { name: 'Microsoft.NETCore.App', version: '10.0.0' },
  { name: 'Microsoft.AspNetCore.App', version: '10.0.3' }
];

test('framework metadata requires exactly the two supported stable numeric versions', () => {
  assert.equal(validDotNetFrameworks(frameworks), true);
  for (const value of [undefined, null, [], [frameworks[0]], [frameworks[0], frameworks[0]],
    [...frameworks, frameworks[0]], [null, frameworks[1]],
    [frameworks[0], { name: 'Microsoft.WindowsDesktop.App', version: '10.0.0' }]]) {
    assert.equal(validDotNetFrameworks(value), false);
  }
  for (const version of ['10.0', '10.0.0.0', '10.0.0-preview.1', '10.0.0+build', '010.0.0',
    '10.0.-1', '10.0.0\n', '2147483648.0.0', '', null, 10]) {
    assert.equal(validDotNetFrameworks([frameworks[0], { ...frameworks[1], version }]), false);
  }
});

test('signing and renewal fail closed and preserve schema/runtime requirements', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'strife-update-signing-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await mkdir(path.join(root, 'src/Strife.Desktop'), { recursive: true });
    for (const script of ['sign-update.mjs', 'renew-update.mjs']) {
      await copyFile(new URL(`../../scripts/${script}`, import.meta.url), path.join(root, 'scripts', script));
    }
    // Exercise entry-point detection through an alias on every platform, not
    // only machines whose temporary directory already contains symlinks.
    const scriptAlias = path.join(root, 'script-alias');
    await symlink(path.join(root, 'scripts'), scriptAlias, 'junction');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(path.join(root, 'src/Strife.Desktop/update-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    const options = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
    const env = { ...process.env, STRIFE_UPDATE_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const version = '0.1.0-preview.10';
    await writeFile(path.join(root, `Strife-${version}-full.nupkg`), 'fixture package bytes');
    const requirementPath = path.join(root, 'update-requirements.json');
    const feedPath = path.join(root, 'windows-preview.json');
    const requirements = { minimumVcRuntime: '14.40.33810.0', dotNetFrameworks: frameworks };
    const run = script => spawnSync(process.execPath,
      [path.join(scriptAlias, script), root, version, 'a'.repeat(40)], { env, encoding: 'utf8' });
    const succeed = script => {
      const result = run(script);
      assert.equal(result.status, 0, result.stderr);
    };
    const fail = async script => {
      const before = await readFile(feedPath, 'utf8').catch(() => null);
      assert.notEqual(run(script).status, 0);
      assert.equal(await readFile(feedPath, 'utf8').catch(() => null), before, 'failed signing must not replace feed');
    };
    const readManifest = async () => {
      const envelope = JSON.parse(await readFile(feedPath, 'utf8'));
      const payload = Buffer.from(envelope.payload, 'base64');
      assert.ok(verify('sha256', payload, { ...options, key: publicKey }, Buffer.from(envelope.signature, 'base64')));
      return JSON.parse(payload);
    };
    const writeManifest = async manifest => {
      const payload = Buffer.from(JSON.stringify(manifest));
      await writeFile(feedPath, JSON.stringify({ payload: payload.toString('base64'),
        signature: sign('sha256', payload, { ...options, key: privateKey }).toString('base64') }));
    };
    for (const dotNetFrameworks of [undefined, null, [], [frameworks[0]], [frameworks[0], frameworks[0]]]) {
      await writeFile(requirementPath, JSON.stringify({ ...requirements, dotNetFrameworks }));
      await fail('sign-update.mjs');
    }
    await writeFile(requirementPath, JSON.stringify(requirements));
    succeed('sign-update.mjs');
    const original = await readManifest();
    assert.equal(original.schema, 2, 'old schema-1-only clients reject new feeds');
    assert.deepEqual(original.dotNetFrameworks, frameworks);
    succeed('renew-update.mjs');
    const renewed = await readManifest();
    const { issuedAt, expiresAt, ...unchanged } = renewed;
    assert.deepEqual(unchanged, (({ issuedAt, expiresAt, ...rest }) => rest)(original));
    for (const dotNetFrameworks of [undefined, [], [frameworks[0], { ...frameworks[1], version: '10.0.4' }]]) {
      await writeFile(requirementPath, JSON.stringify({ ...requirements, dotNetFrameworks }));
      await fail('renew-update.mjs');
    }
    const { dotNetFrameworks, ...legacy } = original;
    legacy.schema = 1;
    await writeManifest(legacy);
    await writeFile(requirementPath, JSON.stringify(requirements));
    await fail('renew-update.mjs');
    await writeFile(requirementPath, JSON.stringify({ minimumVcRuntime: requirements.minimumVcRuntime }));
    succeed('renew-update.mjs');
    const renewedLegacy = await readManifest();
    assert.equal(renewedLegacy.schema, 1);
    assert.equal(Object.hasOwn(renewedLegacy, 'dotNetFrameworks'), false);
    for (const dotNetFrameworks of [frameworks, [], null]) {
      await writeManifest({ ...legacy, dotNetFrameworks });
      await fail('renew-update.mjs');
    }
    await writeManifest(legacy);
    await writeFile(path.join(root, legacy.fileName), 'changed package');
    await fail('renew-update.mjs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows runtime discovery uses Registry32 x64 shared frameworks and Registry64 VC++', async () => {
  const source = await readFile(new URL('../../src/Strife.Desktop/AppUpdates.cs', import.meta.url), 'utf8');
  assert.match(source, /machine = RegistryKey\.OpenBaseKey\(RegistryHive\.LocalMachine, RegistryView\.Registry64\)/);
  assert.match(source, /runtime = machine\.OpenSubKey/);
  assert.match(source, /dotNet = RegistryKey\.OpenBaseKey\(RegistryHive\.LocalMachine, RegistryView\.Registry32\)/);
  assert.match(source, /framework = dotNet\.OpenSubKey/);
  assert.ok(source.includes('SOFTWARE\\dotnet\\Setup\\InstalledVersions\\x64\\sharedfx\\'));
  assert.match(source, /framework\?\.GetValueNames\(\)/);
  assert.doesNotMatch(source, /Environment\.Version|InstalledVersions\\(?:x86|arm64)\\/);
});
