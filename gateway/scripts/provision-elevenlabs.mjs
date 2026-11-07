import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const key = process.env.ELEVENLABS_API_KEY;
if (!key || key.includes('\n') || key.includes('\r')) throw new Error('A valid ElevenLabs environment credential is required');
const environment = { ...process.env };
delete environment.ELEVENLABS_API_KEY;
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'ELEVENLABS_API_KEY'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), env: environment,
  stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
});
child.stdin.end(`${key}\n`);
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
