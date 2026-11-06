type OwnerRecord = { day: number; count: number; lease: string | null; expires: number };
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (transaction: Storage) => Promise<T>): Promise<T>;
}

export function reserve(previous: OwnerRecord | undefined, now: number, lease: string, limit = 200) {
  const day = Math.floor(now / 86400000);
  const record: OwnerRecord = { day, count: previous?.day === day ? previous.count : 0, lease: previous?.lease ?? null, expires: previous?.expires ?? 0 };
  if (record.lease && record.expires > now) return { status: "busy" as const, record };
  if (record.count >= limit) return { status: "daily_limit" as const, record };
  return { status: "allowed" as const, record: { ...record, count: record.count + 1, lease, expires: now + 65000 } };
}

export type ServiceName = "stt" | "titles" | "tts";
type ServiceEvent = { at: number; units: number };
type ServiceRecord = { events: ServiceEvent[]; periodResetAt?: number; monthUsed?: number };
export type TtsUsage = { observedUsed: number; resetAt: number; subscriptionCap: number };
type TtsStatus = { service: "tts"; used: number; limit: number; remaining: number; resetAt: number };
type SttStatus = { service: "stt"; requestsMinute: number; requestsDay: number; secondsHour: number; secondsDay: number; remaining: number; remainingAudioSeconds: number; resetAt: number };
type TitleStatus = { service: "titles"; requestsMinute: number; requestsDay: number; tokensMinute: number; tokensDay: number; remaining: number; remainingTokens: number; resetAt: number };
type RequestStatus = SttStatus | TitleStatus;

export const SERVICE_LIMITS = {
  stt: { requestsMinute: 20, requestsDay: 2000, unitsHour: 7200, unitsDay: 28800 },
  titles: { requestsMinute: 30, requestsDay: 1000, unitsMinute: 8000, unitsDay: 200000 },
  tts: { monthlyCredits: 10000 },
} as const;

function recent(events: ServiceEvent[], now: number) { return events.filter(event => event.at > now - 86400000 && Number.isSafeInteger(event.units) && event.units > 0); }
function sum(events: ServiceEvent[]) { return events.reduce((total, event) => total + event.units, 0); }

export function serviceStatus(previous: ServiceRecord | undefined, now: number, service: "tts", tts: TtsUsage): TtsStatus;
export function serviceStatus(previous: ServiceRecord | undefined, now: number, service: "stt" | "titles", tts?: undefined): RequestStatus;
export function serviceStatus(previous: ServiceRecord | undefined, now: number, service: ServiceName, tts?: TtsUsage): TtsStatus | RequestStatus {
  if (service === "tts") {
    if (!tts || !Number.isSafeInteger(tts.observedUsed) || tts.observedUsed < 0 || !Number.isSafeInteger(tts.resetAt) || tts.resetAt <= 0 || !Number.isSafeInteger(tts.subscriptionCap) || tts.subscriptionCap < 0) throw new Error("Invalid TTS usage");
    const local = previous?.periodResetAt === tts.resetAt ? previous.monthUsed ?? 0 : 0;
    const used = Math.max(local, tts.observedUsed);
    const limit = Math.min(SERVICE_LIMITS.tts.monthlyCredits, tts.subscriptionCap);
    return { service, used, limit, remaining: Math.max(0, limit - used), resetAt: tts.resetAt };
  }
  const events = recent(previous?.events ?? [], now);
  const minute = events.filter(event => event.at > now - 60000);
  if (service === "stt") {
    const hour = events.filter(event => event.at > now - 3600000);
    const requestsMinute = minute.length, requestsDay = events.length, secondsHour = sum(hour), secondsDay = sum(events);
    return {
      service, requestsMinute, requestsDay, secondsHour, secondsDay,
      remaining: Math.max(0, Math.min(SERVICE_LIMITS.stt.requestsMinute - requestsMinute, SERVICE_LIMITS.stt.requestsDay - requestsDay)),
      remainingAudioSeconds: Math.max(0, Math.min(SERVICE_LIMITS.stt.unitsHour - secondsHour, SERVICE_LIMITS.stt.unitsDay - secondsDay)),
      resetAt: Math.min(...events.map(event => event.at + 86400000), now + 86400000),
    };
  }
  const requestsMinute = minute.length, requestsDay = events.length, tokensMinute = sum(minute), tokensDay = sum(events);
  return {
    service, requestsMinute, requestsDay, tokensMinute, tokensDay,
    remaining: Math.max(0, Math.min(SERVICE_LIMITS.titles.requestsMinute - requestsMinute, SERVICE_LIMITS.titles.requestsDay - requestsDay)),
    remainingTokens: Math.max(0, Math.min(SERVICE_LIMITS.titles.unitsMinute - tokensMinute, SERVICE_LIMITS.titles.unitsDay - tokensDay)),
    resetAt: Math.min(...events.map(event => event.at + 86400000), now + 86400000),
  };
}

