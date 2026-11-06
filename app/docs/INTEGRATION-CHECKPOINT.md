# Kaji integration checkpoint

Status: Resumed on November 6, 2026. The user made the desktop available and authorized autonomous native checks while away. Preserve the physical pointer during independent Doppel tests. See the [verification report](INTEGRATION-VERIFICATION.md) for the earlier background pass and the dated updates below for current results.

## Current work

The end-to-end runtime checkpoint is committed as `3ef9842` on `henix/gateway-workflows`, with documentation and clean visual fixtures in the following checkpoint commit. Preserve subsequent changes. The agreed scope and deferred environment-management work are in [the integration plan](END-TO-END-INTEGRATION-PLAN.md).

The latest user change is implemented: the small website dither cursor glows blue/pink and follows beside the physical cursor. It switches to the left near the display's right edge and keeps its glow within the display. Task mode retains exact cursor-tip targeting. Geometry checks cover negative monitor coordinates and 100%, 150%, and 200% scaling. The native overlay rendered the glow successfully.

The composer no longer has the stray native caption/frame. Native tests and actual WebView2 transitions verify equal client and outer heights.

The app includes the managed Pi agent, generic executor and application discovery, native approval gates, physical fallback approval, typed Python DOCX processing, local wake/audio hosts, SQLite History, and asynchronous Groq titles. History and settings reuse the main window. History deletion now uses the existing Kaji modal instead of a browser confirmation. Settings show the real Escape emergency shortcut. Executor capabilities now reflect Guide mode and native write permission.

## Provider setup

- Groq and ElevenLabs keys are provisioned as Worker secrets. Never print or commit their values.
- ElevenLabs CLI onboarding completed. The official SDK is installed at version 2.75.0. The CLI-created `gateway/.env.local` is ignored.
- The Worker is deployed at `https://kaji-gateway.relanta.workers.dev/v1`; latest deployed version is `14895432-86f6-4659-9cc0-20b3c2781cbe`, which aligns the owner hash with the canonical saved Windows login. Application code is unchanged from `bfe077d7-4cb4-44c9-89ef-ea88a2353e25`.
- The default reasoning and vision model is `deepseek-v4.1-flash`. Settings also offer `ag/gemini-3.8-flash-medium` and `ag/gemini-3.8-flash-high` through the remote AIO's 9router. Speech and titles retain `whisper-large-v3-turbo`, `eleven_v4_turbo`, and `qwen/qwen3.8-27b`.
- All three reasoning choices passed live image, streaming tool-call and tool-result continuation checks. `BAI_VISION_VERIFIED=deepseek-v4.1-flash` is deployed. Moondream is not configured because DeepSeek's native vision passed.
- ElevenLabs Free accounts return subscription status `free` and unrestricted default voices with `available_for_tiers: []`. Both are handled without allowing paid accounts, restricted voices, or overage.
- The user explicitly approved short English/Indonesian speech checks using free credits only. Both clips decoded successfully and Groq transcribed their expected words. Both language title checks passed.
- The last speech-account check confirmed the Free plan with overage disabled. A CLI test unexpectedly synthesized despite `--dry-run`; do not treat that flag as safe. No further speech synthesis is needed merely to repeat passed checks.
- Developer provider/environment switching is still the next plan, not part of this implementation.

## Verified results

- App TypeScript check and 47 tests passed on the latest sources.
- Gateway TypeScript check and 25 tests passed.
- Actual workerd/SQLite quota concurrency and restart-persistence checks passed.
- Rust: 76 library and 5 main-binary tests passed; formatting and Clippy with `-D warnings` passed on the latest sources. The normally ignored Rust/Python roundtrip was also run explicitly and passed.
- Bundled Python: 5 DOCX worker tests passed.
- Real native semantic-control test passed for value, toggle, selection, scroll, Guide denial, exact Assist approval, stale/forged/replayed approvals, and cursor/foreground preservation.
- Real stalled-UIA-provider timeout/recovery, JSONL protocols, Escape hook, foreign input, watchdog, operator-loss, and stop-barrier tests passed.
- A fresh Calculator model test changed display `0` to `7` with exactly one native action. Physical pointer and foreground were unchanged. The test Calculator was closed afterward.
- Latest native desktop verification passed 15 checks, including all eight settings pages in both themes, actual keyboard dropdown dismissal and settings persistence, History CRUD and restart persistence, real MiniMax-to-Python DOCX creation, a short reply, and a persisted automatic Groq title.
- The live DOCX independently contained the exact heading `Kaji integration check` and paragraph `Native to Python connection works.`

