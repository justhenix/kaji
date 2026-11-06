# Kaji end-to-end integration plan

Originally planned November 4, 2026; updated November 6, 2026 (Asia/Jakarta). The starting point below records the November 4 baseline. Current results and remaining acceptance are in [the checkpoint](INTEGRATION-CHECKPOINT.md).

## 1. Delivery and decisions

Deliver a working Windows application that connects the existing desktop interface, native interaction engine, Pi harness, and hosted gateway. Guide, Assist, and Agent must work through text, voice, and head control, with tasks able to move between applications.

Preserve the current compact interface, Figtree/Inter typography, blue/pink identity, neutral dark surfaces, and Remix Icon. Apply antislop during implementation. Design dials: ENERGY 2 / RHYTHM 1 / MOTION 2. Motion should explain real state changes and cursor targeting.

The agreed delivery includes:

- One-line assistant replies, with the same concise message used for spoken feedback.
- A small dither Doppelganger cursor that follows the user's cursor until a task needs an independent screen target.
- UIA-first execution, vision fallback, and approval for every physical fallback action.
- Automatic application discovery and task switching without a separate target-selection prompt at every application change.
- Task-specific execution choices based on available file, API, and native capabilities, with Python DOCX processing as one adapter.
- Automatic split screen when relevant, after the user approves the method and arrangement.
- Local wake-word detection, Groq transcription, and ElevenLabs bilingual spoken feedback.
- Conversation history, automatic titles, and navigation inside the existing native window.

New Groq and ElevenLabs usage must stay within free allowances. Existing B.AI reasoning access and its request cap remain in use. A per-user Windows setup package was added on November 6 for operator rehearsal. Public accounts, website redesign, local reasoning models, and developer environment-management improvements remain outside this delivery. Environment management is the next plan.

Kaji must handle unpredictable user goals across applications and file types. YouTube scrolling alongside DOCX editing is an illustrative acceptance scenario, not a hardcoded product workflow. Resolve the user's goal and current context at runtime; never use those example application names or a fixed document-cleanup flow as universal routing rules.

## 2. Verified starting point

- The Tauri GUI, composer, settings persistence, and local head-tracking components exist. Several GUI controls currently update flags rather than operate their corresponding services.
- Composer request and answer events currently stop at the frontend boundary.
- The Pi harness and workflow executor exist under `app/agent/`; native UIA execution and approval checks exist in Rust.
- The deployed gateway uses `minimax-m3.1-flash`, an owner credential, bounded requests, and a global model-request budget. It currently accepts text only.
- Native head control and the Assist executor currently create separate input observers and ownership leases. They need shared ownership to coexist in the desktop application.
- History settings exist, but conversation persistence and a history view are not implemented. Python document execution and application split-screen coordination are also new work.

Baseline checks executed during planning: app TypeScript check and 26 tests; gateway TypeScript check and 12 tests; 58 Rust tests. Four live desktop tests were ignored. These results do not establish live camera, speech, vision, or multi-application acceptance.

## 3. Runtime and frontend contracts

### Ownership and lifetime

- Make the Rust runtime authoritative for tasks, permissions, device state, approvals, questions, overlays, and persisted conversations.
- Keep runtime state alive while the main window navigates between composer, main view, settings, history, and a conversation.
- Reuse the existing Pi harness and workflow executor through a managed Bun-compiled sidecar with private JSONL transport. Disable dotenv autoloading in that executable.
- Keep native execution in Rust. The model receives bounded task tools, not a shell, approval capabilities, or credential-reading tools.
- Load the existing owner credential through native DPAPI. Provider keys remain Worker secrets; the owner credential never reaches a WebView.
- Retain one active task at a time. Bind every task and its results to its originating conversation, even while the user browses history.

### Commands, snapshots, and events

