import { expect, test } from "bun:test";
import { gatewayProvider } from "./gateway";
import { computerTools } from './harness';
import { desktopTools } from './desktop-tools';
import { NativeSession } from './native-session';
import { validate } from '../../gateway/src/index';
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

test("gateway uses Pi's real Chat Completions adapter and runtime credential", async () => {
  const received: { payload?: any; auth?: string | null } = {};
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(r) {
    received.auth = r.headers.get("authorization"); received.payload = await r.json();
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"KAJI_OK"}}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const token = "a".repeat(64), provider = gatewayProvider(token, `http://127.0.0.1:${server.port}/v1`);
    const result = await (await provider.streamFn(provider.model, normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }), {})).result();
    expect(result.stopReason).toBe("stop"); expect(result.content).toEqual([{ type: "text", text: "KAJI_OK" }]); expect(provider.model.input).toEqual(["text", "image"]);
    expect(received.auth).toBe(`Bearer ${token}`); expect(received.payload).toMatchObject({ model: "deepseek-v4.1-flash", stream: true, max_tokens: 4096, reasoning_effort: "low" });
    expect(received.payload.store).toBeUndefined(); expect(received.payload.prompt_cache_key).toBeUndefined();
  } finally { server.stop(true); }
});
test("gateway requires an explicit runtime token and secure endpoint", () => {
  expect(() => gatewayProvider("")).toThrow();
  for (const url of ["http://public.test/v1", "https://user:pass@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/anything"]) expect(() => gatewayProvider("a".repeat(64), url)).toThrow();
});

test('Pi serializes the complete desktop catalog within the deployed gateway contract',async()=>{
  let payload: any;
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request){
    payload=await request.json();
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Ready"}}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  try {
    const native=NativeSession.managed({async request(){throw new Error('Native dispatch is not part of payload serialization');},async close(){}});
    const tools=computerTools(native,()=>{}).concat(desktopTools(native,'assist',()=>{},()=>{}));
    const provider=gatewayProvider('a'.repeat(64),`http://127.0.0.1:${server.port}/v1`);
    await(await provider.streamFn(provider.model,normalizeContext({messages:[{role:'user',content:'Inspect the selected task',timestamp:Date.now()}],tools}),{})).result();
    expect(tools).toHaveLength(16);
    expect(()=>validate(payload)).not.toThrow();
    expect(payload.tools.find((tool:any)=>tool.function.name==='session_status').function.strict).toBe(true);
    expect(payload.tools.some((tool:any)=>tool.function.name==='physical_propose')).toBe(true);
    expect(payload.tools.some((tool:any)=>/execute_physical|confirm|shell/.test(tool.function.name))).toBe(false);
  }finally{server.stop(true);}
});
