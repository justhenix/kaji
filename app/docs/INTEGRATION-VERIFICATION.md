# Kaji integration verification

Updated November 6, 2026 (Asia/Jakarta). Integration is implemented and built. The checkpoint pass below is current; the November 4 background pass is retained as history. Remaining acceptance is listed separately.

## November 6 checkpoint pass

| Check | Result and scope |
| --- | --- |
| Dependencies | Frozen Bun lockfile verification passed without dependency changes. |
| App | TypeScript and 64 regression tests passed. |
| Gateway | TypeScript, 27 tests, actual workerd/SQLite persistence and quota checks, and deployment dry-run passed. |
| Native | Full Rust suite passed, including 82 library and five main-binary tests. The ignored Rust/Python roundtrip was run explicitly and passed. Formatting and Clippy for all targets with warnings denied passed. |
| Bundled Python | Eight DOCX tests passed. |
| Frontend | 18 headless layout/accessibility checks passed. Readiness labels, status overflow, repeated green confirmation, both themes and reduced motion passed rendered checks. |
| Website | Astro/Svelte checks, four tests and the static build passed. |
| Live models | Earlier November 6 checks verified vision, streaming tool calls and tool-result continuation for DeepSeek and both Gemini routes. Model choices persisted through Save and reload. |
| Live native actions | New Tab opened once without approval. A controlled critical action required approval and was rejected without executing. Two consecutive final Explorer taskbar runs left a real Explorer window foreground with the physical pointer unchanged. |
| Live head control | Camera calibration completed, other input temporarily yielded control, and tracking resumed without a camera restart. Dwell clicks were disabled during this hardware check. |
| Windows installer | Optimized per-user setup built and installed. Payload and saved-login preservation verified; installed app passed 14 native smoke checks including a live typed reply with camera and voice disabled. Both launchers use the GUI subsystem. The installer is unsigned. |
| Checkpoint hygiene | Source and staged-content scans found no credentials. Private router configuration, raw diagnostic logs and live desktop captures remain outside Git. |

Detailed November 6 results and local evidence paths are in [the checkpoint](INTEGRATION-CHECKPOINT.md). This pass did not repeat unchanged provider requests or count synthetic audio as a live microphone test.

## November 4 background pass

The user authorized continued work without interrupting laptop use. This pass used repository reads, existing screenshots, an explicitly headless browser with an isolated profile, isolated Python processes, and compiler/test processes. It did not launch the native app, inject input, change foreground windows or desktop layout, access camera/microphone, play audio, or call paid or free inference services.

The review found and fixed these defects:

- DOCX whitespace cleanup assigned `Run.text`, which clears non-text OOXML children. Cleanup now edits text nodes and preserves inline drawings and field markers. Source files remain unchanged.
- Text replacement now spans formatted runs, uses original Unicode string offsets, and preserves the existing runs and non-text nodes.
- Merged table cells and linked header/footer paragraphs are processed once rather than repeatedly.
- Stop cancels playback delayed in speaker enumeration or device selection. A newer speech event supersedes an older event. Native speech is scoped to its conversation and voice session; stale synthesis results remain silent, and a new session stops current playback.
- Queued audio work and delayed wake hits cannot rearm recording in a replacement session.
- Switches and sliders now have accessible names. The microphone graphic has a valid accessible role. These changes preserve the approved visual design and Remix icons.

## Evidence

| Check | Result and scope |
| --- | --- |
| App TypeScript | Passed after the background fixes. |
| App regression suite | 53 tests passed, including six audio lifecycle cases. The final targeted audio suite passed seven cases after adding the stale wake-hit regression; the new case adds one to the suite total. |
| Python DOCX | Eight tests passed against the freshly staged isolated runtime. Cases include inline drawings/field markers, formatted replacements, Unicode offsets, merged cells, source preservation, and output validation. |
| Rust runtime contracts | Three targeted tests passed without launching native windows. |
| Rust/Python integration | Explicit ignored worker roundtrip passed against the bundled runtime. |
| Rust formatting and Clippy | Formatting and `clippy --all-targets -D warnings` passed. |
| Native build | Latest assets, managed agent, isolated Python, and native executables built in `app/src-tauri/target/integration/debug/`. The native app was not launched during this pass. |
| Headless frontend | 18 checks passed. All eight settings pages fit the 920 × 680 minimum in both themes. Axe found no serious or critical violations in the checked WCAG A/AA rules. Main/History minimum-size navigation and unavailable-runtime feedback also passed. |
| Visual review | Existing native light/dark settings and History-delete screenshots reviewed. New light/dark minimum-size screenshots reviewed; no clipping or visual regression was observed. |
| Diff hygiene | `git diff --check` passed. No commit was requested or made. |

Machine-readable background UI evidence: `app/verification/frontend-headless.json`. Screenshots: `app/verification/screenshots/headless-settings-light-min.png` and `headless-settings-dark-min.png`. These are browser layout checks, not native window or hardware acceptance.

Previously completed live checks on November 4 remain recorded separately:

- Gateway TypeScript and 25 tests; actual workerd/SQLite quota concurrency and restart persistence.
- English and Indonesian ElevenLabs audio decoded successfully and Groq recognized the expected words. Both Groq title checks produced relevant titles in the conversation language.
- MiniMax image understanding and structured tool calls matched the small dither cursor image.
- Calculator changed from `0` to `7` with one semantic action, preserving the physical pointer and foreground window.
- Real native semantic controls verified value, toggle, selection, scroll, Guide denial, exact Assist approvals, replay/staleness rejection, and pointer/focus preservation. Native Escape, takeover, watchdog, provider timeout, and stop-barrier checks passed.
- Fifteen native desktop checks passed before this background pass, including History CRUD/persistence, both settings themes, removal of the stray composer frame, and a live native-to-agent-to-Python DOCX task with an independently inspected result and saved automatic title.

The last native end-to-end report is `app/verification/desktop-live.json`. It predates the final background fixes and has intentionally not been replayed while the user is using the laptop. Previous provider evidence is in `speech-live.json` and `model.json`. The deployed gateway was not changed during the background pass.

## Remaining acceptance

- Real multi-application workflows and the full Guide/Assist walkthrough.
- Approved split-screen placement and restoration, including maximized/minimized windows and preservation of the operator's foreground app.
- Screenshot-only target execution with exact physical-action approval and fresh observation afterward.
- Person-driven aiming and dwell clicking, actual microphone/local wake detection, and selected-speaker playback. Camera startup, calibration and input handoff were checked on November 6.
- Broader native task smoke coverage; November 6 completed targeted composer, review, model-selection, taskbar and camera checks.

These scenarios remain unexecuted acceptance work and require an available desktop and the operator for device rehearsal. Developer environment management remains a separate follow-up. Provider credentials stay in their existing secret stores.
