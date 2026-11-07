import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const [installer, signature, url] = process.argv.slice(2);
assert(installer && signature && url, 'Usage: bun app/scripts/update-feed.ts INSTALLER SIGNATURE HTTPS_URL');
const root = resolve(import.meta.dir, '../..');
const { version } = await Bun.file(resolve(root, 'app/src-tauri/tauri.conf.json')).json();
assert(/^\d+\.\d+\.\d+$/.test(version), 'Publish a stable semantic version');
const remote = new URL(url);
assert.equal(remote.protocol, 'https:');
assert(!remote.username && !remote.password && !remote.search && !remote.hash);
assert.equal(decodeURIComponent(remote.pathname.split('/').at(-1)!), `Kaji-${version}-x64-setup.exe`);
const sig = (await Bun.file(signature).text()).trim();
const decoded = Buffer.from(sig, 'base64').toString('utf8');
assert(decoded.includes(`version:${version}`), 'Signature must be bound to this release version');
const file = Bun.file(installer);
assert(await file.exists() && file.size > 0);
const hash = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
await Bun.write(resolve(root, 'web/public/updates/latest.json'), JSON.stringify({
  version, pub_date: new Date().toISOString(), notes: 'Windows keyboard shortcuts, clear connection-check results, and accurate voice capability answers.',
  platforms: { 'windows-x86_64': { url, signature: sig } },
}, null, 2) + '\n');
console.log(JSON.stringify({ version, filename: remote.pathname.split('/').at(-1), bytes: file.size, sha256: hash }));
