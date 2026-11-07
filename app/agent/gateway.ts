import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { GATEWAY_MODELS, type GatewayModelId } from '../shared/models';

export const GATEWAY_URL = "https://kaji-gateway.relanta.workers.dev/v1";
export function gatewayProvider(token: string, baseUrl = GATEWAY_URL, selectedModel: GatewayModelId = 'deepseek-v4.1-flash') {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Set a valid runtime KAJI_GATEWAY_TOKEN");
  const url = new URL(baseUrl);
  const selected = GATEWAY_MODELS.find(model => model.id === selectedModel);
  if (!selected) throw new Error('Selected model is not enabled');
  const effort = selectedModel.endsWith('-high') ? 'high' : selectedModel.endsWith('-medium') ? 'medium' : 'low';
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") throw new Error("Gateway URL must be HTTPS with path /v1");
  const model: Model<"openai-completions"> = {
    id: selected.id, name: `${selected.label} via Kaji`, api: "openai-completions", provider: "kaji-gateway",
    baseUrl: baseUrl.replace(/\/$/, ""), reasoning: true, thinkingLevelMap: { off: effort }, input: ["text", "image"],
    contextWindow: 65536, maxTokens: 4096,
    cost: selectedModel === 'deepseek-v4.1-flash'
      ? { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0.30 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, supportsReasoningEffort: true, supportsStrictMode: true, maxTokensField: "max_tokens", thinkingFormat: "openai" },
  };
  const streamFn: StreamFn = (_selected, context, options) => streamSimple(model, context, { ...options, apiKey: token, maxTokens: 4096, maxRetries: 0, timeoutMs: 60000, cacheRetention: "none" });
  return { model, streamFn };
}
