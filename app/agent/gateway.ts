import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

export const GATEWAY_URL = "https://kaji-gateway.relanta.workers.dev/v1";
export function gatewayProvider(token: string, baseUrl = GATEWAY_URL) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Set a valid runtime KAJI_GATEWAY_TOKEN");
  const url = new URL(baseUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") throw new Error("Gateway URL must be HTTPS with path /v1");
  const model: Model<"openai-completions"> = {
    id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash via Kaji", api: "openai-completions", provider: "kaji-gateway",
    baseUrl: baseUrl.replace(/\/$/, ""), reasoning: true, thinkingLevelMap: { off: "low" }, input: ["text"],
    contextWindow: 65536, maxTokens: 4096,
    cost: { input: 0.15, output: 0.60, cacheRead: 0.015, cacheWrite: 0.15 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "openai" },
  };
  const streamFn: StreamFn = (_selected, context, options) => streamSimple(model, context, { ...options, apiKey: token, maxTokens: 2048, maxRetries: 0, timeoutMs: 60000, cacheRetention: "none" });
  return { model, streamFn };
}
