type Record = { day: number; count: number; lease: string | null; expires: number };
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (transaction: Storage) => Promise<T>): Promise<T>;
}
export function reserve(previous: Record | undefined, now: number, lease: string) {
  const day = Math.floor(now / 86400000);
  const record: Record = { day, count: previous?.day === day ? previous.count : 0, lease: previous?.lease ?? null, expires: previous?.expires ?? 0 };
  if (record.lease && record.expires > now) return { status: "busy" as const, record };
  if (record.count >= 200) return { status: "daily_limit" as const, record };
  return { status: "allowed" as const, record: { ...record, count: record.count + 1, lease, expires: now + 65000 } };
}
// One server-side object serializes the owner's quota across all Cloudflare locations.
// It stores counters and an expiring lease, never prompts, responses or credentials.
export class OwnerBudget {
  constructor(private readonly state: { storage: Storage }) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/acquire", "/release"].includes(path)) return new Response(null, { status: 404 });
    const releaseLease = path === "/release" ? await request.text() : null;
    const result = await this.state.storage.transaction(async storage => {
      const record = await storage.get<Record>("owner");
      if (path === "/release") {
        if (record?.lease === releaseLease) await storage.put("owner", { ...record, lease: null, expires: 0 });
        return { status: "released" };
      }
      const lease = crypto.randomUUID(), decision = reserve(record, Date.now(), lease);
      if (decision.status === "allowed") await storage.put("owner", decision.record);
      return { status: decision.status, lease: decision.status === "allowed" ? lease : undefined };
    });
    return Response.json(result);
  }
}
