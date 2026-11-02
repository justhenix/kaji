export const MODEL = "minimax-m3.1-flash";
export { OwnerBudget } from "./budget";
const ENDPOINT = "https://api.b.ai/v1/chat/completions";
const BODY_LIMIT = 256 * 1024;
export interface Env {
  BAI_API_KEY: string;
  GATEWAY_TOKEN_SHA256: string;
  REQUEST_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  OWNER_BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };
}
export type Upstream = (url: string, init?: RequestInit) => Promise<Response>;
const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const error = (status: number, message: string) => new Response(JSON.stringify({ error: { message, type: "gateway_error" } }), { status, headers });
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const name = (v: unknown) => typeof v === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(v);

export function validate(v: unknown): Record<string, unknown> {
  if (!object(v)) throw new Error("Expected a JSON object");
  const allowed = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort"]);
  if (Object.keys(v).some(k => !allowed.has(k))) throw new Error("Unsupported request parameter");
  if (v.model !== undefined && v.model !== MODEL) throw new Error("Model is not enabled");
  if (!Array.isArray(v.messages) || !v.messages.length || v.messages.length > 128) throw new Error("Expected 1–128 messages");
  for (const m of v.messages) {
    if (!object(m) || !["system", "developer", "user", "assistant", "tool"].includes(m.role)
      || Object.keys(m).some(k => !["role", "content", "tool_calls", "tool_call_id", "name", "reasoning_content"].includes(k))) throw new Error("Invalid message");
    if (Array.isArray(m.content) && m.content.every((part: any) => object(part) && part.type === "text" && typeof part.text === "string" && Object.keys(part).every(k => k === "type" || k === "text"))) {
      m.content = m.content.map((part: { text: string }) => part.text).join("\n");
    }
    if (m.content !== null && typeof m.content !== "string") throw new Error("Only text messages are enabled");
    if (m.name !== undefined && !name(m.name)) throw new Error("Invalid message name");
    if (m.reasoning_content !== undefined && typeof m.reasoning_content !== "string") throw new Error("Invalid reasoning content");
    if (m.role === "tool" && (typeof m.tool_call_id !== "string" || !m.tool_call_id || m.tool_call_id.length > 256)) throw new Error("Tool result requires a call ID");
    if (m.tool_calls !== undefined && (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length > 8
      || m.tool_calls.some((c: any) => !object(c) || c.type !== "function" || typeof c.id !== "string" || c.id.length > 256 || !object(c.function) || !name(c.function.name) || typeof c.function.arguments !== "string"))) throw new Error("Invalid function call history");
  }
  for (const k of ["stream", "parallel_tool_calls"]) if (v[k] !== undefined && typeof v[k] !== "boolean") throw new Error(`Invalid ${k}`);
  if (v.max_tokens !== undefined && v.max_completion_tokens !== undefined) throw new Error("Specify only one output limit");
  const tokens = v.max_tokens ?? v.max_completion_tokens ?? 2048;
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 4096) throw new Error("Output limit must be 1–4096 tokens");
  if (v.temperature !== undefined && (typeof v.temperature !== "number" || v.temperature < 0 || v.temperature > 2)) throw new Error("Invalid temperature");
  if (v.top_p !== undefined && (typeof v.top_p !== "number" || v.top_p <= 0 || v.top_p > 1)) throw new Error("Invalid top_p");
  if (v.reasoning_effort !== undefined && !["low", "medium", "high"].includes(v.reasoning_effort)) throw new Error("Invalid reasoning effort");
  if (v.stream_options !== undefined && (!object(v.stream_options) || Object.keys(v.stream_options).some(k => k !== "include_usage") || typeof v.stream_options.include_usage !== "boolean")) throw new Error("Invalid stream options");
  if (v.tools !== undefined && (!Array.isArray(v.tools) || v.tools.length > 16 || v.tools.some((t: any) => !object(t) || t.type !== "function" || !object(t.function) || !name(t.function.name) || !object(t.function.parameters)))) throw new Error("Only function tools are enabled");
  if (v.tool_choice !== undefined && !["auto", "none", "required"].includes(v.tool_choice)
    && !(object(v.tool_choice) && v.tool_choice.type === "function" && object(v.tool_choice.function) && name(v.tool_choice.function.name))) throw new Error("Invalid tool choice");
  const { max_completion_tokens: _unused, ...body } = v;
  return { ...body, model: MODEL, max_tokens: tokens, parallel_tool_calls: false };
}

