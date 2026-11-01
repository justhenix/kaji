# Original P0 verification report

Historical baseline before the interactive live-head debugging session. For current behavior, human trials and regression results, see [Live tracking fix and evidence](LIVE-TRACKING-FIX.md). The statuses below describe only the original verification session.

Verification session: 2026-10-31 through 2026-11-01, Asia/Jakarta, on the available Windows desktop with Rust 1.98.1, Bun 1.4.2, a 1920×1080 display and the detected `PC Camera`. Calculator was the real `win32calc.exe` application. All statuses below refer to executed checks unless explicitly marked NOT TESTED.

The P0 engine is implemented. **The full human head-controlled acceptance demonstration remains NOT TESTED.** The webcam run detected no face. Replayed head poses exercised the real native motion/dwell pipeline and changed Calculator, but do not establish human calibration or aiming accuracy.

| Check | Status | Evidence |
| --- | --- | --- |
| Tauri v2 application build | PASS | `bun run --cwd app tauri build --debug --no-bundle` produced `src-tauri/target/debug/kaji.exe`. Both host and diagnostic executables were also built directly with locked Cargo dependencies. |
| Reproducible dependency install | PASS | `bun install --frozen-lockfile` completed without lockfile changes. |
| TypeScript and sensor build | PASS | `bun run --cwd app check` and `build:worker`; bundled WASM and model SHA256 verified. |
| Rust deterministic and protocol tests | PASS | 15 unit tests and one executable protocol test passed. Both desktop tests are excluded from ordinary test runs and were executed explicitly. |
| Live Windows safety test | PASS | Actual Escape hook, foreign one-pixel mouse injection, native heartbeat expiry, face-loss/multiple-face observations and the stop barrier passed. Zero clicks in this test. Physical human takeover was not substituted for the injected event test. |
| Hung UIA provider | PASS | A hidden real Win32 window deliberately stalled `WM_GETOBJECT`; the UIA helper was terminated at the deadline and the next request returned. |
| Static Rust checks | PASS | `cargo clippy --locked --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings`. |
| Sensor geometry tests | PASS | Two Bun tests passed: invalid face geometry rejection and roll/distance normalization. |
| Calculator UIA discovery | PASS | 74 real nodes, no truncation or skipped elements. Button `7`, automation ID `137`, physical rect `(332,472)-(366,499)`, clickable point `(349,485)`, native runtime ID and process lifetime recorded. |
| Fresh resolution and stale tokens | PASS | Button resolved with current physical geometry; the preceding token was rejected after another inspection. |
| Non-blocking stop and inspection cancellation | PASS | Stop acknowledged in approximately 0.22 ms while Calculator inspection was running; inspection returned cancelled and its worker was reaped. This is an observed run, not a worst-case latency guarantee. |
| Default input permission | PASS | Beginning execution without `--enable-input` was rejected by Rust. Replay requires an additional `--allow-replay` opt-in. |
| Native movement from replayed head poses | PASS | The final Calculator replay generated 28 native moves and reached approximately `(351,483)` inside the real 7 button. |
| Dwell click and application effect | PASS | Exactly one native dwell click. Calculator's UIA display value changed from `0` to `7`. The effect was read from the real application after stopping. |
| Stop and late work | PASS | Explicit stop rejected subsequent observations from the prior session. A separate abandoned stream expired through the native watchdog. |
| Actual webcam + local MediaPipe | PASS | 295 real camera frames passed through the bundled CPU Face Landmarker and Rust ingress over a 20-second session. About 16–17 fresh decoded frames/second after initialization; no face, moves or clicks were detected. |
| Safe process completion | PASS | Diagnostic and camera sessions exited; an explicit process check found no Kaji host or UIA helper remaining. Graceful native window close also eliminated the WebView2 class-teardown error seen during initial iterations; the final camera run had empty stderr. |
| Live human calibration, aiming and dwell | NOT TESTED | No face was detected during the unattended hardware checks. Run `verify-head.ts` with a person to complete acceptance. |
| Mixed-DPI and multi-monitor hardware | NOT TESTED | Only one 1920×1080 monitor was available. Negative origins, virtual-coordinate endpoints and monitor-gap clamping passed deterministic tests. |
| Physical disconnect/lock/takeover matrix | NOT TESTED | Physical webcam unplugging, human mouse/keyboard takeover, display hot-plug, lock/unlock and lighting/seating changes were not performed. Native failure paths and foreign-input hooks were exercised separately. |
| Installer, signing, elevated targets | NOT TESTED | No installer or signing was requested. Standard-integrity input into elevated applications is not supported. |

FAIL: no final automated or application-effect check remains failing. This does not turn the NOT TESTED rows into acceptance passes.

## Definition of done

| Step | Result |
| --- | --- |
| Inspect Calculator and identify a real button | PASS |
| Move cursor through the native head-motion pipeline | PASS with replayed poses; live human head movement NOT TESTED |
| Dwell-click the real button | PASS through real Win32 input with replayed poses |
| Verify Calculator changed | PASS, `0` → `7` |
| Stop safely | PASS |
| Complete all steps using an actual person's webcam head movements | NOT TESTED |

## Reproduce and inspect evidence

See [Windows verification instructions](WINDOWS-VERIFICATION.md). `scripts/verify-windows.ts` writes `verification/inspection.json` and `verification/replay.json`; `verify-camera.ts` writes `verification/camera.json`. These local evidence files are ignored by Git. The full human check writes `verification/head.json` only when run; it was not run in this session.

The source audit and decisions are in [AKSESA-AUDIT.md](AKSESA-AUDIT.md), and the execution/observation contracts are in [ARCHITECTURE.md](ARCHITECTURE.md). No Pi runtime, model inference service, agent orchestration or product GUI was added.
