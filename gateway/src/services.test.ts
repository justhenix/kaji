import { describe, expect, test } from "bun:test";
import { OwnerBudget, reserveService, type Storage, type TtsUsage } from "./budget";
import { handle, STT_MODEL, TITLE_MODEL, TTS_MODEL, TTS_MONTHLY_CREDIT_CAP, type Env } from "./index";

const token = `test-${"a".repeat(40)}`;
const tokenHash = new Bun.CryptoHasher("sha256").update(token).digest("hex");

class MemoryStorage implements Storage {
  private values = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  transaction<T>(callback: (transaction: Storage) => Promise<T>): Promise<T> {
    const result: Promise<T> = this.tail.then(() => callback(this));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function fixture(): Env {
  const budget = new OwnerBudget({ storage: new MemoryStorage() });
  return {
    BAI_API_KEY: "bai-test-key", GROQ_API_KEY: "groq-test-key", ELEVENLABS_API_KEY: "eleven-test-key", GATEWAY_TOKEN_SHA256: tokenHash,
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    OWNER_BUDGET: { idFromName: name => name, get: () => ({ fetch: (url, init) => budget.fetch(new Request(url, init)) }) },
  };
}

function request(path: string, body?: unknown, extra: RequestInit = {}) {
  return new Request(`https://gateway.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
  });
}

function wav(seconds = 1, rate = 16000) {
  const payloadBytes = seconds * rate * 2, data = new Uint8Array(44 + payloadBytes), view = new DataView(data.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) data[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, data.length - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, payloadBytes, true);
  return data;
}
const wavBase64 = (seconds = 1) => Buffer.from(wav(seconds)).toString("base64");
const providerJson = (body: unknown, status = 200) => Response.json(body, { status });

class FakeSocket extends EventTarget {
  frames: Record<string, any>[] = [];
  closed = false;
  accept() {}
  send(raw: string) {
    const frame = JSON.parse(raw); this.frames.push(frame);
    if (frame.close_socket) queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ audio: btoa("audio-bytes"), is_final: true }) })));
  }
  close() { this.closed = true; }
}
class PendingSocket extends EventTarget {
  closed = false;
  accept() {}
  send(_raw: string) {}
  close() { this.closed = true; }
}

const subscription = (overrides: Record<string, unknown> = {}) => ({
  tier: "free", status: "free", character_count: 0, character_limit: 10000,
  max_credit_limit_extension: 0, can_extend_character_limit: false,
  current_overage: { amount: "0" }, next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 86400,
  ...overrides,
});
const voiceList = { voices: [
  { voice_id: "free-voice", name: "Ari", category: "premade", available_for_tiers: [] },
  { voice_id: "paid-voice", name: "Zed", category: "premade", available_for_tiers: ["creator"] },
] };

describe("provider routes", () => {
  test("Groq STT pins model, validates WAV, and supplies app vocabulary with language selection", async () => {
    const env = fixture(); let form: FormData | undefined;
    const response = await handle(request("/v1/audio/transcriptions", { wavBase64: wavBase64(), language: "id" }), env, async (url, init) => {
      expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer groq-test-key");
      form = init?.body as FormData;
      return providerJson({ text: "Halo Kaji", language: "indonesian" });
    });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ text: "Halo Kaji", language: "indonesian" });
    expect(form?.get("model")).toBe(STT_MODEL); expect(form?.get("language")).toBe("id");
    expect(form?.get("prompt")).toContain("Kaji");
    expect(form?.get("prompt")).toContain("dwell");
    expect(form?.get("prompt")).toContain("kontrol kepala");
    expect((form?.get("file") as File).type).toBe("audio/wav");
  });

  test("STT rejects invalid format, duration, and provider quota without fallback", async () => {
    const env = fixture(); let calls = 0;
    const upstream = async () => { calls++; return providerJson({ text: "unexpected" }); };
    const badRate = Buffer.from(wav(1, 44100)).toString("base64");
    expect((await handle(request("/v1/audio/transcriptions", { wavBase64: badRate }), env, upstream)).status).toBe(400);
    expect((await handle(request("/v1/audio/transcriptions", { wavBase64: wavBase64(31) }), env, upstream)).status).toBe(413);
    const providerLimited = await handle(request("/v1/audio/transcriptions", { wavBase64: wavBase64() }), env, async () => { calls++; return new Response("limit", { status: 429 }); });
    expect(providerLimited.status).toBe(429); expect(calls).toBe(1);
  });

  test("client cancellation reaches Groq and never retries", async () => {
    const env = fixture(), controller = new AbortController(); let started!: () => void, signal: AbortSignal | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = handle(request("/v1/audio/transcriptions", { wavBase64: wavBase64() }, { signal: controller.signal }), env, (_url, init) => {
      signal = init?.signal!; started();
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    await ready; controller.abort();
    expect((await pending).status).toBe(504); expect(signal?.aborted).toBeTrue();
  });

  test("Eleven free TTS selects free default voice, pins v4 turbo, and enforces 10,000 credits", async () => {
    const env = fixture(); env.ELEVENLABS_API_KEY = "eleven-test-key";
    const used = subscription({ character_count: 9997 }); let socketCalls = 0, socket: FakeSocket | undefined;
    const upstream = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/user/subscription")) return providerJson(used);
      if (url.endsWith("/models")) return providerJson([{ model_id: TTS_MODEL }]);
      if (url.includes("/voices?")) return providerJson(voiceList);
      expect(url).toContain("/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=mp3_22050_32");
      expect(new Headers(init?.headers).get("xi-api-key")).toBe("eleven-test-key");
      expect(new Headers(init?.headers).get("upgrade")).toBe("websocket");
      socketCalls++; socket = new FakeSocket();
      return Object.assign(new Response(null), { webSocket: socket });
    };
    const response = await handle(request("/v1/audio/speech", { text: "Hi." }), env, upstream);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("audio-bytes");
    expect(socket?.frames).toEqual([{ voices: ["free-voice"], xi_api_key: "eleven-test-key" }, { inputs: [{ text: "Hi.", voice_id: "free-voice", new_turn: true }] }, { close_socket: true }]);
    expect(TTS_MONTHLY_CREDIT_CAP).toBe(10000);
    const exhausted = await handle(request("/v1/audio/speech", { text: "x" }), env, upstream);
    expect(exhausted.status).toBe(429); expect(socketCalls).toBe(1);
  });

  test("Eleven cancellation closes active socket and does not retry", async () => {
    const env = fixture(), controller = new AbortController(); let connected!: () => void, socket: PendingSocket | undefined, socketCalls = 0;
    const ready = new Promise<void>(resolve => { connected = resolve; });
    const upstream = async (url: string) => {
      if (url.endsWith("/user/subscription")) return providerJson(subscription());
      if (url.endsWith("/models")) return providerJson([{ model_id: TTS_MODEL }]);
      if (url.includes("/voices?")) return providerJson(voiceList);
      socketCalls++; socket = new PendingSocket(); connected();
      return Object.assign(new Response(null), { webSocket: socket });
    };
    const pending = handle(request("/v1/audio/speech", { text: "One line." }, { signal: controller.signal }), env, upstream);
    await ready; controller.abort();
    expect((await pending).status).toBe(504); expect(socket?.closed).toBeTrue(); expect(socketCalls).toBe(1);
  });

  test("paid Eleven account and non-free voice are never synthesized", async () => {
    const env = fixture();
    let socketCalls = 0;
    const upstream = async (url: string) => {
      if (url.endsWith("/user/subscription")) return providerJson(subscription({ tier: "starter" }));
      if (url.endsWith("/models")) return providerJson([{ model_id: TTS_MODEL }]);
      if (url.includes("/voices?")) return providerJson(voiceList);
      socketCalls++; return new Response(null);
    };
    const response = await handle(request("/v1/audio/speech", { text: "Hello.", voiceId: "paid-voice" }), env, upstream);
    expect(response.status).toBe(403); expect(socketCalls).toBe(0);
  });

  test("Eleven rejects inactive, overage-enabled, and restricted default voices before synthesis", async () => {
    const cases = [
      { account: { status: "canceled" }, voices: voiceList },
      { account: { can_extend_character_limit: true }, voices: voiceList },
      { account: { max_credit_limit_extension: "unlimited" }, voices: voiceList },
      { account: { current_overage: { amount: "0.01" } }, voices: voiceList },
      { account: {}, voices: { voices: [{ voice_id: "blocked", name: "Blocked", category: "premade", available_for_tiers: ["creator"] }] } },
      { account: {}, voices: { voices: [{ voice_id: "blocked", name: "Blocked", category: "premade", available_for_tiers: [], sharing: { free_users_allowed: false } }] } },
      { account: {}, voices: { voices: [{ voice_id: "blocked", name: "Blocked", category: "professional", available_for_tiers: ["free"] }] } },
    ];
    for (const { account, voices } of cases) {
      let socketCalls = 0;
      const upstream = async (url: string) => {
        if (url.endsWith("/user/subscription")) return providerJson(subscription(account));
        if (url.endsWith("/models")) return providerJson([{ model_id: TTS_MODEL }]);
        if (url.includes("/voices?")) return providerJson(voices);
        socketCalls++; return new Response(null);
      };
      expect((await handle(request("/v1/audio/speech", { text: "Hello." }), fixture(), upstream)).status).toBe(403);
      expect(socketCalls).toBe(0);
    }
  });

  test("title route uses exact Groq model settings and normalizes only valid titles", async () => {
    const env = fixture(); let payload: any;
    const response = await handle(request("/v1/chat/titles", { request: "Buat ringkasan rapat", response: "Saya akan memeriksa catatan." }), env, async (url, init) => {
      expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
      payload = JSON.parse(init!.body as string);
      return providerJson({ choices: [{ message: { content: "  Ringkasan catatan rapat!  " } }] });
    });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ title: "Ringkasan catatan rapat" });
    expect(payload).toMatchObject({ model: TITLE_MODEL, temperature: 0.2, max_completion_tokens: 80, reasoning_effort: "none", stream: false });
    const invalid = await handle(request("/v1/chat/titles", { request: "short", response: "ok" }), env, async () => providerJson({ choices: [{ message: { content: "Rapat selesai" } }] }));
    expect(invalid.status).toBe(502);
  });

  test("out-of-order title responses remain isolated per request", async () => {
    const env = fixture(); let resolveA!: (response: Response) => void, resolveB!: (response: Response) => void, ready!: () => void;
    const waitA = new Promise<Response>(resolve => { resolveA = resolve; });
    const waitB = new Promise<Response>(resolve => { resolveB = resolve; });
    const both = new Promise<void>(resolve => { ready = resolve; }); let count = 0;
    const upstream = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string), prompt = body.messages[1].content as string;
      if (++count === 2) ready();
      return prompt.includes("REQUEST_ALPHA") ? waitA : waitB;
    };
    const alpha = handle(request("/v1/chat/titles", { request: "REQUEST_ALPHA", response: "First response" }), env, upstream);
    const beta = handle(request("/v1/chat/titles", { request: "REQUEST_BETA", response: "Second response" }), env, upstream);
    await both;
    resolveB(providerJson({ choices: [{ message: { content: "Beta task title" } }] }));
    expect(await (await beta).json()).toEqual({ title: "Beta task title" });
    resolveA(providerJson({ choices: [{ message: { content: "Alpha task title" } }] }));
    expect(await (await alpha).json()).toEqual({ title: "Alpha task title" });
  });

  test("capabilities expose only selected provider services and free default voices", async () => {
    const env = fixture();
    const upstream = async (url: string) => {
      if (url === "https://api.groq.com/openai/v1/models") return providerJson({ data: [{ id: STT_MODEL }, { id: TITLE_MODEL }] });
      if (url.endsWith("/user/subscription")) return providerJson(subscription());
      if (url.endsWith("/models")) return providerJson([{ model_id: TTS_MODEL }]);
      if (url.includes("/voices?")) return providerJson(voiceList);
      throw new Error("Unexpected provider route");
    };
    const response = await handle(request("/v1/capabilities"), env, upstream);
    const result = await response.json() as any;
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ reasoning: { available: true, model: "deepseek-v4.1-flash" }, vision: { available: false }, stt: { available: true, model: STT_MODEL }, titles: { available: true, model: TITLE_MODEL }, tts: { available: true, model: TTS_MODEL, voices: [{ id: "free-voice", name: "Ari" }] } });
    const verified=await handle(request('/v1/capabilities'), {...env,BAI_VISION_VERIFIED:'deepseek-v4.1-flash'},upstream);
    expect((await verified.json() as any).vision.available).toBeTrue();
  });

  test("service quota reservations are atomic across concurrent calls and windows", async () => {
    const tts: TtsUsage = { observedUsed: 9990, resetAt: 1790000000, subscriptionCap: 10000 };
    const first = reserveService(undefined, 100000, "tts", 6, tts), second = reserveService(first.record, 100001, "tts", 5, tts);
    expect(first.status).toBe("allowed"); expect(second.status).toBe("monthly_limit");
    const budget = new OwnerBudget({ storage: new MemoryStorage() });
    const reserveCall = (units: number) => budget.fetch(new Request("https://budget/service/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "tts", units, ...tts }) })).then(response => response.json()) as Promise<any>;
    const concurrent = await Promise.all([reserveCall(6), reserveCall(5)]);
    expect(concurrent.filter(result => result.status === "allowed")).toHaveLength(1);
    expect(concurrent.filter(result => result.status === "monthly_limit")).toHaveLength(1);
    const minute = reserveService(undefined, 300000, "titles", 8000);
    expect(minute.status).toBe("allowed");
    expect(reserveService(minute.record, 300001, "titles", 1).status).toBe("minute_token_limit");
    let eventRecord: any;
    for (let i = 0; i < 20; i++) {
      const decision = reserveService(eventRecord, 500000, "stt", 1);
      expect(decision.status).toBe("allowed"); eventRecord = decision.record;
    }
    expect(reserveService(eventRecord, 500001, "stt", 1).status).toBe("minute_limit");
    expect(reserveService(undefined, 700000, "stt", 7200).status).toBe("allowed");
    expect(reserveService({ events: [{ at: 700000, units: 7200 }] }, 700001, "stt", 1).status).toBe("hourly_audio_limit");
  });
});
