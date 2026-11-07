import { test, expect } from 'bun:test';
import { DeviceRegistry, sha256 } from './devices';
import { handle, type Env } from './index';
import type { Storage } from './budget';

function storage(): Storage {
  const values = new Map<string, unknown>();
  let previous = Promise.resolve();
  const result: Storage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    transaction<T>(callback: (s: Storage) => Promise<T>) {
      const pending = previous.then(() => callback(result)); previous = pending.then(() => {}, () => {}); return pending;
    },
  };
  return result;
}
function setup() {
  const state = storage(), registry = new DeviceRegistry({ storage: state });
  const env: Env = {
    GATEWAY_TOKEN_SHA256: 'f'.repeat(64), BAI_API_KEY: 'test-provider-only',
    DEVICES: { idFromName: name => name, get: () => ({ fetch: (url, init) => registry.fetch(new Request(url, init)) }) },
    REQUEST_LIMIT: { limit: async () => ({ success: true }) }, ENROLL_LIMIT: { limit: async () => ({ success: true }) },
    OWNER_BUDGET: { idFromName: name => name, get: () => ({ fetch: async url => Response.json(url.endsWith('/acquire') ? { status: 'allowed', lease: 'fixture' } : { status: 'released' }) }) },
  };
  const call = (path: string, token: string, extra: Record<string, string> = {}) => handle(new Request(`https://gateway.test/v1/${path}`, {
    method: path.endsWith('session') ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '192.0.2.1', ...extra },
  }), env);
  return { env, state, call };
}
test('fresh device enrolls idempotently and reconnects; another credential is still rejected', async () => {
  const { call, state } = setup(), token = 'kd_' + 'a'.repeat(64);
  expect((await call('devices/session', token)).status).toBe(401);
  for (let i = 0; i < 3; i++) expect((await call('devices/enroll', token)).status).toBe(200);
  expect((await call('devices/session', token)).status).toBe(200);
  expect((await call('devices/session', 'kd_' + 'b'.repeat(64))).status).toBe(401);
  expect((await call('devices/enroll', token, { origin: 'https://evil.test' })).status).toBe(403);
  await state.put(`device:${await sha256(token)}`, { revoked: true });
  expect((await call('devices/enroll', token)).status).toBe(403);
  expect((await call('devices/session', token)).status).toBe(403);
});
test('atomic per-IP admission and per-device quotas preserve aggregate provider budgets', async () => {
  const { call, env } = setup();
  const tokens = Array.from({ length: 6 }, (_, i) => 'kd_' + i.toString(16).repeat(64));
  const enrolled = await Promise.all(tokens.map(token => call('devices/enroll', token)));
  expect(enrolled.filter(result => result.status === 200)).toHaveLength(5);
  expect(enrolled.filter(result => result.status === 429)).toHaveLength(1);
  let upstreamCalls = 0, globalReservations = 0;
  env.OWNER_BUDGET.get = () => ({ fetch: async url => { if (url.endsWith('/acquire')) globalReservations++; return Response.json(url.endsWith('/acquire') ? { status: 'allowed', lease: 'fixture' } : { status: 'released' }); } });
  for (let i = 0; i < 101; i++) {
    const result = await handle(new Request('https://gateway.test/v1/chat/completions', { method: 'POST', headers: {
      authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) }), env, async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-provider-only');
      upstreamCalls++; return Response.json({ choices: [{ message: { content: 'Hello' } }] });
    });
    expect(result.status).toBe(i < 100 ? 200 : 429); await result.text();
  }
  expect(upstreamCalls).toBe(100); expect(globalReservations).toBe(100);
});
test('anonymous enrollment fails closed without registration storage, IP identity, or rate limiting', async () => {
  const { call, env } = setup();
  env.ENROLL_LIMIT = undefined;
  expect((await call('devices/enroll', 'kd_' + 'a'.repeat(64))).status).toBe(503);
  env.ENROLL_LIMIT = { limit: async () => ({ success: false }) };
  expect((await call('devices/enroll', 'kd_' + 'a'.repeat(64))).status).toBe(429);
  expect((await call('devices/enroll', 'owner_secret_' + 'a'.repeat(40))).status).toBe(400);
});