- Add typed `gui_dispatch` commands, a `gui_get_runtime` snapshot, and `kaji:runtime-update` events. Connect existing composer actions through this bridge.
- Define shared contracts for `RuntimeSnapshot`, `TaskStep`, `PendingQuestion`, and `OverlayState`, including task ID, conversation ID, native session ID, and revision where relevant.
- Cover task start, answer, method choice, approval, pause, resume, stop, device controls, layout restoration, and history operations through the typed boundary.
- Distinguish clarification, execution-method selection, and native approval. Only a matching current native approval can authorize its exact action.
- Reject stale answers and approvals. Ignore delayed results after cancellation, deletion, or a newer task revision.
- Subscribe to events and fetch a current snapshot when each view mounts. A frontend page must never infer that a device is active merely because a saved preference is enabled.
- Preserve unsaved settings drafts during runtime updates. Report persistence and service-start failures instead of silently presenting success.

## 4. General task execution and method selection

### Modes, switching, and verification

| Mode | Application behavior |
| --- | --- |
| Guide | Explain and point; the user performs application mutations. Observe the effect before advancing. |
| Assist | Run routine semantic actions under Auto review; ask before critical or unclear actions. Verify the effect before continuing. |
| Agent | Execute bounded semantic steps within the requested task, subject to the saved native review policy. Physical fallback actions still require approval. |

- Add native discovery of open windows and installed applications, plus verified launch and focus-switch operations. The model selects opaque entries from the native catalog.
- Prefer background UIA when the user is occupied in another application. Activate a target only when the operation requires it and its mode/approval permits it.
- Invalidate old element tokens, captures, and approvals when changing targets. Inspect the newly bound window before acting.
- Verify that Windows actually activated the requested target. If activation fails, report recovery state rather than continuing against the wrong foreground window.
- Reuse one step executor for semantic and visual steps, with observable postconditions. An accepted action is not a completed task.
- Keep unknown effects unverified. Resume must inspect whether an earlier action executed before requesting it again.
- Preserve the existing limits across pauses and approvals: 12 model turns, 32 tool calls, and 120 seconds of active execution. Human waiting time does not consume the active execution deadline.
- Plan from the user's request and live application, window, file, and capability observations. Support changes of goal, unfamiliar interfaces, ambiguous targets, and missing prerequisites through inspection and concise clarification.
- Select among registered executors by their actual capabilities and prerequisites. Native UIA/vision is a general path; file and API adapters are offered only where implemented and applicable. Do not treat a model-generated method name as an installed capability.

### Shared native input

- Create one shared input observer and ownership service for the desktop host. Retain explicit launch authorization for diagnostic CLIs.
- Keep head control available during guidance, task questions, and approvals.
- Other input briefly yields head movement and clicks without ending the camera session. Resume after 1.5 seconds idle, with fresh aiming required before dwell can click. Escape and observer failures still stop control.
- Distinguish operator activity, head-control input, and automation input. Operator interaction with the automation target pauses conflicting work; unrelated-window activity can continue.
- Serialize physical fallback dispatch with head movement. Reconcile the observed pointer position and reset dwell afterward without weakening freshness or takeover checks.
- Pause/stop must invalidate pending work before returning. Preserve Escape, watchdogs, late-frame rejection, and existing single-use approval checks.

### Vision fallback

- Extend the existing gateway and Pi observations to support bounded target-window images. Complete a live B.AI image-plus-tool smoke test before enabling vision in the product.
- Capture the selected window without Kaji overlays. Keep captures in memory and report unavailable captures explicitly.
- Prefer UIA targets and semantic actions. For unsupported surfaces, support visually grounded click, scroll, text entry, and key actions.
- Require approval for each physical fallback action, including Agent mode. Bind approval to the window/process identity, capture, target coordinates, action, and current revision.
- Revalidate the target before dispatch. Changed or expired grounding requires a new capture and approval.

### Task-specific method choice

