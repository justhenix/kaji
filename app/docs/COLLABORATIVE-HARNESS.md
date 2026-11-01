# Collaborative computer-use harness

The developer harness uses Pi Agent Core 1.4.0 with four sequential tools and one authorized Windows window. Its independent intent cursor stores an element token, physical screen point and revision in Rust. Pointing never moves the Windows cursor. This is an execution API, with no cursor overlay or product GUI.

`agent/harness.ts` owns the Pi transcript, turn/tool/time budgets, steering and explicit pause/resume. `agent/native-session.ts` communicates with `kaji-assist` over inherited JSONL stdin/stdout. There is no server, shell tool, hotkey tool, screenshot uploader, browser session or camera capture. No Aksesa source was copied. The existing head-control engine keeps its original manual-takeover policy.

## Native execution and collaboration

- `begin(hwnd)` creates a scoped session. Actions require a separate `--enable-actions` launch flag; inspection and logical pointing are available without it. Mutation ownership remains exclusive across Kaji processes. Physical-mouse collaboration is supported; simultaneous mutating head-control and agent sessions are not implemented in this iteration.
- `inspect(session)` returns fresh UIA tokens bound to window, process lifetime and runtime IDs. New inspections invalidate old cursor intent. `point(session, element_id)` resolves the token again and records a new revision. `invoke(session, revision)` consumes that exact intent and its token once.
- Standard Win32 pushbuttons use a bounded parent `BN_CLICKED` notification after checking UIA identity, native Button class, pushbutton style, parent/root ownership, PID, control ID and enabled state. Other eligible controls use UIA Invoke. No arbitrary Windows messages, coordinate clicks or SendInput are exposed to the agent.
- A real test found that Calculator's legacy UIA Invoke proxy activates Calculator. The pushbutton path avoids that provider side effect. Unknown providers can still change focus; if they do, the session pauses and requires inspection and explicit resumption. A logical cursor alone cannot guarantee independent interaction in every Windows application.
- Moving the physical mouse does not terminate the collaborative session. Clicks, wheel input or keyboard activity in the shared target pause it and discard cursor intent. Activity in another window does not revoke it. Escape stops the session and invalidates its epoch. The native observer and its 300 ms watchdog remain mandatory.
- A pause retains session identity and Pi's in-memory transcript. Resume is a host/user API, not a model tool, and requires fresh grounding. The bounded CLI runs one prompt and stops on exit; an embedding can retain the `Harness` object, call `steer`, `pause` and `resume`, then `close`.
- Stop invalidates queued initialization and waits for the native operation to finish or its isolated worker to be killed and reaped. Aborting a JavaScript tool waits for this native cancellation barrier. A command already accepted by an application cannot be undone. Cancellation/provider timeout after dispatch is recorded as an unknown outcome and must be inspected before any retry.
- Every action sets `verification_pending`. Only a subsequent inspection clears it. A model response without that observation is returned as `unverified`, not success. `finished` means the bounded model run ended; callers must still assess the observed application state against the task.

## Run

Build from the repository root using the existing Bun and Cargo lockfiles:

```powershell
bun install --frozen-lockfile
bun run --cwd app build
bun run --cwd app check
bun run --cwd app test
cargo test --locked --manifest-path app/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
```

List the selected Pi provider's installed model catalog, without sending a model request:

```powershell
bun run --cwd app agent --provider groq --models
```

Supply a current model ID from that catalog, the target HWND, a task and a dedicated `KAJI_AGENT_API_KEY` environment variable to execute a provider run:

```powershell
bun run --cwd app agent --hwnd $calculatorHandle --provider groq --model $modelId --prompt "Invoke Calculator's 7 once and verify the display changed" --enable-actions
```

The CLI sends the authorized window's UIA text and task to the selected provider. It does not search for credentials in project files or reuse Aksesa gateway tokens. No provider/model is silently selected. The loop defaults to 12 turns, 32 tool calls and 120 seconds; provider requests use at most 2,048 output tokens, a 30-second timeout and no automatic retries.

Read-only diagnostics can be run directly with `app/src-tauri/target/debug/kaji-assist.exe`. Requests have an `id` and `command`; results use the same `result.Ok` / `result.Err` envelope as P0 diagnostics. Native status includes logical intent, physical cursor, foreground HWND, action backend, phase and verification state.

## Executed verification

| Check | Result | Evidence |
| --- | --- | --- |
| Rust ordinary suite | PASS | 47 library tests, 2 sensor-gate tests, the original protocol test and the new collaboration protocol test: 51 total. |
| Bun and TypeScript | PASS | 13 Bun tests and typecheck. Includes real Pi loop behavior with scripted provider responses, explicit resume with retained transcript, budgets, unverified effects and cancellation barriers. Native transport is isolated in unit tests; this is not remote model inference. |
| Real background Calculator effect | PASS | Pi's real sequential tool loop inspected, pointed, requested one native semantic action and inspected again. Calculator changed `7` to `77`; Explorer stayed foreground and the physical cursor remained `(573,607)` in the final run. Backend: `win32_pushbutton_notification`. |
| Native input collaboration | PASS | Opt-in test injected a foreign mouse movement: logical cursor and session remained active. A real input click on Calculator paused the same session and invalidated intent. Explicit resume required a new inspection. |
| Emergency and cancellation | PASS | Actual Escape hook revoked the session. Queued/in-flight initialization followed immediately by stop could not rearm it. The JS cancellation race test waits for the native barrier even when an action reply arrives first. |
| Existing P0 Windows regressions | PASS | Escape, foreign-input takeover, face loss, source watchdog, operator/portrait recovery and stop barrier passed unchanged. A hung provider was killed and a subsequent inspection succeeded. Calculator discovery and native head-pose replay also passed: one dwell click changed `0` to `7`. |
| Clippy | PASS | All targets, warnings denied. |
| Paid model/provider inference | NOT TESTED | No model request was made. Live native verification used an explicitly scripted provider with the actual Pi runtime. |
| Human simultaneous work / arbitrary applications | NOT TESTED | User was absent. Native input was injected for the collaboration check. Custom canvases, applications without semantic controls, mixed-DPI hardware and provider focus behavior outside the tested application remain unverified. |
| Head tracking / Calculator human acceptance | Unchanged | This harness does not complete or change the incomplete webcam acceptance in [the live tracking report](LIVE-TRACKING-FIX.md). No camera was opened. |

Reproduce the non-inference Pi/native check with Calculator open, preferably behind another application:

```powershell
$calculatorHandle = (Get-Process | Where-Object MainWindowTitle -eq 'Calculator' | Select-Object -First 1).MainWindowHandle
bun app/scripts/verify-assist.ts --hwnd $calculatorHandle
```

It writes ignored `verification/assist.json`. The earlier provider-focus failure is preserved locally in `assist-provider-focus-failure.json`. For the native input test, bring Calculator forward and keep hands off the mouse/keyboard; it injects a one-pixel move, a click on 7 and Escape, and restores the pointer:

```powershell
$env:KAJI_ASSIST_HWND = "$calculatorHandle"
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --test assist_live -- --ignored --nocapture
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --test windows_live -- --ignored --nocapture
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --test uia_timeout -- --ignored --nocapture
```

References: [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent), [Microsoft Invoke pattern](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementinginvoke), [BN_CLICKED](https://learn.microsoft.com/en-us/windows/win32/controls/bn-clicked) and [WM_COMMAND](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-command).