export function reserveService(previous: ServiceRecord | undefined, now: number, service: ServiceName, units: number, tts?: TtsUsage) {
  if (!Number.isSafeInteger(units) || units < 1) throw new Error("Service usage must be a positive integer");
  if (service === "tts") {
    const status = serviceStatus(previous, now, "tts", tts!);
    if (status.used + units > status.limit) return { status: "monthly_limit" as const, usage: status, record: previous };
    return {
      status: "allowed" as const,
      usage: { ...status, used: status.used + units, remaining: status.remaining - units },
      record: { events: [], periodResetAt: status.resetAt, monthUsed: status.used + units },
    };
  }
  const events = recent(previous?.events ?? [], now);
  const event = { at: now, units };
  if (service === "stt") {
    const status = serviceStatus({ events }, now, "stt") as SttStatus;
    const next = { ...status, requestsMinute: status.requestsMinute + 1, requestsDay: status.requestsDay + 1, secondsHour: status.secondsHour + units, secondsDay: status.secondsDay + units };
    const limit = next.requestsMinute > SERVICE_LIMITS.stt.requestsMinute ? "minute_limit"
      : next.requestsDay > SERVICE_LIMITS.stt.requestsDay ? "daily_limit"
      : next.secondsHour > SERVICE_LIMITS.stt.unitsHour ? "hourly_audio_limit"
      : next.secondsDay > SERVICE_LIMITS.stt.unitsDay ? "daily_audio_limit" : null;
    if (limit) return { status: limit as "minute_limit" | "daily_limit" | "hourly_audio_limit" | "daily_audio_limit", usage: status, record: previous };
    const record = { events: [...events, event] };
    return { status: "allowed" as const, usage: serviceStatus(record, now, service), record };
  }
  const status = serviceStatus({ events }, now, "titles") as TitleStatus;
  const next = { ...status, requestsMinute: status.requestsMinute + 1, requestsDay: status.requestsDay + 1, tokensMinute: status.tokensMinute + units, tokensDay: status.tokensDay + units };
  const limit = next.requestsMinute > SERVICE_LIMITS.titles.requestsMinute ? "minute_limit"
    : next.requestsDay > SERVICE_LIMITS.titles.requestsDay ? "daily_limit"
    : next.tokensMinute > SERVICE_LIMITS.titles.unitsMinute ? "minute_token_limit"
    : next.tokensDay > SERVICE_LIMITS.titles.unitsDay ? "daily_token_limit" : null;
  if (limit) return { status: limit as "minute_limit" | "daily_limit" | "minute_token_limit" | "daily_token_limit", usage: status, record: previous };
  const record = { events: [...events, event] };
  return { status: "allowed" as const, usage: serviceStatus(record, now, service), record };
}

function parseServiceBody(value: unknown): { service: ServiceName; units?: number; tts?: TtsUsage } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid service quota request");
  const body = value as Record<string, unknown>;
  if (!("service" in body) || !["stt", "titles", "tts"].includes(String(body.service))) throw new Error("Invalid service quota request");
  const service = body.service as ServiceName;
  if (service === "tts") {
    const tts = { observedUsed: body.observedUsed, resetAt: body.resetAt, subscriptionCap: body.subscriptionCap };
    if (![tts.observedUsed, tts.resetAt, tts.subscriptionCap].every(Number.isSafeInteger)) throw new Error("Invalid TTS usage");
    return { service, units: body.units as number | undefined, tts: tts as TtsUsage };
  }
  return { service, units: body.units as number | undefined };
}

// One server-side object serializes request quotas and owner credits across Cloudflare locations.
// It stores counters and expiring leases, never prompts, audio, responses or credentials.
export class OwnerBudget {
  private readonly dailyLimit: number;
  constructor(private readonly state: { storage: Storage }, env?: { REASONING_DAILY_REQUEST_CAP?: string }) {
    const configured = Number(env?.REASONING_DAILY_REQUEST_CAP);
    this.dailyLimit = Number.isSafeInteger(configured) && configured >= 200 && configured <= 1000 ? configured : 200;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      const record = await this.state.storage.get<OwnerRecord>("owner"), day = Math.floor(Date.now() / 86400000);
      const used = record?.day === day ? record.count : 0;
      const now = Date.now();
      return Response.json({ used, limit: this.dailyLimit, remaining: Math.max(0, this.dailyLimit - used), busy: !!record?.lease && record.expires > now, resetAt: (day + 1) * 86400000 });
    }
    if (request.method === "POST" && ["/service/reserve", "/service/status"].includes(path)) {
      let body: ReturnType<typeof parseServiceBody>;
      try { body = parseServiceBody(await request.json()); }
      catch { return Response.json({ error: "Invalid service quota request" }, { status: 400 }); }
      const key = `service:${body.service}`;
      const result = await this.state.storage.transaction(async storage => {
        const previous = await storage.get<ServiceRecord>(key), now = Date.now();
        if (path === "/service/status") return body.service === "tts"
          ? serviceStatus(previous, now, "tts", body.tts!)
          : serviceStatus(previous, now, body.service);
        if (body.units === undefined) throw new Error("Service reservation requires units");
        const decision = reserveService(previous, now, body.service, body.units, body.tts);
        if (decision.status === "allowed" && decision.record) await storage.put(key, decision.record);
        return { status: decision.status, usage: decision.usage };
      });
      return Response.json(result);
    }
    if (request.method !== "POST" || !["/acquire", "/release"].includes(path)) return new Response(null, { status: 404 });
    const releaseLease = path === "/release" ? await request.text() : null;
    const result = await this.state.storage.transaction(async storage => {
      const record = await storage.get<OwnerRecord>("owner");
      if (path === "/release") {
        if (record?.lease === releaseLease) await storage.put("owner", { ...record, lease: null, expires: 0 });
        return { status: "released" };
      }
      const lease = crypto.randomUUID(), decision = reserve(record, Date.now(), lease, this.dailyLimit);
      if (decision.status === "allowed") await storage.put("owner", decision.record);
      return { status: decision.status, lease: decision.status === "allowed" ? lease : undefined };
    });
    return Response.json(result);
  }
}