- Show a method question when the current task has a meaningful execution tradeoff. Generate its title, available choices, and recommendation from the goal, available executors, and current user activity.
- Recommend a background file or API operation when it fits the task and lets the user continue their own work. Native computer use remains available when it is an implemented suitable path.
- Treat method IDs as opaque executor IDs. The runtime must validate the selection against the choices offered for that exact task/question. The frontend renders supplied labels and IDs without a fixed DOCX/native enum.
- Retain No, ask Kaji differently and a separate Cancel button. Do not force a method menu for every simple request or offer unsupported executors as working choices.

### DOCX adapter example

For a DOCX formatting request, one possible task-specific question is:

**How should Kaji tidy this document?**

1. Python DOCX generation (Recommended)
2. Native computer use
3. No, ask Kaji differently

Provide separate **Cancel** and **Continue** buttons. When a split is relevant, display the actual application windows and proposed arrangement before Continue; include a checked Split screen option that the user can turn off. Other tasks use their own applicable question and choices.

- Recommend Python when the source DOCX is accessible and the requested operation is supported. Ask for the source file when it is missing.
- Use a managed Python worker with pinned `python-docx` and typed document operations. Do not expose an unrestricted Python execution tool to the model.
- For an existing document, make minimal edits to a saved copy. Preserve content, styles, tables, images, headers, and other untouched structures. Resolve unsaved or unavailable sources before processing.
- Save a separate output, render it, and verify layout/content before opening the result. Keep the original intact.
- Native computer use follows the selected Guide/Assist/Agent policy and existing per-action physical approval rules across applicable tasks and applications.
- The third option restores the original request in the composer for revision without starting work. Cancel stops the pending request without changing files or window positions.

### Approved split screen

- Resolve the user's current application and task application dynamically from verified window identities. After Continue approves a relevant arrangement, place the user application on the left and task application on the right, using a 50/50 split within the active monitor's work area.
- Preserve the user's focus and pointer during background work. Open a verified artifact in the task area when a viewer is needed. Background tasks with no suitable task window do not require a split.
- Record original window placements and provide Restore layout. Respect later manual window movement instead of repeatedly snapping windows back.
- Verify the arrangement and handle closed windows, changed displays, and windows that cannot fit. Do not mark an unsuccessful arrangement as complete.
- Concurrent activity in an unrelated user application is supported by suitable background file/API work or background UIA. A physical pixel action still needs a brief approved input handoff; split screen does not create a second physical Windows pointer.

## 5. Interface, replies, and Doppelganger

### Assistant replies

- Instruct the selected reasoning model to return one concise user-facing sentence, ideally no more than 20 words, for acknowledgement, guidance, results, and recovery.
- Avoid paragraphs, preambles, repeated narration, and unsolicited explanation. Provide longer explanation when the user explicitly asks.
- Feed the same concise message to TTS.
- Keep structured tool arguments, internal task plans, and document contents outside this prose limit. Do not reduce the tool-output budget or truncate JSON to enforce short replies.

### Cursor behavior

Follow the physical cursor with the small dither cursor beside it, on the same vertical line. Use a restrained blue/pink glow so it remains visible on application content. Switch to the left side near a display's right edge; keep the sprite and glow inside that display. Apply the offset only while following. During a task, the cursor tip must remain at the exact grounded target.

- Use website `/art/cursor.png`, artwork kind `cursor`, at 24 logical pixels wide with its original aspect ratio. Bundle it through the existing asset preparation path.
- Align the artwork's actual tip with the intended point. Render it with crisp dither detail.
- Use a transparent, click-through, nonactivating overlay. The overlay must not intercept clicks, dwell, keyboard focus, or screenshots.
- Follow the user's physical cursor while idle, listening, or waiting for task grounding. A background Python job without a screen target can remain in follow mode.
- Switch to an independent logical target when a task has valid grounding. Hold that target during guidance and approval.
- Pause, completion, cancellation, or invalidation releases the target and returns to follow mode. Hide the overlay when disabled or the interactive desktop is unavailable.
- Render genuine target highlights and dwell progress from runtime state. Handle monitor offsets and DPI conversion without moving the Windows pointer merely to display Doppelganger.

