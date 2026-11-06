import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../assets/wake');
const source = 'https://huggingface.co/moeru-ai/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/resolve/1770a4b22db32184c110ac43c601db17cc9c93f8/install/bin/wasm';
const files = [
  { name: 'preload.data', size: 13076183, sha256: '4ca3ae0d147df1576fac87a4837f5a8959f4f87600a8306c57cc67eb8b40494d' },
  { name: 'preload.js.metadata', size: 272, sha256: 'e7e223298765f02cdc868d8d1af52fd2c0da6aeef2a5af4122489fd7a8ed1e7b' },
] as const;

export async function ensureSpeechAssets(): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (const file of files) {
    const path = resolve(directory, file.name);
    const cached = Bun.file(path);
    let bytes: Uint8Array;
    if (await cached.exists()) bytes = new Uint8Array(await cached.arrayBuffer());
    else {
      const response = await fetch(`${source}/${file.name}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Wake model download failed (${response.status})`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (bytes.length !== file.size || new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Wake model integrity check failed: ${file.name}`);
    }
    await Bun.write(path, bytes);
    paths.push(path);
  }
  return paths;
}

if (import.meta.main) {
  await ensureSpeechAssets();
  console.log('Verified local wake model assets.');
}