async function readBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > BODY_LIMIT) throw new Error("Request exceeds 256 KiB");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new Error("Request exceeds 256 KiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function handle(request: Request, env: Env, upstream: Upstream = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return new Response(JSON.stringify({ service: "kaji-gateway", model: MODEL }), { headers });
  if (url.pathname !== "/v1/chat/completions" || url.search) return error(404, "Not found");
  if (request.method !== "POST") return error(405, "POST required");
  if (!env.BAI_API_KEY || !/^[a-f0-9]{64}$/.test(env.GATEWAY_TOKEN_SHA256 ?? "") || !env.REQUEST_LIMIT || !env.OWNER_BUDGET) return error(503, "Gateway is not configured");
  const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return error(401, "Authentication required");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const expected = Uint8Array.from(env.GATEWAY_TOKEN_SHA256.match(/../g)!, byte => parseInt(byte, 16));
  let difference = 0; for (let i = 0; i < digest.length; i++) difference |= digest[i]! ^ expected[i]!;
  if (difference) return error(401, "Authentication required");
  if (request.headers.has("origin")) return error(403, "Browser access is not enabled");
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return error(415, "JSON required");
  let body: Record<string, unknown>;
  try { body = validate(JSON.parse(await readBody(request))); }
  catch (e) { return error(String(e).includes("exceeds") ? 413 : 400, e instanceof Error ? e.message : "Invalid body"); }
  try { if (!(await env.REQUEST_LIMIT.limit({ key: "kaji-owner" })).success) return error(429, "Request limit reached; try later"); }
  catch { return error(503, "Rate limiter unavailable"); }

  const budget = env.OWNER_BUDGET.get(env.OWNER_BUDGET.idFromName("owner-v1"));
  let lease: string;
  try {
    const response = await budget.fetch("https://budget/acquire", { method: "POST" });
    const decision = await response.json() as { status: string; lease?: string };
    if (!response.ok) return error(503, "Budget service unavailable");
    if (decision.status !== "allowed") return error(429, decision.status === "daily_limit" ? "Daily request limit reached" : "Another model request is still active");
    if (!decision.lease) return error(503, "Budget service unavailable");
    lease = decision.lease;
  } catch { return error(503, "Budget service unavailable"); }

  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 60000);
  let released = false;
  const cleanup = async () => {
    clearTimeout(timer); request.signal.removeEventListener("abort", abort);
    if (released) return; released = true;
    try { await budget.fetch("https://budget/release", { method: "POST", body: lease }); }
    catch { /* The 65-second lease expires even if release cannot reach the object. */ }
  };
  try {
    const response = await upstream(ENDPOINT, {
      method: "POST", headers: { "authorization": `Bearer ${env.BAI_API_KEY}`, "content-type": "application/json" },
      // Workers supports manual/follow only. Never forward credentials through a redirect.
      body: JSON.stringify(body), redirect: "manual", signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel(); await cleanup();
      return error(response.status === 429 ? 429 : 502, "Model provider request failed");
    }
    const type = response.headers.get("content-type") ?? "";
    if (!(body.stream ? type.startsWith("text/event-stream") : type.startsWith("application/json"))) {
      await response.body.cancel(); await cleanup(); return error(502, "Unexpected provider response");
    }
    const reader = response.body.getReader(); let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const { done, value } = await reader.read();
          if (done) { await cleanup(); target.close(); return; }
          size += value.length;
          if (size > 2 * 1024 * 1024) throw new Error("Provider response exceeds limit");
          target.enqueue(value);
        } catch (e) { controller.abort(); await reader.cancel().catch(() => {}); await cleanup(); target.error(e); }
      },
      async cancel(reason) { controller.abort(); await cleanup(); await reader.cancel(reason); },
    });
    return new Response(stream, { headers: { ...headers, "content-type": type } });
  } catch (cause) {
    await cleanup();
    console.error("provider_transport_failure", cause instanceof Error ? cause.name : "UnknownError");
    return error(controller.signal.aborted ? 504 : 502, "Model provider unavailable");
  }
}
export default { fetch: (request: Request, env: Env) => handle(request, env) };