### Main window and settings

- Preserve the existing composer geometry and fixed viewport behavior during expansion and navigation.
- Drive status, animation, microphone state, transcript, questions, approvals, and dwell indicators from real runtime updates.
- Keep all visible controls functional, keyboard accessible, and usable in both themes and at minimum window sizes.
- Wire real device IDs, microphone testing, calibration, sensitivity, dwell, permissions, shortcuts, appearance, and response language.
- Remove unsupported local/custom reasoning choices, fictitious model tiers, offline voice-pack claims, redundant autonomy/approval policies, analytics, updates, and unimplemented startup/tray options.
- Keep history and retention controls because history is part of this delivery. Migrate saved settings deliberately; do not pass removed fields into strict native deserialization.

## 6. Speech services and gateway

### Provider roles

| Purpose | Selected service/model | Usage decision |
| --- | --- | --- |
| Reasoning and vision | B.AI `deepseek-v4.1-flash`; optional 9router Gemini 3.8 Flash Medium/High | Native vision and tool continuation verified for all three routes. Keep remote router credentials and endpoint private. |
| Wake word | Bundled sherpa-onnx WASM keyword detector | Local processing with fixed Hey Kaji phrase. |
| Speech to text | Groq, `whisper-large-v3-turbo` | Free allowance only. |
| Spoken feedback | ElevenLabs, `eleven_v4_turbo` | Free allowance only; use an available default voice. |
| Conversation titles | Groq, `qwen/qwen3.8-27b` | Free allowance only; reasoning disabled. |

### Audio lifecycle

- Add a persistent hidden audio host for capture, microphone levels, local keyword detection, and playback. Navigation must not accidentally restart recording or duplicate listeners.
- Keep idle audio local. Upload only command audio after local wake detection, microphone activation, or push-to-talk.
- Use local silence detection and bounded utterances: 16 kHz mono WAV, maximum 30 seconds. Support English, Indonesian, and automatic language detection.
- Prevent spoken feedback from retriggering wake detection or answering Kaji's own approval questions.
- Route recognized answers to the current question ID. Use explicit matching approval responses; the model cannot approve its own action.
- Speak concise instructions, questions, results, and errors. Reuse identical audio within the session. Keep text/head workflows usable when speech is unavailable.
- Release recording and playback resources on disable, device failure, stop where appropriate, and application exit.

### Gateway additions

Retain authenticated `POST /v1/chat/completions`, its fixed reasoning model, output bounds, deadline, cancellation, and existing owner budget. Add bounded image input without accepting arbitrary provider URLs or models.

Add these authenticated routes:

| Route | Purpose |
| --- | --- |
| `POST /v1/audio/transcriptions` | Forward validated audio to the fixed Groq STT model. |
| `POST /v1/audio/speech` | Synthesize bounded text using the fixed ElevenLabs model and an allowed default voice. |
| `POST /v1/chat/titles` | Generate a short title using the fixed Groq title model. |
| `GET /v1/capabilities` | Return usable service capabilities, model/voice availability, and relevant quota state without exposing credentials. |

- Store `GROQ_API_KEY` and `ELEVENLABS_API_KEY` in Worker secrets alongside the existing B.AI secret. Provision them securely before live acceptance.
- Keep speech and title accounting separate from the existing B.AI model-request budget.
- Enforce the supplied Groq STT allowance: 20 requests/minute, 2,000 requests/day, 7,200 audio seconds/hour, and 28,800 audio seconds/day.
- Enforce the supplied title-model allowance: 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute, and 200,000 tokens/day. Provider responses remain authoritative when limits change or other applications consume the same account allowance.
- Check ElevenLabs subscription usage and reserve allowance atomically before synthesis. Use available free credits with a configured monthly ceiling of 10,000 credits; do not assume that credits always equal twice as many characters.
- Use only free API-compatible default voices and output formats. No paid fallback, top-up, subscription upgrade, or automatic provider switch.
- Handle `429`, quota exhaustion, timeout, and cancellation without automatic retries that amplify usage. A failed title request keeps the local title; exhausted TTS keeps visible feedback.

