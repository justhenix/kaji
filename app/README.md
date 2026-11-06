# Kaji engine

Windows-first interaction engine with a Tauri desktop interface, compact composer, local conversation history, and hidden sensor and audio hosts. Rust owns task state, input, calibration, cursor motion, dwell, manual takeover, and emergency stop.

The composer sends typed requests, answers, method choices, and approvals through the native runtime. A managed Pi agent uses the same task owner for semantic desktop actions and registered adapters. The composer, main view, settings, and History reuse one native window. Closing the main view or settings returns to the composer; Alt+F4 on the composer exits Kaji.

Voice uses a bundled local “Hey Kaji” detector, Groq transcription, and ElevenLabs feedback. Service availability and free quotas are checked at the gateway; provider secrets are provisioned there. Local history uses SQLite, configurable retention, and asynchronous Groq titles with a local fallback. See the [integration plan](docs/END-TO-END-INTEGRATION-PLAN.md) for contracts, behavior, and acceptance criteria. General provider/environment switching remains a separate follow-up.

The [integration verification report](docs/INTEGRATION-VERIFICATION.md) separates completed checks from the remaining desktop and hardware walkthroughs. `bun run --cwd app test:frontend` runs a headless browser against built assets, checking minimum window sizes and accessibility without opening native windows or using devices. Run `build:worker` first after changing a view. `test:desktop` opens native windows and should run only when it will not interrupt the operator.

A separate [collaborative Pi harness](docs/COLLABORATIVE-HARNESS.md) is available for developer use. It keeps an independent logical cursor and requests Rust-authorized semantic actions without driving the Windows cursor. Head control yields briefly to other input, then resumes after idle with dwell clicks disarmed until fresh aiming.

[Guide/Assist workflows](docs/GUIDE-ASSIST.md) now support native confirmation and broader semantic actions. The [Cloudflare gateway](../gateway/README.md) keeps upstream model credentials outside the desktop application. See the [current checkpoint](docs/INTEGRATION-CHECKPOINT.md) for executed verification and remaining limits.

From the repository root, on Windows with Rust/MSVC, Windows SDK, WebView2 and Bun 1.4.2 installed:

```powershell
bun install --frozen-lockfile
bun run --cwd app build
bun run --cwd app check
bun run --cwd app test
bun run --cwd app python:test
bun run --cwd app native:test
```

The build verifies the pinned face and wake models, copies their local WASM runtimes, compiles the managed agent, and stages an isolated CPython 3.14.10 runtime with pinned DOCX dependencies. It then builds the native executables. Runtime model assets and Python packages are bundled; end users do not need Python or pip. Build output is `app/src-tauri/target/debug/`; keep `kaji-agent.exe` and the `python/` directory beside `kaji.exe` when copying it.

Python packaging follows the [official embedded-distribution guidance](https://docs.python.org/3/using/windows.html#the-embeddable-package). Download hashes are pinned in `scripts/build-python.ts`; changing versions requires rebuilding and running the DOCX tests.

Build a Windows x64 setup executable with `bun run --cwd app package:windows`, using the default Cargo target directory. It produces a release build and a per-user NSIS installer under `app/src-tauri/target/release/bundle/nsis/`, including the managed agent and Python worker. The installer checks WebView2 and installs it if needed. It contains no gateway credential: this laptop uses the existing Windows-user DPAPI login, and another Windows account must provision its own login. For quiet typed-input and dwell rehearsal, turn off Voice activation and Spoken feedback in Voice & Audio.

`bun app/scripts/verify-desktop.ts --binary <installed-kaji.exe> --live-reply` checks the installed app in an isolated data profile and submits one real typed request with camera and voice disabled. It needs this Windows user's gateway login. The default run checks unavailable-login recovery without provider inference.

```powershell
.\app\src-tauri\target\debug\kaji-diag.exe --help
.\app\src-tauri\target\debug\kaji.exe --help
```

For a real head-control session:

```powershell
.\app\src-tauri\target\debug\kaji.exe --camera --enable-input --seconds 120
```

Hold a comfortable neutral pose for calibration. After calibration, move deliberately before the first dwell is armed. Return to neutral over the desired control and dwell for 1.2 seconds. Move away by more than 18 physical pixels to arm the next click. A missing or ambiguous operator immediately pauses input; the same operator can recover, with recalibration after a loss longer than one second. Other input yields head control until 1.5 seconds idle and disarms dwell until fresh aiming. Escape, stale frames, camera failure, or display changes stop the session. Restart explicitly after a stop. A stopped session cannot accept late frames.

Developer diagnostics accept JSONL over stdin. Input is denied unless the process starts with `--enable-input`. Direct pose injection additionally requires `--allow-replay`; the Tauri host never enables it.

```json
{"id":1,"command":"inspect","hwnd":12345}
{"id":2,"command":"resolve","element_id":"token returned by inspect"}
{"id":3,"command":"status"}
{"id":4,"command":"stop"}
{"id":5,"command":"cancel_inspection"}
{"id":6,"command":"shutdown"}
```

Responses preserve request IDs; inspection can finish out of order. Each response has either `result.Ok` or `result.Err`. A new inspection supersedes previous tokens. UIA timeout/cancellation terminates the worker, independently of native input.

Read [Windows verification](docs/WINDOWS-VERIFICATION.md), the [live tracking fix and evidence](docs/LIVE-TRACKING-FIX.md), [original P0 report](docs/VERIFICATION.md), [architecture](docs/ARCHITECTURE.md), and [Aksesa audit](docs/AKSESA-AUDIT.md).
