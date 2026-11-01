import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";

// A scripted provider exercises Pi's real loop without network inference or credentials.
export function scriptedStream(step: (context: TranscriptContext, turn: number) => AssistantMessage["content"]): StreamFn {
  let turn = 0;
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      try {
        const content = step(context, turn++);
        const message: AssistantMessage = {
          role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
      } catch (error) {
        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "error", timestamp: Date.now(), errorMessage: String(error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      }
    });
    return stream;
  };
}
export const toolCall = (name: string, args: Record<string, any> = {}) => [{ type: "toolCall" as const, id: crypto.randomUUID(), name, arguments: args }];
export function lastToolValue(context: TranscriptContext): any {
  const last = context.messages.slice().reverse().find(m => m.role === "toolResult");
  if (!last || last.role !== "toolResult") throw new Error("Expected a tool result");
  if (last.isError) throw new Error(last.content.map(c => c.type === "text" ? c.text : "").join(""));
  return JSON.parse(last.content.map(c => c.type === "text" ? c.text : "").join(""));
}