## 7. History and automatic titles

### Navigation and persistence

- Replace the marked footer Emergency stop button with History using Remix Icon. Retain Pause and the global emergency-stop shortcut, including native Escape behavior.
- Reuse the same native window for the history list and conversation detail. Give each view a Remix back arrow that returns to the preceding view.
- Match the compact Recents reference: actual session titles in scannable rows, with search, New session, reopen, rename, and delete actions.
- Store conversations locally in a Rust-owned SQLite database. Persist user messages/transcripts, concise assistant replies, task outcomes, and generated-file references.
- Keep raw audio and screenshots out of history. Never persist approval capabilities as reusable authorization.
- Wire Save conversation history and the existing 7-day, 30-day, 90-day, and Forever retention choices. Retain the existing defaults of saving history and 30-day retention.
- Disabling saved history prevents further persistence while leaving existing history available for explicit deletion or retention cleanup.
- Browsing history does not cancel a running task. Its results continue to update the original conversation. Starting another task requires the current task to finish or be explicitly stopped.
- Reopening a conversation restores its transcript. Continuing creates fresh native grounding and approvals; historical actions are never replayed automatically.

### Title generation

Use this title-only request configuration through the gateway:

```json
{
  "model": "qwen/qwen3.8-27b",
  "temperature": 0.2,
  "max_completion_tokens": 80,
  "reasoning_effort": "none"
}
```

The title instruction is:

> Return only a title of 3 to 6 words describing the conversation's main task. Use the conversation's language. Be specific. Do not add quotes, emoji, a prefix, or trailing punctuation.

- Derive an immediate local title from the first meaningful user request. Do not create persistent empty sessions merely because the composer opened.
- Generate an automatic title once after the first exchange, asynchronously, using the first request and concise assistant reply. Do not send the full transcript or raw desktop observations for naming.
- Validate and normalize the returned title. Empty, invalid, truncated, failed, or quota-limited results retain the local title without automatic retry.
- Manual rename always wins. A delayed response must not overwrite a manual title, revive a deleted session, or update another conversation.

## 8. Implementation sequence

1. **Runtime foundation:** introduce shared contracts, Rust task ownership, sidecar lifecycle, event/snapshot synchronization, and cancellation boundaries. Connect typed composer requests and text responses first.
2. **Native coordination:** share input ownership, wire real head controls and calibration, add window/application discovery, and verify semantic Guide/Assist/Agent workflows.
3. **Conversation persistence:** add SQLite history, same-window routing, back navigation, session lifecycle, and actual privacy/retention behavior.
4. **Task methods and adapters:** add capability-based method selection, the managed Python DOCX adapter, verified output copies, dynamic approved split screen, and layout restoration.
5. **Overlay and vision:** bundle the small cursor, implement follow/task transitions, add target capture and multimodal gateway support, and stage approved physical fallback actions.
6. **Speech and titles:** provision Worker secrets, add service routes and quotas, connect local wake detection, Groq STT, ElevenLabs playback, and asynchronous titles.
7. **Interface completion:** reconcile settings with implemented capabilities, remove inert controls, and verify both themes, keyboard use, error states, and composer geometry.
8. **Delivery verification:** deploy backward-compatible gateway changes after checks, build the desktop runtime and assets, and complete real Windows and person-driven acceptance.

Each stage should leave a working, testable path. Do not replace the existing native executor or duplicate the Pi orchestration without a demonstrated need.

## 9. Acceptance and evidence

