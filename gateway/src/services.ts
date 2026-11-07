import { SERVICE_LIMITS, type ServiceName, type TtsUsage } from "./budget";
import { GATEWAY_MODELS } from '../../app/shared/models';

export const STT_MODEL = "whisper-large-v3-turbo";
export const TITLE_MODEL = "qwen/qwen3.8-27b";
export const TTS_MODEL = "eleven_v4_turbo";
export const TTS_MONTHLY_CREDIT_CAP = 10000;
const GROQ_ORIGIN = "https://api.groq.com/openai/v1";
const ELEVEN_ORIGIN = "https://api.elevenlabs.io/v1";
const WAV_LIMIT = 1024 * 1024;
const TITLE_BODY_LIMIT = 16 * 1024;
const TITLE_SOURCE_LIMIT = 4000;
const TTS_TEXT_LIMIT = 1000;
const TTS_AUDIO_LIMIT = 2 * 1024 * 1024;

export interface ServiceEnv {
  BAI_API_KEY?: string;
  BAI_VISION_VERIFIED?: string;
  NINE_ROUTER_API_KEY?: string;
  NINE_ROUTER_BASE_URL?: string;
  GROQ_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  GATEWAY_TOKEN_SHA256: string;
  OWNER_BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };
}
export type ServiceUpstream = (url: string, init?: RequestInit) => Promise<Response>;
type ServiceResult = { status: number; response: Response };
type AnyObject = Record<string, any>;
const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const jsonError = (status: number, message: string) => new Response(JSON.stringify({ error: { message, type: "gateway_error" } }), { status, headers: jsonHeaders });
const isObject = (value: unknown): value is AnyObject => !!value && typeof value === "object" && !Array.isArray(value);

async function readBytes(request: Request | Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Request exceeds body limit");
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("Request exceeds body limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(request, maxBytes));
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON body"); }
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid base64 audio");
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("Invalid base64 audio"); }
  if (binary.length > maxBytes) throw new Error("Audio exceeds 30 seconds");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function wavDurationSeconds(wav: Uint8Array): number {
  if (wav.length < 44 || wav.length > WAV_LIMIT) throw new Error("Audio must be a WAV file under 1 MiB");
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...wav.subarray(start, start + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== wav.length) throw new Error("Invalid WAV container");
  let offset = 12, format: number | undefined, channels: number | undefined, rate: number | undefined, byteRate: number | undefined, align: number | undefined, bits: number | undefined, dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = ascii(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    if (end > wav.length) throw new Error("Invalid WAV chunk");
    if (id === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format");
      format = view.getUint16(start, true); channels = view.getUint16(start + 2, true); rate = view.getUint32(start + 4, true);
      byteRate = view.getUint32(start + 8, true); align = view.getUint16(start + 12, true); bits = view.getUint16(start + 14, true);
    }
    if (id === "data") dataSize += size;
    offset = end + (size & 1);
  }
  if (offset !== wav.length || format !== 1 || channels !== 1 || rate !== 16000 || byteRate !== 32000 || align !== 2 || bits !== 16 || dataSize < 2 || dataSize % 2) throw new Error("Audio must be 16 kHz mono 16-bit PCM WAV");
  const seconds = dataSize / byteRate;
  if (seconds > 30) throw new Error("Audio exceeds 30 seconds");
  return seconds;
}

function signalFor(request: Request, milliseconds: number) {
  const controller = new AbortController();
  const abortFromClient = () => controller.abort(request.signal.reason);
  const timer = setTimeout(() => controller.abort(new DOMException("Provider request timed out", "TimeoutError")), milliseconds);
  request.signal.addEventListener("abort", abortFromClient, { once: true });
  if (request.signal.aborted) abortFromClient();
  return {
    signal: controller.signal,
    cleanup: () => { clearTimeout(timer); request.signal.removeEventListener("abort", abortFromClient); },
  };
}

async function reserve(env: ServiceEnv, service: ServiceName, units: number, tts?: TtsUsage) {
  const response = await env.OWNER_BUDGET.get(env.OWNER_BUDGET.idFromName("owner-v1")).fetch("https://budget/service/reserve", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service, units, ...tts }),
  });
  if (!response.ok) throw new Error("Quota service unavailable");
  return await response.json() as { status: string; usage?: AnyObject };
}

