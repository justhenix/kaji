import { describe, test, expect } from "bun:test";
import { handle, MODEL, validate, type Env, type Upstream } from "./index";

const token = "test-" + "a".repeat(40);
const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
const env = (): Env => ({ BAI_API_KEY: "upstream-secret", GATEWAY_TOKEN_SHA256: hash, REQUEST_LIMIT: { limit: async () => ({ success: true }) }, OWNER_BUDGET: { idFromName: name => name, get: () => ({ fetch: async url => Response.json(url.endsWith("/acquire") ? { status: "allowed", lease: "test-lease" } : { status: "released" }) }) } });
const request = (body: unknown = { messages: [{ role: "user", content: "Hello" }] }, extra: RequestInit = {}) => new Request("https://gateway.test/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), ...extra });
const json: Upstream = (async () => Response.json({ choices: [{ message: { content: "Hello" } }] })) as Upstream;
describe("gateway trust boundary", () => {
  test("requires runtime authentication and fails closed without secrets", async () => {
    expect((await handle(request(undefined, { headers: { "content-type": "application/json" } }), env(), json)).status).toBe(401);
    expect((await handle(request(undefined, { headers: { authorization: `Bearer ${"b".repeat(40)}`, "content-type": "application/json" } }), env(), json)).status).toBe(401);
    expect((await handle(request(), { ...env(), BAI_API_KEY: "" }, json)).status).toBe(503);
  });
  test("pins provider URL/model, bounds output and replaces authorization", async () => {
    const upstream = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.b.ai/v1/chat/completions");
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer upstream-secret");
      expect(JSON.parse(init!.body as string)).toMatchObject({ model: MODEL, max_tokens: 2048, parallel_tool_calls: false });
      expect(init!.redirect).toBe("manual");
      return json(url, init);
    }) as Upstream;
    const response = await handle(request(), env(), upstream);
    expect(response.status).toBe(200); expect(await response.json()).toHaveProperty("choices");
    for (const body of [{ model: "other" }, { max_tokens: 4097 }, { max_tokens: 0 }, { max_tokens: 50, max_completion_tokens: 100 }, { base_url: "https://evil.test" }]) {
      expect(() => validate({ messages: [{ role: "user", content: "test" }], ...body })).toThrow();
    }
  });
  test("rejects browser calls, oversized chunked bodies and nontext content", async () => {
    const r = request(); r.headers.set("origin", "https://kaji.henix.my.id");
    expect((await handle(r, env(), json)).status).toBe(403);
    expect((await handle(request({ messages: [{ role: "user", content: "a".repeat(262144) }] }), env(), json)).status).toBe(413);
    expect((await handle(request({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://private.test" } }] }] }), env(), json)).status).toBe(400);
  });
  test("accepts function calls and matching tool history", () => {
    expect(validate({ messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }).messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(validate({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "desktop_inspect", arguments: "{}" } }] }, { role: "tool", content: "{}", tool_call_id: "c1" }], tools: [{ type: "function", function: { name: "desktop_inspect", parameters: { type: "object" } } }] }).model).toBe(MODEL);
    expect(() => validate({ messages: [{ role: "tool", content: "missing call ID" }] })).toThrow();
  });
  test("rate limit and limiter failure prevent provider calls", async () => {
    let called = false; const noFetch = (async () => { called = true; return json(""); }) as Upstream;
    const e = env(); e.REQUEST_LIMIT.limit = async () => ({ success: false });
    expect((await handle(request(), e, noFetch)).status).toBe(429);
    e.REQUEST_LIMIT.limit = async () => { throw new Error("unavailable"); };
    expect((await handle(request(), e, noFetch)).status).toBe(503); expect(called).toBeFalse();
  });
  test("global quota denial and failure never dispatch a provider request", async () => {
    let called = false; const noFetch: Upstream = async () => { called = true; return Response.json({}); };
    const e = env();
    e.OWNER_BUDGET.get = () => ({ fetch: async () => Response.json({ status: "daily_limit" }) });
    expect((await handle(request(), e, noFetch)).status).toBe(429);
    e.OWNER_BUDGET.get = () => ({ fetch: async () => { throw new Error("offline"); } });
    expect((await handle(request(), e, noFetch)).status).toBe(503); expect(called).toBeFalse();
  });
  test("redacts upstream errors and headers", async () => {
    const response = await handle(request(), env(), (async () => new Response("upstream-secret", { status: 401, headers: { "set-cookie": "private" } })) as Upstream);
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("upstream-secret"); expect(response.headers.has("set-cookie")).toBeFalse();
  });
  test("rejects a redirect without forwarding credentials or location", async () => {
    let calls = 0;
    const response = await handle(request(), env(), async (_url, init) => {
      calls++; expect(init!.redirect).toBe("manual");
      return new Response(null, { status: 307, headers: { location: "https://another.test" } });
    });
    expect(calls).toBe(1); expect(response.status).toBe(502); expect(response.headers.has("location")).toBeFalse();
  });
  test("streams unchanged and propagates cancellation to provider", async () => {
    let signal: AbortSignal | undefined; let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: test\n\n")); }, cancel() { cancelled = true; } });
    const response = await handle(request({ messages: [{ role: "user", content: "test" }], stream: true }), env(), (async (_url: unknown, init?: RequestInit) => { signal = init!.signal!; return new Response(source, { headers: { "content-type": "text/event-stream" } }); }) as Upstream);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: test\n\n");
    await reader.cancel(); expect(signal!.aborted).toBeTrue(); expect(cancelled).toBeTrue();
  });
  test("client abort reaches an in-flight provider", async () => {
    const cancel = new AbortController();
    const pending = handle(request(undefined, { signal: cancel.signal }), env(), (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!; if (signal.aborted) reject(new Error("cancelled"));
      else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    })) as Upstream);
    cancel.abort(); expect((await pending).status).toBe(504);
  });
});
