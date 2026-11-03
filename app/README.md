# Kaji engine

Windows-first interaction engine with a Tauri desktop interface, compact composer and hidden sensor host. Rust owns input, calibration, cursor motion, dwell, manual takeover and emergency stop.

The composer GUI includes voice/dwell controls, an optional text editor, human-in-the-loop questions and an animated logo/matrix. Its `kaji:composer-update` and `kaji:composer-action` events define the frontend boundary; speech recognition, answer interpretation and workflow execution still need to be connected. The composer, main view and settings reuse one native window. Closing the main view or settings returns to the composer; Alt+F4 on the composer exits Kaji.

A separate [collaborative Pi harness](docs/COLLABORATIVE-HARNESS.md) is available for developer use. It keeps an independent logical cursor and requests Rust-authorized semantic actions without driving the Windows cursor. The head-control session retains its stricter manual-takeover behavior.

[Guide/Assist workflows](docs/GUIDE-ASSIST.md) now support native confirmation and broader semantic actions. The [Cloudflare gateway](../gateway/README.md) keeps upstream model credentials outside the desktop application. See the [current checkpoint](docs/UNATTENDED-CHECKPOINT.md) for executed verification and remaining limits.

From the repository root, on Windows with Rust/MSVC, Windows SDK, WebView2 and Bun 1.4.2 installed:

```powershell
bun install --frozen-lockfile
bun run --cwd app build
bun run --cwd app check
bun run --cwd app test
bun run --cwd app native:test
```

The build downloads and verifies the pinned Face Landmarker model, copies local MediaPipe WASM, and compiles both Windows executables. Camera inference uses bundled files at runtime. Build output is `app/src-tauri/target/debug/`.

```powershell
.\app\src-tauri\target\debug\kaji-diag.exe --help
.\app\src-tauri\target\debug\kaji.exe --help
```

For a real head-control session:

```powershell
.\app\src-tauri\target\debug\kaji.exe --camera --enable-input --seconds 120
```

Hold a comfortable neutral pose for calibration. After calibration, move deliberately before the first dwell is armed. Return to neutral over the desired control and dwell for 1.2 seconds. Move away by more than 18 physical pixels to arm the next click. A missing or ambiguous operator immediately pauses input; the same operator can recover, with recalibration after a loss longer than one second. Escape, foreign mouse/keyboard input, stale frames, camera failure, or display changes stop the session. Restart explicitly after a stop. A stopped session cannot accept late frames.

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
