import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const token = process.env.KAJI_GATEWAY_TOKEN;
if (!/^[A-Za-z0-9_-]{32,128}$/.test(token ?? '')) throw new Error('Runtime gateway credential is required');
const base = 'https://kaji-gateway.relanta.workers.dev/v1';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const report = { time: new Date().toISOString(), checks: [], providerInference: false };
const speech = process.argv.includes('--speech');
const directory = fileURLToPath(new URL('../verification/', import.meta.url));
await mkdir(directory, { recursive: true });
const save = () => writeFile(`${directory}/${speech ? 'speech-live' : process.argv.includes('--vision') ? 'vision-live' : 'gateway-live'}.json`, JSON.stringify(report, null, 2));

async function request(path, body) {
  return fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(65_000) });
}

const anonymous = await fetch(`${base}/capabilities`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
assert.equal(anonymous.status, 401);
report.checks.push('Unauthenticated capability access rejected');
const capabilities = await request('/capabilities');
assert.equal(capabilities.status, 200);
report.capabilities = await capabilities.json();
for (const key of ['reasoning', 'vision', 'stt', 'tts', 'titles']) assert.equal(typeof report.capabilities[key]?.available, 'boolean');
report.checks.push('Live service capabilities return the desktop contract');
for (const [path, body] of [
  ['/audio/transcriptions', { wavBase64: 'invalid' }],
  ['/audio/speech', { text: '' }],
  ['/chat/titles', { request: '', response: '' }],
]) {
  const response = await request(path, body);
  assert([400, 503].includes(response.status), `${path}: unexpected status ${response.status}`);
  report.checks.push(`${path}: invalid input or missing configuration rejected before inference`);
}

if (speech) {
  assert(report.capabilities.tts.available && report.capabilities.stt.available && report.capabilities.titles.available, 'Speech and title services must be available');
  report.providerInference = true;
  report.speech = [];
  const samples = [
    { language: 'en', text: 'Kaji is ready to help.', matches: ['ready', 'help'] },
    { language: 'id', text: 'Kaji siap membantu.', matches: ['siap', 'membantu'] },
  ];
  assert(samples.reduce((count, sample) => count + Array.from(sample.text).length, 0) < 100);
  for (const sample of samples) {
    const response = await request('/audio/speech', { text: sample.text });
    assert.equal(response.status, 200, `Live ${sample.language} synthesis status ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    const audio = new Uint8Array(await response.arrayBuffer());
    assert(audio.byteLength > 1000, 'Speech clip is empty or implausibly short');
    const mp3Path = `${directory}/speech-${sample.language}.mp3`;
    const wavPath = `${directory}/speech-${sample.language}.wav`;
    await writeFile(mp3Path, audio);
    const decoded = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], { windowsHide: true, encoding: 'utf8' });
    assert.equal(decoded.status, 0, `Generated speech cannot be decoded: ${decoded.stderr}`);
    const wav = await readFile(wavPath);
    assert(wav.byteLength > 44 && wav.byteLength < 960_000);
    const recognized = await request('/audio/transcriptions', { wavBase64: wav.toString('base64'), language: sample.language });
    assert.equal(recognized.status, 200, `Live ${sample.language} transcription status ${recognized.status}`);
    const transcript = await recognized.json();
    report.speech.push({ language: sample.language, input: sample.text, transcript: transcript.text, mp3Bytes: audio.byteLength, wavBytes: wav.byteLength });
    await save();
    assert.equal(typeof transcript.text, 'string');
    for (const word of sample.matches) assert(transcript.text.toLowerCase().includes(word), `${sample.language} speech did not preserve '${word}': ${transcript.text}`);
    report.checks.push(`Live ${sample.language} ElevenLabs audio decodes and Groq recognizes its expected words`);
  }
  report.titles = [];
  for (const sample of [
    { language: 'en', request: 'Organize my meeting notes into clear action items', response: 'I will group the decisions and action items.', expected: /meeting|notes|action/i },
    { language: 'id', request: 'Rapikan catatan rapat menjadi daftar tugas', response: 'Saya akan merapikan keputusan dan daftar tugas.', expected: /catatan|rapat|tugas/i },
  ]) {
    const response = await request('/chat/titles', { request: sample.request, response: sample.response });
    assert.equal(response.status, 200, `Live ${sample.language} title status ${response.status}`);
    const { title } = await response.json();
    assert.equal(typeof title, 'string');
    assert(title.split(/\s+/).length >= 3 && title.split(/\s+/).length <= 6);
    assert(sample.expected.test(title), `Title does not match the ${sample.language} conversation: ${title}`);
    report.titles.push({ language: sample.language, title });
    report.checks.push(`Live ${sample.language} Groq title matches the conversation in 3–6 words`);
    await save();
  }
}

if (process.argv.includes('--vision')) {
  assert(report.capabilities.reasoning.available, 'Reasoning budget/provider unavailable');
  const bytes = await readFile(fileURLToPath(new URL('../../web/public/art/cursor.png', import.meta.url)));
  report.providerInference = true;
  const response = await request('/chat/completions', {
    model: 'deepseek-v4.1-flash', stream: false, max_tokens: 1024, reasoning_effort: 'low',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Inspect this image. Identify the depicted object and its two main non-background colors. Call report_visual with those observations. Do not perform any action.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } },
    ] }],
    tools: [{ type: 'function', function: { name: 'report_visual', description: 'Return observed image content', strict: true, parameters: { type: 'object', properties: { subject: { type: 'string' }, colors: { type: 'array', items: { type: 'string' } } }, required: ['subject', 'colors'], additionalProperties: false } } }],
    tool_choice: { type: 'function', function: { name: 'report_visual' } },
  });
  assert.equal(response.status, 200, `Live vision status ${response.status}`);
  const result = await response.json();
  const calls = result.choices?.[0]?.message?.tool_calls;
  assert.equal(calls?.length, 1, 'Model did not produce the requested observation tool call');
  assert.equal(calls[0].function?.name, 'report_visual');
  const observation = JSON.parse(calls[0].function.arguments);
  report.vision = { passed: false, observation };
  console.log(JSON.stringify({ visionObservation: observation }));
  assert(/cursor|pointer|arrow/i.test(observation.subject));
  assert(Array.isArray(observation.colors));
  const colors = observation.colors.join(' ').toLowerCase();
  assert(colors.includes('blue') && /pink|magenta/.test(colors), 'Model color observation does not match the image');
  report.vision = { passed: true, observation };
  report.checks.push('Live DeepSeek image understanding and function calling match the provided image');
}

await save();
console.log(JSON.stringify({ passed: true, checks: report.checks, capabilities: Object.fromEntries(Object.entries(report.capabilities).map(([name, value]) => [name, { ...value, ...(value.voices ? { voices: value.voices.length } : {}) }])), speech: report.speech, titles: report.titles, vision: report.vision ?? 'not requested' }, null, 2));