Evidence is in ignored `app/verification/desktop-live.json`, `speech-live.json`, `model.json`, and generated screenshots. `desktop-integration.json` may contain an older failed test-fixture run; use the newer passing `desktop-live.json` for the final integrated run. One WebView2 class-unregistration diagnostic (`Error = 1412`) was logged during shutdown; browser page-error collection was empty.

## Build and runtime details

Latest built app: `app/src-tauri/target/integration/debug/kaji.exe`. Keep its adjacent `kaji-agent.exe` and `python/` directory. Assets, the agent, and isolated CPython 3.14.10 with pinned DOCX dependencies are built. No installer was requested.

Set `CARGO_TARGET_DIR` to the absolute `app/src-tauri/target/integration` path for isolated native work. `scripts/diagnostic-client.ts` now respects this target. Default `node`/`npx` are Bun shims on this laptop. Wrangler's runtime verification requires real Node at `C:/Users/henix/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.

The native app reads its Windows DPAPI owner credential from `%LOCALAPPDATA%/Kaji/gateway-token.dpapi`. Setting only `KAJI_GATEWAY_TOKEN` does not provision the native app. Live desktop verification copies only the encrypted credential into its temporary profile; default verification uses no credential. Provider keys never enter the desktop app.

Automatic approval review rejected recursive cleanup of an obsolete Python installer cache with only `blocked by policy` as its reason. The cache and installer log were left untouched and are ignored in `app/.gitignore`.

## Resume work

1. Visual review of the native settings light/dark and History-delete screenshots is complete. Headless checks additionally verified both themes at minimum settings size and fixed accessible names on switches/sliders and the microphone graphic.
2. Complete the remaining real multi-application, approved split-screen/restoration, and screenshot-only physical-fallback acceptance scenarios. Unit, host, and native guard tests do not substitute for these scenarios. Calculator Agent mode passed; the full person-driven Guide/Assist walkthrough remains separate.
3. Complete person-driven camera calibration, aiming/dwell, actual microphone/local wake detection, and speaker-device acceptance. These were not established by synthetic audio or sensor regression tests.
4. Review the final diff and produce the delivery/evidence summary without claiming the unexecuted acceptance scenarios passed. Do not repeat unchanged passing provider requests or exceed the user's free-only constraint.

The background pass also fixed DOCX trimming that could remove drawings/field markers, replacement across formatted runs and Unicode case-insensitive offsets, duplicate processing of merged cells, delayed audio playback after Stop, and stale speech/wake results crossing voice sessions. Tests and build details are in the verification report. The earlier 15-check native run predates these final changes and has not been replayed while the user is using the laptop.

The three requested GPT-6 Luna Max agents completed their assigned implementation work earlier. All subsequently hit workspace-credit errors and were closed; no agents are still working.

## November 6: gateway recovery and independent taskbar activation

The release-package check found that the canonical saved Windows DPAPI login was rejected with HTTP 401. Updated only the deployed `GATEWAY_TOKEN_SHA256` to match that saved login, then verified authenticated capabilities and a real typed request. Provider secrets, application code and 9router configuration were preserved. The credential remains outside the installer and repository.

The native composer Explorer scenario passed against the live gateway: observed the Doppel overlay, approved one exact invocation, verified `Home - File Explorer` as foreground, and sampled an unchanged physical pointer throughout. Evidence: `app/verification/taskbar-live.json`. Run `bun app/scripts/verify-taskbar.ts --execute` only on an available, idle desktop with the integration target configured.

This Windows XAML taskbar advertises a nonfunctional legacy Press pattern. The independent backend resolves the current primary-taskbar button order and uses the matching Windows activation shortcut for slots 1–10. It never sends mouse input. Other controls retain their existing UIA behavior. An explicit taskbar activation may bring its app forward; other provider focus changes still pause the session. Post-approval host continuation now requests fresh inspection, and the window catalog exposes the actual foreground window ID for verification.

