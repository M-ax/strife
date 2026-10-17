import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { constants, verify, sign, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validDotNetFrameworks } from './sign-update.mjs';

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
  if (![1, 2].includes(manifest.schema) || manifest.channel !== channel
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(manifest.version)
      || (manifest.version.includes('-') ? 'preview' : 'stable') !== channel
      || !/^[a-f0-9]{40}$/.test(manifest.sourceRef)
      || !/^\d+\.\d+\.\d+\.\d+$/.test(manifest.minimumVcRuntime)
      || manifest.fileName !== `Strife-${manifest.version}-full.nupkg`) throw new Error('Invalid original metadata.');
  const requirements = JSON.parse(await readFile(path.join(directory, 'update-requirements.json'), 'utf8'));
  if (requirements.minimumVcRuntime !== manifest.minimumVcRuntime) throw new Error('Runtime requirements changed.');
  if (manifest.schema === 1) {
    // Only renew authenticated legacy self-contained packages as schema 1.
    // Even empty/null framework metadata is not evidence of a legacy artifact.
    if (Object.hasOwn(manifest, 'dotNetFrameworks') || Object.hasOwn(requirements, 'dotNetFrameworks'))
      throw new Error('Schema 1 cannot carry .NET framework requirements.');
  } else if (!validDotNetFrameworks(manifest.dotNetFrameworks)
      || !validDotNetFrameworks(requirements.dotNetFrameworks)
      || manifest.dotNetFrameworks.some(f =>
        !requirements.dotNetFrameworks.some(r => r.name === f.name && r.version === f.version))) {
    throw new Error('.NET framework requirements changed or are invalid.');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path.join(directory, manifest.fileName))) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new Error('Original update package changed.');
  // Keep the authenticated schema and requirements; renewal changes only freshness.
  const signingKey = process.env.STRIFE_UPDATE_SIGNING_KEY;
  if (!signingKey) throw new Error('Supply STRIFE_UPDATE_SIGNING_KEY through the CI secret, never a repository file.');
  const now = new Date();
  const renewed = Buffer.from(JSON.stringify({ ...manifest, issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString() }));
  const options = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  const signature = sign('sha256', renewed, { ...options, key: signingKey });
  if (!verify('sha256', renewed, { ...options, key }, signature))
    throw new Error('Signing key does not match the client trust root.');
  await writeFile(path.join(directory, `windows-${channel}.json`), JSON.stringify({
    payload: renewed.toString('base64'), signature: signature.toString('base64')
  }, null, 2) + '\n');
  found = true;
}
if (!found) throw new Error('The original signed update artifact is required.');