### Automated checks

- Run app and gateway TypeScript checks and meaningful regression tests, native Rust tests, formatting checks, and Clippy.
- Test stale revisions, delayed results, approval expiry/replay, sidecar loss, stop barriers, and task limits across pause/resume.
- Test shared input ownership, operator takeover, head dwell reset after physical handoff, and unchanged frame/watchdog safeguards.
- Test window identity changes, failed activation, visual target invalidation, DPI transforms at 100%, 150%, and 200%, and negative monitor coordinates.
- Test speech question routing, playback feedback prevention, cancellation, free quota accounting, and `429` recovery.
- Test SQLite persistence, retention, disabled saving, search, deletion, English/Indonesian titles, fallback titles, and manual-rename races.
- Test DOCX preservation and output integrity, cancellation before processing, approved split screen, and restoration of recorded window placements.
- Test routing and method selection for unrelated goals, file types, and application names. Ensure choices reflect available capabilities and cannot be inferred from a YouTube/DOCX phrase match. Test that unknown methods are rejected and unfamiliar tasks can ask for clarification without dispatching an unrelated workflow.

### Real application acceptance

- Complete Calculator tasks in Guide, Assist, and Agent. Verify actual display changes and exact action counts.
- Enter and verify text in Notepad, then complete a browser-to-Notepad task with genuine application switching.
- Exercise a screenshot-only target and confirm that physical actions wait for exact approval.
- Keep YouTube scrolling usable while Python tidies a DOCX; verify the saved copy and the approved split-screen arrangement.
- Also exercise non-document tasks such as browser forms and a spreadsheet or file-management workflow using actual available capabilities. Verify that method recommendations, application targets, background behavior, and approved layouts adapt to the task.
- Verify background UIA pointer/focus preservation separately from explicitly approved physical input handoff.
- Complete person-driven camera calibration, aiming, dwell approval, English/Indonesian speech, local wake detection, and spoken feedback.
- Exercise every visible control, both themes, minimum window sizes, and composer transitions. Record console errors, screenshots, application effects, and control-by-control evidence.

A successful build, an accepted native action, or an HTTP 200 is not sufficient evidence of task completion. Keep unexecuted hardware checks and failed results distinct from verified behavior.

## 10. Next plan: developer environment configuration

Plan easier developer configuration separately after this integration specification:

- Centralize Groq and ElevenLabs configuration and the LLM-provider selection.
- Keep B.AI as the initial reasoning provider; allow a later custom/local Indonesian gateway or another compatible provider.
- Make service roles independently configurable, including title generation.
- Define developer configuration loading, validation, precedence, and secure Worker-secret provisioning in that next plan.
- Preserve the boundary between local development configuration and deployed secrets. No provider key belongs in frontend bundles or committed configuration.

Current integration still provisions the secrets needed for its selected services. A general environment-management implementation is not included here.

## References checked during planning

- [B.AI API reference](https://docs.b.ai/llmservice/api/)
- [Tauri IPC](https://v2.tauri.app/concept/inter-process-communication/)
- [Tauri external binaries](https://v2.tauri.app/develop/sidecar/)
- [Groq speech to text](https://console.groq.com/docs/speech-to-text)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq reasoning controls](https://console.groq.com/docs/reasoning)
- [Groq Qwen 3.8 27B](https://console.groq.com/docs/model/qwen/qwen3.8-27b)
- [ElevenLabs v4 and free-tier access](https://elevenlabs.io/v4)
- [ElevenLabs TTS and free API voice restrictions](https://elevenlabs.io/docs/overview/capabilities/text-to-speech)
- [ElevenLabs subscription usage API](https://elevenlabs.io/docs/api-reference/user/subscription/get)
- [sherpa-onnx keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)
- [python-docx documentation](https://python-docx.readthedocs.io/en/latest/)
- [Windows window positioning](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)
- [Windows window placement](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowplacement)
