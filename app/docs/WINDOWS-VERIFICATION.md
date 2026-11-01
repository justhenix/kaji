# Reproduce on Windows

Run commands from the repository root. Use an unlocked interactive Windows desktop at ordinary integrity. Keep Calculator visible and unobscured. The scripts write machine-readable evidence into `app/verification/`, ignored by Git. No camera images are saved.

## Build and automated checks

```powershell
bun install --frozen-lockfile
bun run --cwd app build
bun run --cwd app check
bun run --cwd app test
cargo test --locked --manifest-path app/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Live safety and stalled-provider tests

These are opt-in because they touch the Windows desktop. The safety test sends Escape and a one-pixel foreign mouse movement; it uses a five-second dwell configuration and verifies zero clicks. Face loss and multiple-face cases use explicitly injected pose observations. The provider test creates a hidden window whose UIA request stalls, verifies the five-second kill deadline, and then issues another request.

```powershell
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --test windows_live -- --ignored --nocapture
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --test uia_timeout -- --ignored --nocapture
```

## Real Calculator discovery and native replay

Open Windows Calculator. Its display should contain a number; clear any pending expression. Obtain the current handle:

```powershell
$calculatorHandle = (Get-Process | Where-Object MainWindowTitle -eq 'Calculator' | Select-Object -First 1).MainWindowHandle
```

```powershell
bun app/scripts/verify-windows.ts --hwnd $calculatorHandle
bun app/scripts/verify-windows.ts --hwnd $calculatorHandle --replay
```

The first command checks real UIA discovery, current identity/rect/point, superseded tokens, stop responsiveness, cancellation and default-denied input. The second deliberately moves the pointer using replayed head poses, dwells on the discovered 7 button, verifies exactly one click and a changed Calculator display, stops, rejects late observations and verifies heartbeat expiry. Keep hands off mouse and keyboard while it runs. This validates real native effects, not webcam ergonomics.

## Webcam transport and inference

```powershell
bun app/scripts/verify-camera.ts
```

This opens the actual webcam, runs the bundled CPU Face Landmarker, submits fresh decoded-frame observations to Rust, and stops after 20 seconds. Windows camera privacy settings must already permit desktop applications. If a person is visible, this is an input-enabled session: Escape stops it. Record whether a face was detected; fresh no-face frames establish capture/inference transport but cannot establish successful head movement.

## Full definition of done with a person

Keep Calculator and its 7 button visible. Arrange the terminal so it does not cover Calculator. Sit at the camera, then run:

```powershell
bun app/scripts/verify-head.ts --hwnd $calculatorHandle --seconds 120
```

Close other applications using the webcam. Hold your normal head position until the diagnostic reports `tracking`. `initializing`, `no_face` and `calibrating` are disarmed states, not fatal errors. Turn left/right and up/down to move onto the real 7 button. Return to neutral and hold for 1.2 seconds of visible tracking. The first dwell is armed only after deliberate departure from the calibration cursor position. Keep hands away from the mouse and keyboard after capture starts. A background portrait can remain in view; association must retain the foreground operator rather than blindly requiring one detection. A genuine ambiguity pauses input.

The verifier discovers 7 even when covered, then waits up to 30 seconds for an unobscured click point before opening the camera. An outside-7 dwell is reported and tracking continues; only a dwell within 7's rectangle followed by a changed Calculator result ending in 7 can pass. Earlier non-target dwells are recorded separately. The verifier explicitly stops on completion or timeout and saves `head.json`; `head-live.json` contains the latest native status, including raw/filtered pose, neutral, calibration count, movement count and last successful click coordinate. Escape is the emergency stop; keyboard or mouse use also invalidates the session. Read [the current evidence report](LIVE-TRACKING-FIX.md) before treating a replay pass as human acceptance.

## Additional hardware matrix

Repeat the human check at different camera frame rates, light levels and seating distances. Exercise a physical mouse and keyboard during motion; disconnect the webcam; cover the face; introduce a second face; lock the desktop; change monitor layout/scaling; unplug a display; and move between monitors with negative origins and mixed DPI. These require hardware/manual execution and must retain NOT TESTED status until observed.

Do not infer application success from an inserted input event or a green unit test. Read the actual Calculator display after each demonstration.
