import type { Storage } from './budget';

export interface DeviceBinding {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}
type Device = { revoked: boolean; day: number; counts: Record<string, number> };
const limits: Record<string, number> = { chat: 100, stt: 200, tts: 100, titles: 100 };
const json = (status: number) => Response.json({ ok: status === 200 }, { status });

// Only hashes and counters are stored. The owner credential and global budgets stay separate.
export class DeviceRegistry {
  constructor(private readonly state: { storage: Storage }) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json(405);
    const path = new URL(request.url).pathname;
    const body = await request.json() as { digest?: string; ip?: string; scope?: string };
    if (!/^[a-f0-9]{64}$/.test(body.digest ?? '')) return json(400);
    const digest = body.digest!, day = Math.floor(Date.now() / 86400000);
    return this.state.storage.transaction(async storage => {
      const key = `device:${digest}`;
      const device = await storage.get<Device>(key);
      if (device?.revoked) return json(403);
      if (path === '/enroll') {
        if (device) return json(200);
        if (!/^[a-f0-9]{64}$/.test(body.ip ?? '')) return json(400);
        const admission = await storage.get<{ day: number; count: number; ips: Record<string, number> }>('admission');
        const current = admission?.day === day ? admission : { day, count: 0, ips: {} };
        if (current.count >= 100 || (current.ips[body.ip!] ?? 0) >= 5) return json(429);
        current.count++; current.ips[body.ip!] = (current.ips[body.ip!] ?? 0) + 1;
        await storage.put('admission', current);
        await storage.put(key, { revoked: false, day, counts: {} });
        return json(200);
      }
      if (path !== '/authorize') return json(404);
      if (!device) return json(401);
      const scope = body.scope ?? '';
      if (scope === 'session' || scope === 'capabilities') return json(200);
      if (!(scope in limits)) return json(400);
      const counts = device.day === day ? device.counts : {};
      if ((counts[scope] ?? 0) >= limits[scope]!) return json(429);
      counts[scope] = (counts[scope] ?? 0) + 1;
      await storage.put(key, { ...device, day, counts });
      return json(200);
    });
  }
}

export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
