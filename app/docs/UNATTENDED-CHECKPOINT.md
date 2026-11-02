# Unattended checkpoint: November 2, 2026

The unchanged website is live at [kaji.henix.my.id](https://kaji.henix.my.id). The authenticated Cloudflare gateway is live at `https://kaji-gateway.relanta.workers.dev`; its upstream key is a server secret. The developer harness has native value, toggle, selection and scrolling actions plus Guide/Assist workflow logic. No product frontend, overlay, camera session or installer was added.

## Executed evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Ordinary Rust regression suite | PASS | 51 library tests, 2 sensor-gate tests and 2 protocol tests: 55 total. |
| TypeScript and Bun | PASS | App typecheck and 24 tests, including malicious tool calls, confirmation redaction, cancellation, workflow verification and recovery without replay. Gateway typecheck and 12 tests; website check, 4 tests and static build. |
| Actual Worker runtime and SQLite | PASS | `gateway/scripts/verify-runtime.mjs` used actual workerd, concurrent acquisitions, forged release, 200 requests and a restart preserving the daily quota. No upstream inference was used for this test. |
| Deployed gateway | PASS | Missing/wrong credentials returned 401; unauthorized model and oversized output returned 400. Real JSON and SSE inference returned `KAJI_OK`; sequential requests released the global lease. |
| Real MiniMax / Calculator effect | PASS for the application effect | The first live model run changed `0` to `7` with exactly one native pushbutton action and unchanged pointer/focus. A later run again independently verified `0` to `7`, one action and safe stop, but its idle-pointer check failed on a one-pixel change. |
| Real Assist workflow | PASS | Default Assist staged without dispatch; the test host consumed one exact confirmation, Calculator changed `0` to `7`, and verification completed both the clear and digit steps. The clear postcondition was already satisfied, so it dispatched no clear action. |
| Real Guide workflow | PASS for observation | Guide awaited an external effect, observed Calculator `7` to `77` and completed with zero Guide actions. A separate scoped native test executor supplied the external effect; no human interaction is claimed. |
| Real broader actions | PASS for individual application effects; full idle test FAIL | Actual Win32 controls accepted Unicode value entry, desired toggle state without toggling twice, selection and scroll to 100%. Forged/replayed/superseded confirmations, changed-target dispatch and stopped sessions were rejected. The combined test's final pointer assertion failed on later runs: five- and six-pixel changes were observed. One earlier complete run passed before the final end-of-test pointer assertion was added. The origin of later movement is not established. No assertion was relaxed. |
| Native collaboration and emergency stop | PASS | Actual foreign mouse movement retained the logical cursor; target input paused the session; Escape revoked it. Queued initialization could not rearm after stop. |
| Existing native P0 safety tests | PASS | Escape, manual takeover, face loss, portrait association/recovery, watchdogs, late initialization and stop barrier passed. The hung UIA provider was killed and the next inspection returned. |
| Calculator head-pose replay rerun | FAIL | Discovery, identity, cancellation, outside-target suppression and native movement passed. The source stopped before dwell with `manual takeover; explicit begin required`; zero clicks were sent. Existing takeover validation remains unchanged. Earlier replay passes remain historical evidence, not a pass for this run. |
| Clippy, formatting and source credential scan | PASS | All Rust targets with warnings denied; Rust formatting; Git whitespace check; no credential-shaped values found in tracked or unignored source. |
| Windows credential storage | PASS | Runtime credential encrypted with current-user DPAPI outside the repository. Wrapper decryption matched the provisioned credential and help command ran without exposing it. |
| Remote network reliability | Intermittent FAIL | Two model attempts returned `Connection error.` before any native action. Direct SDK, gateway JSON/SSE, read-only Pi and later full tool-loop requests succeeded. The network failure was not isolated; no automatic retry was added. |
| Human head-control acceptance | NOT TESTED | No person was recruited for calibration, comfort, aiming or a webcam dwell click. The earlier incomplete acceptance remains incomplete; camera stayed off. |
| General applications, mixed-DPI hardware, installer | NOT TESTED | New semantic patterns were checked against real native test controls and Calculator, not every UIA provider. An installer is not configured. |

Ignored local application evidence is in `app/verification/model.json`, `workflow.json`, `assist.json`, `inspection.json` and `replay.json`. Later runs replace those files; the table explicitly distinguishes earlier passes from later failures. The original successful model run was observed at `2026-11-02T02:21:16Z`; the later one-pixel failure was observed at `2026-11-02T03:55:51Z`.

## Security and remaining work

Prompt instructions do not guarantee resistance to prompt injection. The model has no confirmation, mode-switch, session-creation, shell, credential, browser or physical-input tool. Rust independently enforces scope and exact Assist confirmation. Agent mode is explicit and still permits actions in its authorized window. Supported applications can have their own side effects, so broad arbitrary-application autonomy is not claimed.

The gateway has one owner credential, a fixed endpoint/model, request/output bounds, a global daily acquisition cap and one in-flight request. This bounds use but is not public multi-user authentication or a dollar spending cap. Browser CORS restrictions are supplementary; bearer validation is mandatory. [Gateway setup](../../gateway/README.md) explains provisioning, revocation and the Windows wrapper.

GitHub Actions is configured for Linux TypeScript/website/workerd checks and ordinary Windows Rust checks, with pinned action commits and read-only repository permission. Vercel is connected to the private GitHub repository. Cloudflare deploys currently use authenticated Wrangler; no local OAuth credential was copied to GitHub. Hosted CI results must be read from the branch's actual run before calling them passed.

Next required acceptance work is an idle-desktop rerun of pointer/replay checks, investigation of any reproducible unexplained movement, and the original person-driven webcam Calculator test. Frontend work remains deferred. [Guide/Assist architecture and commands](GUIDE-ASSIST.md) describe the implemented backend.