Native person-driven camera, microphone and dwell acceptance remains separate; this result does not establish those scenarios.

## November 6: review policy, model selection and completion visibility

The saved Auto review policy now reaches the native action gate. Routine navigation and editing can proceed without an approval; destructive, payment, sharing, permission and unclear submit actions still require one. Native target identity and freshness checks remain in force. The live composer opened one New Tab without an approval and rejected a controlled Delete action without executing it. Evidence: `app/verification/review-live.json`.

The model picker persists each of the three choices across Save and reload. A task snapshots its selected model when it starts. Legacy `Kaji Pro` settings map to DeepSeek. Gemini uses the verified direct remote API; neither the AIO router nor its tunnel was modified. Evidence: `app/verification/deepseek-live.json` and `router-live.json`.

Completion presents the verified artifact or bound application, falling back to the Kaji reply window when no application can be presented. The working Doppel is brighter and labeled Kaji; idle appearance stays subdued. Both themes and reduced motion were checked. Clicking the prompt while a reply is open now opens the editor in one click.

The gateway's existing 200-request daily counter was exhausted during development. The deployment now uses a bounded 500-request demo allowance and retains the existing count. No provider plan or actual credit limit changed; the UI displays Demo allowance. Unit tests cover preserved usage, invalid configuration and the new cap. Actual workerd checks still exercise the default 200 boundary and persistence without model requests.

Final checks on these sources: app TypeScript and 63 tests, gateway TypeScript and 27 tests, actual workerd/SQLite checks, and 79 Rust library tests passed. Three native acceptance tests remain opt-in. The native app and sidecar were rebuilt. Person-driven voice, camera aiming and dwell still require a rehearsal. Mark was absent from the live eligible default-voice catalog; the current fallback remains Roger.

Two consecutive DeepSeek composer taskbar runs after the grouped-window fix passed, including the clean build at 10:17 UTC: the independent Doppel overlay appeared, Explorer actually became foreground and stayed visible at completion, no approval was requested, and the physical pointer remained unchanged throughout. Evidence: `app/verification/taskbar-live.json`. Formatting and Clippy with warnings denied also passed on the final native sources.

Repeated runs exposed two separate issues. Binding a window now selects its native executor, eliminating an initial denied action and recovery loop. Also, plain Windows+number sometimes opened Explorer's grouped-window previews (`XamlExplorerHostIslandWindow`) instead of its real window. Activation now uses Windows+Ctrl+number to select the last active app window, as documented by [Microsoft](https://support.microsoft.com/en-us/accessibility/windows/keyboard-shortcuts-in-windows). All six input events are keyboard events and release both modifiers, including on partial failure. An empty or token-truncated model reply now fails rather than reporting completion; the adapter uses the existing 4,096-token server allowance. Regression tests cover these cases.

## November 6: head control yields instead of failing on other input

The real composer error was `sensor: Mouse or keyboard input interrupted camera startup.` This only established that the input counter changed, not who generated the event. Camera warmup now accepts other input and snapshots the current counter when tracking begins. Explicit cancellation and Escape still reject startup.

While head control is active, other input pauses movement and clicks for 1.5 seconds of idle time and leaves the camera session running. Held modifiers/buttons extend the pause. Fresh camera observations continue during the pause. Resuming clears the previous dwell countdown and requires movement to a new aim before a click can arm. Emergency stop, observer, capture freshness, desktop and target checks remain. The agent's separate manual-takeover policy is unchanged; physical agent fallback refuses a handoff while any head session can resume.

The Dwell button now retains its name and displays Off, Starting, Calibrate, Move head, Ready, Paused, No face or Retry underneath. Other input no longer produces a global error. A real camera failure names Dwell and offers a direct retry. The green matrix check reappears for three seconds whenever dwell becomes ready, including after yielding within the same camera session.

App TypeScript, 64 app tests, 82 Rust library tests, Clippy with warnings denied, and rendered readiness/overflow/reduced-motion checks passed. Both themes were visually reviewed. Tests establish that resuming cannot dispatch an old click; person-driven aiming and dwell acceptance remains separate.

