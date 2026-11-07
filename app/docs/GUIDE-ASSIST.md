# Guide and Assist execution

`kaji-assist` remains the sole mutation authority. `begin` accepts `guide`, `assist` or `agent`; omission defaults to Assist. Inspection and pointing work without action permission. All mutations additionally require the process launch flag `--enable-actions`. Mutating sessions remain exclusive with head control. No product GUI or overlays were added.

Guide cannot dispatch actions even if the process has action permission. Target-window user input invalidates its grounding while leaving observation active. Assist stages an exact action and returns an opaque host confirmation capability; no effect is dispatched until that capability is consumed. Agent is an explicitly selected mode for bounded automatic execution, not the default.

`cursor_act` supports UIA Value, Toggle, SelectionItem and Scroll patterns in addition to Invoke. Values are limited to 4,096 characters without NUL; toggle specifies the desired on/off state; scroll specifies absolute percentages in supported axes. Password and read-only controls are excluded. Unsupported controls have no physical-input fallback. Existing Win32 pushbutton notifications avoid Calculator's focus-stealing UIA Invoke proxy. Other UIA providers can change focus; this pauses execution and requires explicit recovery.

The element token, session, target window/process lifetime, runtime identity and display topology are revalidated. Assist also binds approval to the observed target name, value, rectangle, selection, toggle and scroll state. Changing these after staging rejects dispatch. Confirmation and element leases last at most 15 seconds. A new inspection, new point, pause, stop, target activity or expiry invalidates approval. Capabilities are single-use. Serde uses empty struct variants for no-argument actions so unknown fields cannot be silently accepted.

The model receives only five tools: inspect, logical point, Invoke, semantic action and status. It cannot begin another session, change mode, confirm, resume, run a shell or read credentials. Confirmation IDs are removed from model observations. Even a malicious model response naming a nonexistent confirmation tool cannot reach the native confirmation API. These restrictions contain prompt injection; they do not establish that an AI model cannot be influenced by application text. Agent mode still permits actions within its explicitly authorized scope.

## Workflow host

`agent/workflow.ts` accepts a bounded sequence of explicit steps: instruction, unique control selector, semantic action and an observable postcondition. It uses fresh inspection and logical pointing, returning rectangle/point information for a future presentation layer. Ambiguous or missing targets block progress. Guide waits for an external effect; Assist waits for native confirmation. Neither advances until inspection satisfies the postcondition. Already-satisfied conditions are reported separately without dispatch.

Verification uses exact property equality, including whitespace in text values. The Calculator verifier uses its numeric display's name instead of trimming generic application text. Accepted requests are not treated as successful effects. Pause/resume retains the step, invalidates old grounding and requires fresh approval. Once an effect has been requested, recovery verifies its outcome without automatically replaying it. Cancellation and stop prevent delayed inspection results from publishing an active workflow.

The developer JSONL host exposes this implementation without a GUI:

```powershell
bun run --cwd app workflow --hwnd $calculatorHandle --mode guide
bun run --cwd app workflow --hwnd $calculatorHandle --mode assist --enable-actions
```

Host commands: `start` with `steps`, `status`, `confirm` with `confirmation_id`, `verify`, `advance`, `pause`, `resume`, `stop`, `shutdown`. The trusted host controls confirmation, not the model. For example, a step can use `target: {automation_id: "137", control_type: 50000}`, `action: {kind: "invoke"}`, and `expect: {target: {automation_id: "158"}, property: "name", equals: "7"}` for the tested legacy Calculator. These IDs are application-specific; inspect the current target first.

Reproduce the real application checks:

```powershell
$calculatorHandle = (Get-Process win32calc | Select-Object -First 1).MainWindowHandle
bun app/scripts/verify-workflow.ts --hwnd $calculatorHandle
bun app/scripts/verify-assist.ts --hwnd $calculatorHandle
cargo test --locked --manifest-path app/src-tauri/Cargo.toml --test actions_live -- --ignored --nocapture
```

The last check creates real Win32 controls and checks value, toggle, selection, scrolling, approval rejection and cursor/focus preservation. It requires an idle desktop; physical cursor changes fail the check. The Guide application verifier uses a separate explicitly scoped test executor to supply the external Calculator effect. It is not human acceptance.

The gateway and deployment are documented in [gateway/README.md](../../gateway/README.md). Current evidence and remaining limits are recorded in [the unattended checkpoint](UNATTENDED-CHECKPOINT.md).
