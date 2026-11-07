# Kaji model gateway

Cloudflare Worker: `https://kaji-gateway.relanta.workers.dev`. The desktop calls `/v1/chat/completions`; provider credentials remain in Worker secrets. The default is `deepseek-v4.1-flash` through B.AI. The explicit alternatives `ag/gemini-3.8-flash-medium` and `ag/gemini-3.8-flash-high` use the remote AIO's 9router. All three passed live image understanding, streamed tool calls, and tool-result continuation on November 6, 2026. DeepSeek's native vision is used; Moondream is not needed or configured.

## Boundaries

- Every service request requires a runtime bearer credential. The owner's hash remains in `GATEWAY_TOKEN_SHA256`; public installs automatically register separate device hashes. Provider credentials remain in Worker secrets. Neither owner nor provider credentials are compiled into the application, web assets or installer resources. Windows DPAPI protects each installation's device login.
- The endpoint, model allowlist, output limit and function-only tool protocol are enforced on the server. Requests are limited to 2 MiB; output is limited to 4,096 tokens and 2 MiB; the upstream deadline is 60 seconds. Redirects are rejected rather than followed with credentials. Provider error bodies and cookies are not forwarded.
- A SQLite-backed Durable Object serializes reasoning requests globally: one in-flight request, with failed attempts counted toward the daily allowance. The default is 200 acquisitions per UTC day; `REASONING_DAILY_REQUEST_CAP` accepts an integer from 200 to 1,000. This demo deployment uses 500 and preserves existing usage when the allowance changes. A 65-second lease allows recovery if cleanup fails. A separate approximate Cloudflare limit allows 12 reasoning requests per minute per location. The daily limit is a request cap, not a monetary billing guarantee.
- Browser-origin requests are rejected. CORS is not authentication; the bearer check remains mandatory. No arbitrary upstream URL, web search, shell tool, automatic retry, prompt logging or response storage is provided. Chat accepts bounded inline PNG, JPEG, or WebP data URLs only; provider vision remains disabled in capabilities until a live B.AI image-plus-tool check succeeds. The Durable Object stores counters and quota metadata only.
- Public desktop installs enroll a random device credential automatically. `DeviceRegistry` stores its SHA-256 hash, daily usage counters and revocation state. Enrollment allows five new devices per source IP per UTC day, 100 new devices globally per day, and six registration attempts per minute per IP. Each device gets 100 chat, 200 transcription, 100 spoken-feedback and 100 title requests per day, plus a 12-request/minute limiter. Existing aggregate provider budgets still apply. No owner or provider credential ships in the installer. This is anonymous device access, not a user-account or billing system. Rust separately authorizes Windows actions.

## Build and deploy

Use the existing Bun lockfile and a genuine Node.js runtime supported by Wrangler. A `node.exe` shim pointing at Bun is not supported by Wrangler.

```powershell
bun install --frozen-lockfile
bun run --cwd gateway check
bun run --cwd gateway test
bun run --cwd gateway test:runtime
bun run --cwd gateway deploy --dry-run
```

`test:runtime` starts actual local workerd and SQLite storage. It checks concurrent acquisitions, forged releases, the daily cap and persistence across restart without making any model requests. Its temporary state is ignored under `gateway/.wrangler/`.

For a new deployment, set `account_id` in `wrangler.jsonc`, authenticate Wrangler, and provision `BAI_API_KEY`, `GROQ_API_KEY`, and `ELEVENLABS_API_KEY` as Worker secrets. Generate a random 32-byte owner credential and store only its SHA-256 hash in `GATEWAY_TOKEN_SHA256`. Do not put provider keys in Wrangler configuration, GitHub source or a frontend environment variable. Deploy using `bun run --cwd gateway deploy`. This work does not provision or deploy provider credentials.

To revoke an owner credential, replace the server's hash and provision a new runtime credential. Rotate each provider key independently. Credentials cannot be retrieved through `/health`, `/v1/capabilities`, or model tools.

## Windows runtime credential

On this development machine, the owner credential is stored outside the repository at `%LOCALAPPDATA%/Kaji/gateway-token.dpapi`, encrypted for the current Windows user. The developer wrapper decrypts it only for the child process and restores the prior environment afterward:

```powershell
./app/scripts/run-gateway-agent.ps1 --hwnd $calculatorHandle --mode agent --enable-actions --prompt "Invoke Calculator 7 once, then inspect and verify the display"
```

`--mode agent` explicitly authorizes bounded automatic execution in that window. The default is Assist, which stages a native confirmation and exits without executing it. An embedding or the workflow host can handle confirmation; the model has no confirmation tool.

Normal Windows installations require no credential provisioning. The native client generates a random 256-bit device secret, encrypts it with Windows DPAPI, enrolls it over the pinned HTTPS gateway connection, and reuses it across restarts and upgrades. An interrupted enrollment is idempotent. An outdated owner credential can migrate to a device credential after a rejected session check. Revoked credentials fail closed.

The following manual procedure is only for an operator who explicitly needs the owner credential in a development harness:

