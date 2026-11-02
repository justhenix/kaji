import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { palette, pixelAt, type Artwork } from '../src/lib/dither';

const root = new URL('../', import.meta.url);
const publicDir = new URL('public/', root);
await mkdir(new URL('art/', publicDir), { recursive: true });
await copyFile(new URL('../../logo/favicon.svg', import.meta.url), new URL('favicon.svg', publicDir));

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type: string, data: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, payload, tail]);
}

const sourceTime = Math.max((await stat(fileURLToPath(import.meta.url))).mtimeMs, (await stat(new URL('../src/lib/dither.ts', import.meta.url))).mtimeMs);
for (const [kind, width, height] of [['sweep', 960, 640], ['cursor', 400, 440], ['hero-cursor', 400, 440]] as const) {
  const output = new URL(`art/${kind}.png`, publicDir);
  const previous = await stat(output).catch(() => null);
  if (previous && previous.mtimeMs >= sourceTime) continue;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const color = pixelAt(kind as Artwork, x / 2, y / 2, width, height);
    if (!color) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const offset = (y + dy) * stride + 1 + (x + dx) * 4;
      raw.set([...palette[color - 1], 255], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(output, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}