async function quotaStatus(env: ServiceEnv, service: ServiceName, tts?: TtsUsage) {
  const response = await env.OWNER_BUDGET.get(env.OWNER_BUDGET.idFromName("owner-v1")).fetch("https://budget/service/status", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service, ...tts }),
  });
  if (!response.ok) throw new Error("Quota service unavailable");
  return await response.json() as AnyObject;
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBytes(response, maxBytes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid provider response"); }
}

async function transcribe(request: Request, env: ServiceEnv, upstream: ServiceUpstream): Promise<Response> {
  if (!env.GROQ_API_KEY) return jsonError(503, "Speech recognition is not configured");
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return jsonError(415, "JSON required");
  let wav: Uint8Array, duration: number, language: string | undefined;
  try {
    const body = await readJson(request, Math.ceil(WAV_LIMIT / 3) * 4 + 1024);
    if (!isObject(body) || Object.keys(body).some(key => !["wavBase64", "language"].includes(key))) throw new Error("Invalid transcription request");
    if (body.language !== undefined && !["en", "id", "auto"].includes(body.language)) throw new Error("Language must be en, id, or auto");
    language = body.language === "auto" ? undefined : body.language;
    wav = decodeBase64(body.wavBase64, WAV_LIMIT);
    duration = wavDurationSeconds(wav);
  } catch (cause) { return jsonError(String(cause).includes("exceeds") ? 413 : 400, cause instanceof Error ? cause.message : "Invalid audio"); }
  const billedSeconds = Math.max(10, Math.ceil(duration));
  try {
    const decision = await reserve(env, "stt", billedSeconds);
    if (decision.status !== "allowed") return jsonError(429, "Groq speech quota reached");
  } catch { return jsonError(503, "Quota service unavailable"); }

  const form = new FormData();
  const file = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  form.set("file", new Blob([file], { type: "audio/wav" }), "utterance.wav");
  form.set("model", STT_MODEL); form.set("response_format", "verbose_json"); form.set("temperature", "0");
  if (language) form.set("language", language);
  const timed = signalFor(request, 60000);
  try {
    const response = await upstream(`${GROQ_ORIGIN}/audio/transcriptions`, {
      method: "POST", headers: { authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form, redirect: "manual", signal: timed.signal,
    });
    if (!response.ok) { await response.body?.cancel(); return jsonError(response.status === 429 ? 429 : 502, "Groq transcription failed"); }
    const result = await boundedJson(response, 64 * 1024);
    if (!isObject(result) || typeof result.text !== "string" || result.text.length > 8000) return jsonError(502, "Unexpected transcription response");
    return new Response(JSON.stringify({ text: result.text, ...(typeof result.language === "string" ? { language: result.language } : {}) }), { headers: jsonHeaders });
  } catch {
    return jsonError(timed.signal.aborted ? 504 : 502, "Groq transcription unavailable");
  } finally { timed.cleanup(); }
}

function wordCount(title: string) { return title.trim().split(/\s+/).filter(Boolean).length; }
function cleanTitle(value: string) {
  const title = value.replace(/[\r\n]+/g, " ").replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/gu, "").replace(/\s+/g, " ").replace(/[.!?。！？,;:]+$/u, "").trim();
  if (!title || title.length > 120 || wordCount(title) < 3 || wordCount(title) > 6 || /["'`“”‘’\p{Extended_Pictographic}]/u.test(title)) return null;
  return title;
}

async function generateTitle(request: Request, env: ServiceEnv, upstream: ServiceUpstream): Promise<Response> {
  if (!env.GROQ_API_KEY) return jsonError(503, "Title generation is not configured");
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return jsonError(415, "JSON required");
  let requestText: string, responseText: string;
  try {
    const body = await readJson(request, TITLE_BODY_LIMIT);
    if (!isObject(body) || Object.keys(body).some(key => key !== "request" && key !== "response")
      || typeof body.request !== "string" || typeof body.response !== "string"
      || !body.request.trim() || body.request.length > TITLE_SOURCE_LIMIT || body.response.length > TITLE_SOURCE_LIMIT) throw new Error("Provide request and response text under 4,000 characters each");
    requestText = body.request.trim(); responseText = body.response.trim();
  } catch (cause) { return jsonError(400, cause instanceof Error ? cause.message : "Invalid title request"); }
  const system = "Generate a concise title for this chat session. Return only a specific title of 3 to 6 words, in the conversation language. No quotes, emoji, prefix, or punctuation at the end.";
  const user = `First user request:\n${requestText}\n\nFirst assistant reply:\n${responseText}`;
  const tokens = new TextEncoder().encode(system + user).byteLength + 80;
  try {
    const decision = await reserve(env, "titles", tokens);
    if (decision.status !== "allowed") return jsonError(429, "Groq title quota reached");
  } catch { return jsonError(503, "Quota service unavailable"); }
  const timed = signalFor(request, 30000);
  try {
    const response = await upstream(`${GROQ_ORIGIN}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: TITLE_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2, max_completion_tokens: 80, reasoning_effort: "none", stream: false }),
      redirect: "manual", signal: timed.signal,
    });
    if (!response.ok) { await response.body?.cancel(); return jsonError(response.status === 429 ? 429 : 502, "Groq title request failed"); }
    const result = await boundedJson(response, 32 * 1024);
    const raw = isObject(result) && Array.isArray(result.choices) && isObject(result.choices[0]) && isObject(result.choices[0].message) ? result.choices[0].message.content : null;
    const title = typeof raw === "string" ? cleanTitle(raw) : null;
    return title ? new Response(JSON.stringify({ title }), { headers: jsonHeaders }) : jsonError(502, "Title response was invalid");
  } catch {
    return jsonError(timed.signal.aborted ? 504 : 502, "Groq title service unavailable");
  } finally { timed.cleanup(); }
}

function ttsUsage(subscription: AnyObject): TtsUsage | null {
  const overage = Number(subscription.current_overage?.amount ?? NaN);
  const extension = subscription.max_credit_limit_extension;
  if (subscription.tier !== "free" || !["free", "active"].includes(subscription.status)
    || subscription.can_extend_character_limit !== false || extension !== 0
    || !Number.isFinite(overage) || overage !== 0
    || !Number.isSafeInteger(subscription.character_count) || subscription.character_count < 0
    || !Number.isSafeInteger(subscription.character_limit) || subscription.character_limit < 0
    || !Number.isSafeInteger(subscription.next_character_count_reset_unix) || subscription.next_character_count_reset_unix <= 0) return null;
  return {
    observedUsed: subscription.character_count,
    resetAt: subscription.next_character_count_reset_unix,
    subscriptionCap: Math.min(TTS_MONTHLY_CREDIT_CAP, subscription.character_limit),
  };
}

type FreeVoice = { voice_id: string; name: string };
function freeDefaultVoices(value: unknown): { id: string; name: string }[] {
  if (!isObject(value) || !Array.isArray(value.voices)) return [];
  return value.voices.filter((voice: unknown): voice is FreeVoice => {
    if (!isObject(voice) || typeof voice.voice_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voice.voice_id)
      || typeof voice.name !== "string" || voice.category !== "premade" || voice.sharing?.free_users_allowed === false) return false;
    const tiers = voice.available_for_tiers;
    if (tiers === undefined) return voice.sharing?.free_users_allowed === true;
    return Array.isArray(tiers) && tiers.every(tier => typeof tier === "string")
      && (tiers.length === 0 || tiers.some(tier => tier.toLowerCase() === "free"));
  })
    .map((voice: FreeVoice) => ({ id: voice.voice_id, name: voice.name }))
    .sort((a: { id: string; name: string }, b: { id: string; name: string }) => a.name.localeCompare(b.name));
}

async function elevenInfo(key: string, upstream: ServiceUpstream, signal?: AbortSignal) {
  const headers = { "xi-api-key": key };
  const [subscriptionResponse, modelsResponse, voicesResponse] = await Promise.all([
    upstream(`${ELEVEN_ORIGIN}/user/subscription`, { headers, redirect: "manual", signal }),
    upstream(`${ELEVEN_ORIGIN}/models`, { headers, redirect: "manual", signal }),
    upstream("https://api.elevenlabs.io/v2/voices?voice_type=default&page_size=100&include_total_count=false", { headers, redirect: "manual", signal }),
  ]);
  if (![subscriptionResponse, modelsResponse, voicesResponse].every(response => response.ok)) throw new Error("ElevenLabs account services unavailable");
  const [subscription, models, voices] = await Promise.all([
    boundedJson(subscriptionResponse, 64 * 1024), boundedJson(modelsResponse, 256 * 1024), boundedJson(voicesResponse, 512 * 1024),
  ]);
  return {
    subscription: isObject(subscription) ? subscription : null,
    modelAvailable: Array.isArray(models) && models.some((model: unknown) => isObject(model) && model.model_id === TTS_MODEL),
    voices: freeDefaultVoices(voices),
  };
}

function socketAudio(response: Response, text: string, voiceId: string, key: string, signal: AbortSignal): Promise<Uint8Array> {
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (!socket) return Promise.reject(new Error("ElevenLabs dialogue socket unavailable"));
  (socket as WebSocket & { accept(): void }).accept();
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0, settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", fail);
      socket.removeEventListener("close", closed);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) { try { socket.close(1011, "generation failed"); } catch {} reject(error); return; }
      if (!size) { reject(new Error("ElevenLabs returned empty audio")); return; }
      const audio = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
      try { socket.close(1000, "complete"); } catch {}
      resolve(audio);
    };
    const abort = () => finish(new DOMException("Request cancelled", "AbortError"));
    const fail = () => finish(new Error("ElevenLabs dialogue failed"));
    const closed = () => { if (!settled) finish(new Error("ElevenLabs dialogue ended early")); };
    const message = (event: MessageEvent) => {
      if (typeof event.data !== "string") { fail(); return; }
      try {
        const frame = JSON.parse(event.data);
        if (!isObject(frame) || frame.error) { fail(); return; }
        if (typeof frame.audio === "string" && frame.audio) {
          const chunk = decodeBase64(frame.audio, TTS_AUDIO_LIMIT);
          size += chunk.byteLength;
          if (size > TTS_AUDIO_LIMIT) { fail(); return; }
          chunks.push(chunk);
        }
        if (frame.is_final === true) finish();
      } catch { fail(); }
    };
    socket.addEventListener("message", message);
    socket.addEventListener("error", fail);
    socket.addEventListener("close", closed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      socket.send(JSON.stringify({ voices: [voiceId], xi_api_key: key }));
      socket.send(JSON.stringify({ inputs: [{ text, voice_id: voiceId, new_turn: true }] }));
      socket.send(JSON.stringify({ close_socket: true }));
    } catch { fail(); }
  });
}

async function synthesize(request: Request, env: ServiceEnv, upstream: ServiceUpstream): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY) return jsonError(503, "Speech output is not configured");
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return jsonError(415, "JSON required");
  let text: string, requestedVoice: string | undefined;
  try {
    const body = await readJson(request, 8 * 1024);
    if (!isObject(body) || Object.keys(body).some(key => key !== "text" && key !== "voiceId")
      || typeof body.text !== "string" || !body.text.trim() || body.text.length > TTS_TEXT_LIMIT
      || body.voiceId !== undefined && (typeof body.voiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.voiceId))) throw new Error("Provide speech text under 1,000 characters and an optional default voice ID");
    text = body.text.trim(); requestedVoice = body.voiceId;
  } catch (cause) { return jsonError(400, cause instanceof Error ? cause.message : "Invalid speech request"); }

  const timed = signalFor(request, 60000);
  try {
    const info = await elevenInfo(env.ELEVENLABS_API_KEY, upstream, timed.signal);
    const usage = info.subscription && ttsUsage(info.subscription);
    const voice = requestedVoice ? info.voices.find(candidate => candidate.id === requestedVoice) : info.voices[0];
    if (!usage || !info.modelAvailable || !voice) return jsonError(403, "No free ElevenLabs voice or monthly allowance is available");
    const credits = Array.from(text).length;
    const decision = await reserve(env, "tts", credits, usage);
    if (decision.status !== "allowed") return jsonError(429, "ElevenLabs free monthly credits exhausted");
    const url = "https://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=mp3_22050_32";
    const response = await upstream(url, { method: "GET", headers: { upgrade: "websocket", "xi-api-key": env.ELEVENLABS_API_KEY }, redirect: "manual", signal: timed.signal });
    if (!response.ok && !(response as Response & { webSocket?: WebSocket }).webSocket) {
      await response.body?.cancel(); return jsonError(response.status === 429 ? 429 : 502, "ElevenLabs speech request failed");
    }
    const audio = await socketAudio(response, text, voice.id, env.ELEVENLABS_API_KEY, timed.signal);
    const copy = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    return new Response(copy, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": String(audio.byteLength) } });
  } catch {
    return jsonError(timed.signal.aborted ? 504 : 502, "ElevenLabs speech service unavailable");
  } finally { timed.cleanup(); }
}

async function capabilities(env: ServiceEnv, upstream: ServiceUpstream): Promise<Response> {
  const now = Date.now();
  let owner = { remaining: 0, resetAt: Math.floor(now / 86400000 + 1) * 86400000, busy: false };
  try {
    const response = await env.OWNER_BUDGET.get(env.OWNER_BUDGET.idFromName("owner-v1")).fetch("https://budget/status");
    if (response.ok) owner = await response.json() as typeof owner;
  } catch {}
  let sttUsage: AnyObject | null = null, titleUsage: AnyObject | null = null;
  try { [sttUsage, titleUsage] = await Promise.all([quotaStatus(env, "stt"), quotaStatus(env, "titles")]); } catch {}
  const reasoningAvailable = !!env.BAI_API_KEY && owner.remaining > 0 && !owner.busy;
  const models = GATEWAY_MODELS.map(model => ({ ...model, available: !!(model.id === 'deepseek-v4.1-flash' ? env.BAI_API_KEY : env.NINE_ROUTER_API_KEY && env.NINE_ROUTER_BASE_URL) && owner.remaining > 0 && !owner.busy }));
  const reasoning = { available: reasoningAvailable, model: "deepseek-v4.1-flash", models, ...(reasoningAvailable ? {} : { reason: !env.BAI_API_KEY ? "Provider key is missing" : owner.busy ? "A request is active" : "Daily request limit reached" }), remaining: owner.remaining, resetAt: owner.resetAt };
  const visionAvailable=reasoningAvailable && env.BAI_VISION_VERIFIED === 'deepseek-v4.1-flash';
  const vision = { available: visionAvailable, model: "deepseek-v4.1-flash", ...(!visionAvailable ? {reason:env.BAI_VISION_VERIFIED === 'deepseek-v4.1-flash' ? 'Reasoning service is unavailable' : 'Waiting for live image and tool verification'} : {}) };
  let groqModels = new Set<string>();
  if (env.GROQ_API_KEY) {
    try {
      const response = await upstream(`${GROQ_ORIGIN}/models`, { headers: { authorization: `Bearer ${env.GROQ_API_KEY}` }, redirect: "manual", signal: AbortSignal.timeout(5000) });
      const result = await boundedJson(response, 512 * 1024);
      if (response.ok && isObject(result) && Array.isArray(result.data)) groqModels = new Set(result.data.filter((model: unknown) => isObject(model) && typeof model.id === "string").map((model: AnyObject) => model.id));
    } catch {}
  }
  const sttAvailable = !!env.GROQ_API_KEY && groqModels.has(STT_MODEL) && (sttUsage?.remainingAudioSeconds ?? 0) > 0 && (sttUsage?.remaining ?? 0) > 0;
  const titlesAvailable = !!env.GROQ_API_KEY && groqModels.has(TITLE_MODEL) && (titleUsage?.remainingTokens ?? 0) > 0 && (titleUsage?.remaining ?? 0) > 0;
  const stt = { available: sttAvailable, model: STT_MODEL, ...(!env.GROQ_API_KEY ? { reason: "Provider key is missing" } : !groqModels.has(STT_MODEL) ? { reason: "Model is unavailable to this account" } : !sttAvailable ? { reason: "Free quota exhausted" } : {}), remaining: sttUsage?.remaining ?? 0, resetAt: sttUsage?.resetAt };
  const titles = { available: titlesAvailable, model: TITLE_MODEL, ...(!env.GROQ_API_KEY ? { reason: "Provider key is missing" } : !groqModels.has(TITLE_MODEL) ? { reason: "Model is unavailable to this account" } : !titlesAvailable ? { reason: "Free quota exhausted" } : {}), remaining: titleUsage?.remaining ?? 0, resetAt: titleUsage?.resetAt };

  let tts: { available: boolean; model: string; reason?: string; remaining?: number; resetAt?: number; voices: { id: string; name: string }[] } = {
    available: false, model: TTS_MODEL, reason: env.ELEVENLABS_API_KEY ? "Free service status unavailable" : "Provider key is missing", voices: [],
  };
  if (env.ELEVENLABS_API_KEY) {
    const timed = AbortSignal.timeout(5000);
    try {
      const info = await elevenInfo(env.ELEVENLABS_API_KEY, upstream, timed);
      const usage = info.subscription && ttsUsage(info.subscription);
      const local = usage ? await quotaStatus(env, "tts", usage) : null;
      const remaining = usage && local ? Math.max(0, Math.min(usage.subscriptionCap, TTS_MONTHLY_CREDIT_CAP) - Math.max(usage.observedUsed, local.used ?? 0)) : 0;
      const available = !!usage && info.modelAvailable && info.voices.length > 0 && remaining > 0;
      tts = { available, model: TTS_MODEL, ...(!usage ? { reason: "Account is not eligible for free-only synthesis" } : !info.modelAvailable ? { reason: "Model is unavailable to this account" } : !info.voices.length ? { reason: "No free default voice is available" } : !available ? { reason: "Free monthly credits exhausted" } : {}), remaining, resetAt: usage ? usage.resetAt * 1000 : undefined, voices: info.voices };
    } catch { tts = { available: false, model: TTS_MODEL, reason: "ElevenLabs account status unavailable", voices: [] }; }
  }
  return new Response(JSON.stringify({
    reasoning, vision, stt, tts, titles,
  }), { headers: jsonHeaders });
}

export async function handleServiceRequest(path: string, request: Request, env: ServiceEnv, upstream: ServiceUpstream = fetch): Promise<Response> {
  switch (path) {
    case "/v1/audio/transcriptions": return request.method === "POST" ? transcribe(request, env, upstream) : jsonError(405, "POST required");
    case "/v1/audio/speech": return request.method === "POST" ? synthesize(request, env, upstream) : jsonError(405, "POST required");
    case "/v1/chat/titles": return request.method === "POST" ? generateTitle(request, env, upstream) : jsonError(405, "POST required");
    case "/v1/capabilities": return request.method === "GET" ? capabilities(env, upstream) : jsonError(405, "GET required");
    default: return jsonError(404, "Not found");
  }
}
