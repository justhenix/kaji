import { createModels, type Provider } from "@earendil-works/pi-ai";
import { Harness } from "./harness";
import { NativeSession, type Mode } from "./native-session";
import { gatewayProvider } from "./gateway";

const args = Bun.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes("--help")) {
  console.log("bun run --cwd app agent --provider NAME --models\nbun run --cwd app agent --hwnd N --gateway --prompt TEXT [--enable-actions]\nbun run --cwd app agent --hwnd N --provider NAME --model ID --prompt TEXT [--enable-actions]\nGateway mode uses runtime KAJI_GATEWAY_TOKEN (optional KAJI_GATEWAY_URL). Direct mode uses KAJI_AGENT_API_KEY. Window text is sent to the selected provider. No camera, screenshot, shell or physical-input tools.");
} else {
  if (args.includes("--gateway")) {
    if (args.includes("--provider") || args.includes("--model")) throw new Error("Gateway selects its server-authorized model; omit --provider and --model");
    const prompt = option("--prompt"), hwnd = Number(option("--hwnd"));
    if (!prompt || !Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass a current --hwnd and --prompt");
    const provider = gatewayProvider(process.env.KAJI_GATEWAY_TOKEN ?? "", process.env.KAJI_GATEWAY_URL);
    await run(hwnd, prompt, provider.model, provider.streamFn);
  } else {
  const providerName = option("--provider");
  if (!providerName || !/^[a-z][a-z0-9-]{0,40}$/.test(providerName)) throw new Error("Pass --provider with an installed Pi provider name");
  const module = await import(`@earendil-works/pi-ai/providers/${providerName}`);
  const factoryName = providerName.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase()) + "Provider";
  if (typeof module[factoryName] !== "function") throw new Error("Provider factory is unavailable");
  const provider: Provider = module[factoryName]();
  const models = createModels();
  models.setProvider(provider);
  if (args.includes("--models")) {
    console.log(JSON.stringify(models.getModels(provider.id).map(m => ({ id: m.id, name: m.name, api: m.api })), null, 2));
  } else {
    const modelId = option("--model"), prompt = option("--prompt"), hwnd = Number(option("--hwnd"));
    const model = modelId ? models.getModel(provider.id, modelId) : undefined;
    if (!model || !prompt || !Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error("Pass a current --hwnd, --prompt and a --model from --models");
    const apiKey = process.env.KAJI_AGENT_API_KEY;
    if (!apiKey) throw new Error("Set KAJI_AGENT_API_KEY before starting a provider run");
    await run(hwnd, prompt, model, (selected, context, options) => models.streamSimple(selected, context, { ...options, apiKey, maxTokens: 2048, maxRetries: 0, timeoutMs: 30000 }));
  }
  }
}

async function run(hwnd: number, prompt: string, model: ConstructorParameters<typeof Harness>[1], streamFn: ConstructorParameters<typeof Harness>[2]) {
    const mode = option("--mode") ?? "assist";
    if (!["guide", "assist", "agent"].includes(mode)) throw new Error("Mode must be guide, assist or agent");
    const native = await NativeSession.open(hwnd, args.includes("--enable-actions"), undefined, mode as Mode);
    const harness = new Harness(native, model, streamFn);
    const cancel = () => { harness.agent.abort(); void native.stop().catch(() => {}); };
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const result = await harness.prompt(prompt);
      console.log(JSON.stringify(result, null, 2));
      if (result.state !== "finished") process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
      await harness.close();
    }
}
