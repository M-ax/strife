import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { constants, verify, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Usage: renew-update.mjs ARTIFACT_DIRECTORY');
const scripts = path.dirname(fileURLToPath(import.meta.url));
const key = await readFile(path.join(scripts, '../src/Strife.Desktop/update-key.pem'), 'utf8');
let found = false;
for (const channel of ['preview', 'stable']) {
  let envelope;
  try { envelope = JSON.parse(await readFile(path.join(directory, `windows-${channel}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify('sha256', payload, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(envelope.signature, 'base64'))) throw new Error('Cannot renew an unauthenticated feed.');
  const manifest = JSON.parse(payload);
  if (manifest.schema !== 1 || manifest.channel !== channel
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(manifest.version)
      || manifest.fileName !== `Strife-${manifest.version}-full.nupkg`) throw new Error('Invalid original metadata.');
  const requirements = JSON.parse(await readFile(path.join(directory, 'update-requirements.json'), 'utf8'));
  if (requirements.minimumVcRuntime !== manifest.minimumVcRuntime) throw new Error('Runtime requirements changed.');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path.join(directory, manifest.fileName))) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new Error('Original update package changed.');
  const result = spawnSync(process.execPath, [path.join(scripts, 'sign-update.mjs'), directory, manifest.version, manifest.sourceRef],
    { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Renewal signing failed.');
  found = true;
}
if (!found) throw new Error('The original signed update artifact is required.');
