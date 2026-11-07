# Aksesa audit

This audit records the P0 decisions. A later [collaborative Pi harness](COLLABORATIVE-HARNESS.md) adds a separate, scoped developer runtime; it does not change the head-control policy described here.

Reference inspected through the connected GitHub account at commit
`4deef432dffafd4daa4924889e552856b3728631`. Kaji is a new implementation; no Aksesa source was copied.

| Implementation | Finding | Kaji decision |
| --- | --- | --- |
| `src/lib/head-control/kinematics.ts`, `HeadMotionFilter.update` | Motion is pixels per frame. EMA coefficients, rest-frame counters, and rounding vary with camera rate. Neutral posture adapts during operation, so the reference can drift. | Fixed neutral from a stable timed calibration; velocities in pixels/second; time-based smoothing; fractional motion retained. |
| Same file, `DwellClickTracker.update` | Per-frame magnitude <=3.5 counts as stationary, so slow sustained motion can complete a dwell. A movement spike immediately rearms the click. | Actual physical cursor position is compared to a fixed dwell anchor, with a wider departure radius after clicking. Missing frames reset continuity. |
| `src/lib/head-control/controller.ts`, `processFrame`, `click` | JavaScript independently computes motion and dispatches clicks. Click and movement requests can complete after frontend state changes. Calibration accepts one pose. | Sensor submits observations only. Rust owns calibration, timestamps, session invalidation, dwell and all input. One latest-sample mailbox replaces queued motion. |
| `src-tauri/src/head_control.rs`, `head_control_click` | Calls `mouse_click` without checking `active`, takeover, session or emergency state. | No public click command. The native execution thread checks its authorization immediately before movement and before a paired down/up click. |
| Same file, `pointer_was_taken_over` | Position-only threshold misses physical buttons, keyboard input, and small movements. Frontend automatically resumes after takeover. | Tagged Win32 input plus dedicated low-level mouse/keyboard observation. Any foreign input stops the session. Resumption requires explicit native rearming and calibration. |
| `src-tauri/src/harness/state.rs` | Generation and snapshot versions are useful ideas, but checks separated from later asynchronous execution do not themselves revoke queued native work. | Session epochs, timestamps and a latest-only mailbox, checked at ingress and execution. Stop clears observations while holding the execution lock. |
| `src-tauri/src/harness/uia.rs`, `UiaWorker` | One COM worker is a sensible boundary, but `recv_timeout` leaves the worker running. A permanently hung provider can block subsequent requests indefinitely. COM initialization errors are ignored. | Disposable read-only COM process with bounded traversal/output, timeout, cancellation, kill and reap. Inspection is separate from the native input thread. |
| Same file, `read_runtime_id` | SAFEARRAY is accessed without destruction. Failed runtime IDs fall back to control type, which is not unique and can resolve to another button. | SAFEARRAY RAII destruction; no identity fallback. Missing identity means discovery only, with no clickable coordinate or resolvable token. |
| Same file, `find_element_by_runtime_id` | Re-enumerates descendants; identity lacks window/process lifetime binding. | Bounded control-view traversal; HWND, PID, process creation time, root runtime ID, element runtime ID, type and automation ID checked on resolution. |
| `src-tauri/src/harness/input.rs` | Checks SendInput count, but click failure can leave an unmatched down event. Absolute pointer setting lacks an explicit monitor/physical-pixel contract. | Paired input, release recovery on partial insertion, physical pixels, virtual desktop normalization, gap clamping, topology invalidation. |

## Pi harness and future boundaries

Reviewed `agent/agent.ts`, `agent/tools.ts`, and `agent/protocol.ts`. The sequential Pi tool loop and separation of observation from action are useful. The tool bridge's AbortSignal removes pending JavaScript callbacks, but does not establish native cancellation for an already dispatched input action. Fixed 150/400 ms delays after tools also cannot prove that an application changed.

Kaji keeps only the boundaries needed now:

- MediaPipe produces a bounded `Frame` observation; it cannot select arbitrary native actions.
- `Inspector` returns expiring observation tokens and freshly resolved physical rectangles/points. A future vision source can supply different evidence through a separate adapter.
- `Engine` owns native permission, session state, cancellation and input. Future Guide/Assist/Agent code must request effects through this boundary and verify the resulting application state separately.
- Developer JSONL commands are process-local stdin, with no network listener or model-specific dependency. Replay samples require an explicit diagnostic launch flag.

No Pi runtime, model selection, inference service, tool registry, agent loop or workflow abstraction is implemented.