Live laptop check: started Dwell, disabled dwell clicks during warmup, and navigated the app with the mouse. The camera stayed running, completed 25 calibration observations, displayed the temporary other-input pause, then returned to `native head control active` without a restart. Head control was stopped explicitly afterward. The main-window Head control switch now reflects the enabled camera session, including temporary pauses or waiting for a face, rather than incorrectly showing Off whenever tracking is not actively moving.

## November 6: Windows setup package for quiet rehearsal

`bun run --cwd app package:windows` builds the optimized Windows x64 app and a per-user NSIS setup executable using `tauri.package.conf.json`. The installer includes the managed agent and isolated Python/DOCX worker. Both launchers use the Windows GUI subsystem and do not open console windows. The setup file is unsigned.

Built `app/src-tauri/target/release/bundle/nsis/Kaji_0.1.0_x64-setup.exe` (75,670,760 bytes), copied to the user's Downloads as `Kaji-0.1.0-setup.exe`. SHA-256: `ed5b65800089e5215900559e0e5adb36593d159fca354d039f4d2c27a4315ff9`. The installer manifest contains no settings, history, environment file or DPAPI credential. The installed executable matches the installer payload; Tauri's bundle-type patch means the intermediate build executable can have a different hash.

Installed under `%LOCALAPPDATA%/Kaji/` with Start-menu and desktop shortcuts. The saved login was preserved. The installed copy passed 14 native smoke checks, including both settings themes, History persistence, missing-login handling and a live typed composer reply `KAJI_TYPED_OK`. Installed Python imported the DOCX dependencies successfully. Evidence: `app/verification/desktop-live-reply.json`. Voice activation and read-aloud feedback are off in this user's settings for quiet rehearsal; the test did not use the microphone or camera.

## November 6: precise dwell and an unobstructive composer

Head control now maps displacement to displacement. Holding a tilted pose no longer drives continuous motion. A small positional noise band suppresses tremor, and 16 ms interpolation retains intermediate native updates. Tracking pose smoothing remains 60 ms; neutral crossings no longer snap the pointer. Dwell Off now stops movement and clicking, cancels startup and releases the camera. Starting head control from Settings also synchronizes the composer's Dwell state.

Dwell starts only when a fresh UIA point check identifies an enabled, visible actionable control. A bounded background helper keeps UIA outside the motion/stop loop. Missing, stale, moved or changed targets reset the countdown. Plain text, blank surfaces and generic document/window containers do not arm clicks. Apps without usable accessibility controls are deliberately unavailable to dwell. The status reads Aim until a usable target is ready.

The agent's `composer_control` tool moves the composer left/right or aside, or fades it to 12% and lets clicks pass through for 5–600 seconds (default three minutes). It restores automatically, and explicitly focusing Kaji restores visibility and input. A subsequent placement cancels the old restore timer. It changes only Kaji, requires no application executor and does not stage an approval. The gateway's validated function catalog limit is 24, covering the current 17 tools; this was deployed with private remote variables preserved, version `90519d68-02b5-4edc-b494-4ae5e5f08d2f`.

App TypeScript and 65 tests, gateway TypeScript and 27 tests, 86 Rust library tests, five main tests, formatting and Clippy with warnings denied passed. A real Windows fixture passed through the production 250 ms UIA helper: enabled button accepted; disabled button, text and blank area rejected. Headless frontend and both-theme overlay/readiness/reduced-motion checks passed. The installed release passed 18 native desktop checks, including a live typed reply, left/right/fade requests without approval, native click-through and timed restoration, and camera stop during immediate, delayed and running startup. Evidence: `app/verification/desktop-dwell-composer.json`. Person-driven precision and dwell clicking still need the user's rehearsal.

Delivered and installed `Kaji-0.1.0-dwell-fix-setup.exe` (75,706,963 bytes); the original `Kaji-0.1.0-setup.exe` in Downloads is updated too. SHA-256: `e0ee145e1dc1d243e0bd301f1618e3eaa6db547c33750f77a6c14502e25f7d0b`. The installed executable matches the installer payload and the saved encrypted login is unchanged. The setup remains unsigned.
