export const GATEWAY_MODELS = [
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
  { id: 'ag/gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash · Medium' },
  { id: 'ag/gemini-3.8-flash-high', label: 'Gemini 3.8 Flash · High' },
] as const;
export type GatewayModelId = typeof GATEWAY_MODELS[number]['id'];
export function gatewayModelId(setting?: string): GatewayModelId {
  return GATEWAY_MODELS.find(model => model.id === setting)?.id ?? 'deepseek-v4.1-flash';
}