```powershell
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'Kaji'
New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
Read-Host 'Kaji owner runtime credential' -AsSecureString |
    ConvertFrom-SecureString |
    Set-Content -LiteralPath (Join-Path $credentialDirectory 'gateway-token.dpapi')
```

For explicit developer runs without the wrapper, provide `KAJI_GATEWAY_TOKEN` at runtime. `KAJI_GATEWAY_URL` can override the HTTPS `/v1` endpoint. No environment file is loaded by application code.

```powershell
bun app/scripts/verify-model.ts --hwnd $calculatorHandle
bun gateway/scripts/verify-live.ts
```

These commands make paid model requests. The first independently verifies the native action count and actual Calculator display instead of trusting the model's answer.

## Speech, title, and capability routes

All `/v1` routes require the same runtime bearer credential and reject browser origins. Provider keys stay in Worker secrets. Speech and title quotas use a separate SQLite Durable Object record and never acquire the B.AI reasoning lease.

| Route | Request | Response |
| --- | --- | --- |
| `POST /v1/audio/transcriptions` | JSON `{ "wavBase64": "...", "language": "en" }`; `language` is optional or `en`, `id`, `auto` | JSON `{ "text": "...", "language": "..." }` |
| `POST /v1/audio/speech` | JSON `{ "text": "...", "voiceId": "..." }`; voice ID is optional and restricted to the account's free compatible default voices | MP3 bytes (`audio/mpeg`) |
| `POST /v1/chat/titles` | JSON `{ "request": "...", "response": "..." }` | JSON `{ "title": "..." }` |
| `GET /v1/capabilities` | No body | `ServiceCapabilities` fields from the shared desktop runtime contract |

Groq STT pins `whisper-large-v3-turbo`. Input must be a valid, 16 kHz mono, 16-bit PCM WAV of at most 30 seconds. The gateway caps use at 20 requests/minute, 2,000/day, 7,200 billable audio seconds/hour, and 28,800/day. Requests shorter than Groq's 10-second minimum are reserved as 10 seconds. Provider `429` responses are returned without retry.

Titles pin `qwen/qwen3.8-27b` with temperature `0.2`, `max_completion_tokens: 80`, and `reasoning_effort: "none"`. Local quotas cap requests at 30/minute and 1,000/day, plus a conservative UTF-8 byte upper bound of 8,000 units/minute and 200,000/day. The route accepts only the first user request and first assistant reply, validates 3–6 words, and returns an error for fallback handling when output is invalid. It stores no title state, so request ordering cannot overwrite another session; the native history owner must guard delayed results against manual rename or deletion.

ElevenLabs synthesis pins `eleven_v4_turbo` and uses its Text-to-Dialogue WebSocket. It requires a Free subscription with status `free` or `active`, an unrestricted or explicitly free-compatible default voice, disabled credit overage, and an available subscription quota. The monthly ceiling is 10,000 credits, reduced when the account's remaining Free allowance is lower. Credit reservations are atomic per gateway before synthesis. No paid model, voice, fallback, or retry is used. [ElevenLabs documents the v4 Turbo WebSocket path](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket) and [subscription status and overage fields](https://elevenlabs.io/docs/api-reference/user/subscription/get).

The chat routes accept up to 3 inline image data URLs, each at most 384 KiB decoded, in a 2 MiB request. Remote image URLs are rejected. `/v1/capabilities` enables default-model vision only when `BAI_VISION_VERIFIED=deepseek-v4.1-flash`, after the live image-and-tool check. This prevents an older model's verification flag from silently enabling a replacement model.

The Gemini variants use `NINE_ROUTER_API_KEY` and `NINE_ROUTER_BASE_URL`. Provision the private HTTPS base as a remote Worker variable or secret; it is absent from committed configuration. The Worker pins reasoning effort to the selected suffix and shares the serialized daily reasoning budget. It does not retry or fall back to another provider. The current base is a direct Cloudflare tunnel on the always-on AIO; keep it running. If that tunnel is recreated, update the remote base to its new direct hostname. The dashboard alias is not an inference fallback. The deploy script uses `--keep-vars` to preserve remote variables; never copy router or dashboard credentials into the repository.

## Website and GitHub

The unchanged Astro website is deployed separately on Vercel at `https://kaji.henix.my.id`. The Vercel project `justhenixs-projects/kaji` is connected to `justhenix/kaji`; production tracks `main`, with branch previews handled by Vercel. Root `vercel.json` builds only `web/dist`. `.vercelignore` excludes credentials, native sources, generated assets and scratch evidence from uploads.

GitHub Actions runs TypeScript, gateway, workerd, website and Windows Rust checks without model keys. Worker deployments currently use the authenticated operator's Wrangler CLI; a persistent GitHub Cloudflare deployment credential has not been created. This avoids silently copying the local OAuth credential into CI.

References: [B.AI API](https://docs.b.ai/llmservice/api/), [B.AI pricing](https://docs.b.ai/llmservice/pricing-and-usage/), [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Durable Objects storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
