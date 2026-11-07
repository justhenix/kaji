import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createKeywordSpotter } from '@sherpaw/kws/node';
import { WAKE_KEYWORD, WAKE_ACTIVE_PATHS } from '../src/audio';

const file = process.argv[2];
assert(file, 'Supply a local mono 16 kHz float32 PCM wake sample');
const root = resolve(import.meta.dir, '..');
const metadata = await Bun.file(resolve(root, 'dist/wake/preload.js.metadata')).json();
const data = await Bun.file(resolve(root, 'dist/wake/preload.data')).arrayBuffer();
const spotter = await createKeywordSpotter({model: {data, metadata}, keywords: [WAKE_KEYWORD], maxActivePaths: WAKE_ACTIVE_PATHS});
async function replay(path: string): Promise<number> {
  const pcm = new Float32Array(await Bun.file(path).arrayBuffer());
  await spotter.reset();
  let hits = 0;
  for (let at = 0; at < pcm.length; at += 128) {
    hits += (await spotter.processAudio(pcm.slice(at, at + 128), 16_000)).length;
  }
  hits += (await spotter.processAudio(new Float32Array(16_000), 16_000)).length;
  return hits;
}
try {
  const hits = await replay(file);
  assert(hits > 0, 'The real microphone wake sample was not recognized');
  const negative = process.argv[3];
  const falseHits = negative ? await replay(negative) : undefined;
  if (negative) assert.equal(falseHits, 0, 'Unrelated speech activated the wake phrase');
  console.log(JSON.stringify({passed: true, activePaths: WAKE_ACTIVE_PATHS, threshold: WAKE_KEYWORD.threshold, hits, falseHits}));
} finally { spotter.dispose(); }
