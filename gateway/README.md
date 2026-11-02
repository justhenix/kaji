# Kaji model gateway

Cloudflare Worker: `https://kaji-gateway.relanta.workers.dev`. The desktop developer harness calls `/v1/chat/completions`; only the Worker receives the B.AI upstream key. The enabled model is `minimax-m3.1-flash`, confirmed against the credential's live model catalog and actual inference on November 2, 2026.

## Boundaries

- An explicit runtime bearer credential is required. The Worker stores its SHA-256 hash as `GATEWAY_TOKEN_SHA256`, separately from `BAI_API_KEY`. Neither credential is compiled into the application, web assets or installer resources. The current Tauri project does not produce an installer.
- The endpoint, model, output limit and function-only tool protocol are enforced on the server. Request bodies are limited to 256 KiB; output is limited to 4,096 tokens and 2 MiB; the upstream deadline is 60 seconds. Redirects are rejected rather than followed with credentials. Provider error bodies and cookies are not forwarded.
- A SQLite-backed Durable Object serializes the owner's requests globally: one in-flight request, at most 200 acquisitions per UTC day, including failed attempts. A 65-second lease allows recovery if cleanup fails. A separate approximate Cloudflare limit allows 12 requests per minute per location. The daily limit is a request cap, not a monetary billing guarantee.
- Browser-origin requests are rejected. CORS is not authentication; the bearer check remains mandatory. No arbitrary upstream URL, image input, web search, shell tool, automatic retry, prompt logging or response storage is provided. The Durable Object stores only counters and lease metadata.
- This is a single-owner developer gateway. Public account creation, per-device credentials and multi-user billing are not implemented. Do not distribute the owner's runtime credential with a public application. The gateway does not authorize Windows actions; Rust applies separate window, session, mode and confirmation checks.

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

For a new deployment, set `account_id` in `wrangler.jsonc`, authenticate Wrangler, and provision the two Worker secrets with `wrangler secret put` or `wrangler secret bulk`. Generate a random 32-byte owner credential and store only its SHA-256 hash on the Worker. Do not put either secret in Wrangler configuration, GitHub source or a frontend environment variable. Deploy using `bun run --cwd gateway deploy`. The existing deployment is already provisioned.

To revoke an owner credential, replace the server's hash and provision a new runtime credential. Rotate the upstream key through B.AI and replace `BAI_API_KEY` independently. Credentials cannot be retrieved through `/health` or model tools.

## Windows runtime credential

On this development machine, the owner credential is stored outside the repository at `%LOCALAPPDATA%/Kaji/gateway-token.dpapi`, encrypted for the current Windows user. The developer wrapper decrypts it only for the child process and restores the prior environment afterward:

```powershell
./app/scripts/run-gateway-agent.ps1 --hwnd $calculatorHandle --mode agent --enable-actions --prompt "Invoke Calculator 7 once, then inspect and verify the display"
```

`--mode agent` explicitly authorizes bounded automatic execution in that window. The default is Assist, which stages a native confirmation and exits without executing it. An embedding or the workflow host can handle confirmation; the model has no confirmation tool.

On another Windows account, provision a runtime credential interactively and encrypt it without printing it:

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

## Website and GitHub

The unchanged Astro website is deployed separately on Vercel at `https://kaji.henix.my.id`. The Vercel project `justhenixs-projects/kaji` is connected to `justhenix/kaji`; production tracks `main`, with branch previews handled by Vercel. Root `vercel.json` builds only `web/dist`. `.vercelignore` excludes credentials, native sources, generated assets and scratch evidence from uploads.

GitHub Actions runs TypeScript, gateway, workerd, website and Windows Rust checks without model keys. Worker deployments currently use the authenticated operator's Wrangler CLI; a persistent GitHub Cloudflare deployment credential has not been created. This avoids silently copying the local OAuth credential into CI.

References: [B.AI API](https://docs.b.ai/llmservice/api/), [B.AI pricing](https://docs.b.ai/llmservice/pricing-and-usage/), [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Durable Objects storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
