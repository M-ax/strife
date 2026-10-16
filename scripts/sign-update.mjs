import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, sign, verify, constants } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, version, sourceRef] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version || '')
    || !/^[a-f0-9]{40}$/.test(sourceRef || '')) throw new Error('Usage: sign-update.mjs DIRECTORY VERSION SOURCE_COMMIT');
const key = process.env.STRIFE_UPDATE_SIGNING_KEY;
if (!key) throw new Error('Supply STRIFE_UPDATE_SIGNING_KEY through the CI secret, never a repository file.');
const channel = version.includes('-') ? 'preview' : 'stable';
const fileName = `Strife-${version}-full.nupkg`;
const archive = path.join(directory, fileName);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const { minimumVcRuntime } = JSON.parse(await readFile(path.join(directory, 'update-requirements.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+\.\d+$/.test(minimumVcRuntime)) throw new Error('Invalid prerequisite version.');
const now = new Date();
const payload = Buffer.from(JSON.stringify({
  schema: 1, channel, version, fileName, bytes: (await stat(archive)).size,
  sha256: hash.digest('hex'), sourceRef, issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
  minimumWindowsBuild: 19041, minimumVcRuntime
}));
const options = { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
const signature = sign('sha256', payload, options);
const publicKey = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/Strife.Desktop/update-key.pem'), 'utf8');
if (!verify('sha256', payload, { ...options, key: publicKey }, signature)) throw new Error('Signing key does not match the client trust root.');
await writeFile(path.join(directory, `windows-${channel}.json`), JSON.stringify({
  payload: payload.toString('base64'), signature: signature.toString('base64')
}, null, 2) + '\n');
console.log(`Signed ${channel} update ${version} from ${sourceRef}.`);
