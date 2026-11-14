import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import phrases from '../assets/voice/manifest.json';

const directory = resolve(import.meta.dir, '../assets/voice');
const voiceId = 'CwhRBWXzGAHq8TQ4Fs17';
const generate = process.argv.includes('--generate');
const token = process.env.KAJI_GATEWAY_TOKEN;
if (generate && !/^[A-Za-z0-9_-]{32,128}$/.test(token ?? '')) throw new Error('KAJI_GATEWAY_TOKEN is required to generate clips');

let generated = 0;
for (const language of ['en', 'idn'] as const) {
  await mkdir(resolve(directory, language), { recursive: true });
  for (const phrase of phrases) {
    const file = Bun.file(resolve(directory, language, `${phrase.id}.mp3`));
    if (!await file.exists()) {
      if (!generate) throw new Error(`Missing offline voice clip: ${language}/${phrase.id}.mp3`);
      const response = await fetch('https://kaji-gateway.relanta.workers.dev/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: phrase[language], voiceId }),
        redirect: 'error', signal: AbortSignal.timeout(65_000),
      });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/mpeg')) {
        throw new Error(`Offline voice generation failed (${response.status}): ${language}/${phrase.id}`);
      }
      const audio = await response.arrayBuffer();
      if (audio.byteLength < 1_000) throw new Error(`Empty offline voice clip: ${phrase.id}`);
      await Bun.write(file, audio);
      generated++;
      console.log(`Generated ${language}/${phrase.id}.mp3`);
    }
    const result = Bun.spawnSync(['ffmpeg', '-nostdin', '-v', 'error', '-i', file.name!, '-f', 'null', '-'], { windowsHide: true });
    if (result.exitCode !== 0) throw new Error(`Invalid offline voice clip: ${language}/${phrase.id}`);
  }
}
console.log(`Verified ${phrases.length * 2} offline clips; generated ${generated}.`);
