use kaji_engine::native;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
    },
    time::Duration,
};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::*,
    },
    core::{HSTRING, w},
};

static BUTTON_EFFECTS: AtomicU64 = AtomicU64::new(0);
unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        if message == WM_COMMAND && wp.0 & 0xffff == 201 {
            BUTTON_EFFECTS.fetch_add(1, Ordering::SeqCst);
            return LRESULT(0);
        }
        if message == WM_DESTROY {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, message, wp, lp)
    }
}
struct Fixture {
    hwnd: isize,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new() -> Self {
        let (tx, rx) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || unsafe {
            native::dpi_aware();
            let instance = GetModuleHandleW(None).unwrap();
            let class = WNDCLASSW {
                hInstance: instance.into(),
                lpszClassName: w!("KajiActionFixture"),
                lpfnWndProc: Some(window_proc),
                ..Default::default()
            };
            assert_ne!(RegisterClassW(&class), 0);
            let root = CreateWindowExW(
                WS_EX_NOACTIVATE,
                w!("KajiActionFixture"),
                w!("Kaji native action verification"),
                WS_OVERLAPPEDWINDOW,
                30,
                30,
                650,
                520,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            let control =
                |class: &str, title: &str, id: usize, style: WINDOW_STYLE, x, y, width, height| {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        &HSTRING::from(class),
                        &HSTRING::from(title),
                        WS_CHILD | WS_VISIBLE | style,
                        x,
                        y,
                        width,
                        height,
                        Some(root),
                        Some(HMENU(id as _)),
                        Some(instance.into()),
                        None,
                    )
                    .unwrap()
                };
            control(
                "Edit",
                "initial",
                101,
                WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                20,
                20,
                260,
                28,
            );
            control(
                "Edit",
                "private fixture value",
                102,
                WS_BORDER | WINDOW_STYLE(ES_PASSWORD as u32),
                20,
                60,
                260,
                28,
            );
            control(
                "Edit",
                "read only",
                103,
                WS_BORDER | WINDOW_STYLE(ES_READONLY as u32),
                20,
                100,
                260,
                28,
            );
            control(
                "Button",
                "Feature enabled",
                104,
                WINDOW_STYLE(BS_AUTOCHECKBOX as u32),
                20,
                145,
                260,
                28,
            );
            let list = control(
                "ListBox",
                "",
                105,
                WS_BORDER | WINDOW_STYLE(LBS_NOTIFY as u32),
                20,
                190,
                260,
                110,
            );
            for text in ["Alpha", "Beta", "Gamma"] {
                let text = HSTRING::from(text);
                SendMessageW(
                    list,
                    LB_ADDSTRING,
                    Some(WPARAM(0)),
                    Some(LPARAM(text.as_ptr() as _)),
                );
            }
            let scroll = control(
                "ListBox",
                "",
                106,
                WS_BORDER | WS_VSCROLL | WINDOW_STYLE(LBS_NOTIFY as u32),
                320,
                20,
                260,
                340,
            );
            for n in 0..200 {
                let text = HSTRING::from(format!("Row {n}"));
                SendMessageW(
                    scroll,
                    LB_ADDSTRING,
                    Some(WPARAM(0)),
                    Some(LPARAM(text.as_ptr() as _)),
                );
            }
            control(
                "Button",
                "Guard target",
                201,
                WINDOW_STYLE(BS_PUSHBUTTON as u32),
                20,
                330,
                260,
                28,
            );
            let _ = ShowWindow(root, SW_SHOWNOACTIVATE);
            tx.send(root.0 as isize).unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnregisterClassW(w!("KajiActionFixture"), Some(instance.into()));
        });
        Self {
            hwnd: rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            thread: Some(thread),
        }
    }
    fn text(&self, id: i32) -> String {
        unsafe {
            let mut text = [0u16; 512];
            let length = GetWindowTextW(
                GetDlgItem(Some(HWND(self.hwnd as _)), id).unwrap(),
                &mut text,
            );
            String::from_utf16_lossy(&text[..length as usize])
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(Some(HWND(self.hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
struct Client {
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    id: u64,
}
impl Client {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kaji-assist"))
            .arg("--enable-actions")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output: rx,
            id: 0,
        }
    }
    fn request(&mut self, mut command: Value) -> Value {
        self.id += 1;
        command["id"] = json!(self.id);
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        let value = self
            .output
            .recv_timeout(Duration::from_secs(8))
            .expect("native response deadline");
        assert_eq!(value["id"], self.id);
        value["result"].clone()
    }
    fn ok(&mut self, command: Value) -> Value {
        let result = self.request(command);
        assert!(result.get("Ok").is_some(), "{result}");
        result["Ok"].clone()
    }
    fn inspect(&mut self, session: u64) -> Value {
        self.ok(json!({"command":"inspect","session":session}))
    }
    fn point(&mut self, session: u64, element: &Value) -> u64 {
        self.ok(json!({"command":"point","session":session,"element_id":element["id"]}))["revision"]
            .as_u64()
            .unwrap()
    }
    fn stage(&mut self, session: u64, element: &Value, action: Value) -> Value {
        let revision = self.point(session, element);
        self.ok(json!({"command":"act","session":session,"revision":revision,"action":action}))
    }
    fn confirm(&mut self, session: u64, proposal: &Value) -> Value {
        self.ok(json!({"command":"confirm","session":session,"confirmation_id":proposal["confirmation"]["id"]}))
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn by_id(snapshot: &Value, id: &str) -> Value {
    snapshot["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["automation_id"] == id)
        .unwrap_or_else(|| panic!("missing control {id}: {snapshot}"))
        .clone()
}

#[test]
#[ignore = "unlocked, idle Windows desktop; creates real controls and asserts cursor/focus preservation; do not move the mouse during this test"]
fn semantic_actions_and_native_confirmation_are_real_and_bounded() {
    native::dpi_aware();
    let fixture = Fixture::new();
    let mut client = Client::new();
    let begin = client.ok(json!({"command":"begin","hwnd":fixture.hwnd,"mode":"guide"}));
    let session = begin["session"].as_u64().unwrap();
    let snapshot = client.inspect(session);
    let edit = by_id(&snapshot, "101");
    assert_eq!(edit["supports_set_value"], true);
    assert_eq!(by_id(&snapshot, "102")["value"], Value::Null);
    assert_eq!(by_id(&snapshot, "102")["name"], "");
    assert_eq!(by_id(&snapshot, "102")["supports_set_value"], false);
    assert_eq!(by_id(&snapshot, "103")["supports_set_value"], false);
    let revision = client.point(session, &edit);
    let denied = client.request(json!({"command":"act","session":session,"revision":revision,"action":{"kind":"set_value","value":"denied"}}));
    assert!(denied["Err"].as_str().unwrap().contains("Guide"));
    assert_eq!(fixture.text(101), "initial");

    let begin = client.ok(json!({"command":"begin","hwnd":fixture.hwnd}));
    let session = begin["session"].as_u64().unwrap();
    assert_eq!(begin["mode"], "assist");
    let physical = native::cursor().unwrap();
    let foreground = native::foreground();
    let snapshot = client.inspect(session);
    let edit = by_id(&snapshot, "101");
    let proposal = client.stage(
        session,
        &edit,
        json!({"kind":"set_value","value":"Kaji café 日本語"}),
    );
    println!(
        "before: cursor={physical:?}, foreground={foreground}; after staging: {}",
        client.ok(json!({"command":"status"}))
    );
    assert_eq!(proposal["actions"], 0);
    assert_eq!(fixture.text(101), "initial");
    assert!(
        client
            .request(json!({"command":"confirm","session":session,"confirmation_id":"forged"}))
            .get("Err")
            .is_some()
    );
    let applied = client.confirm(session, &proposal);
    println!("after SetValue: {applied}");
    assert_eq!(applied["actions"], 1);
    assert_eq!(fixture.text(101), "Kaji café 日本語");
    assert_eq!(native::cursor().unwrap(), physical);
    assert_eq!(native::foreground(), foreground);
    assert!(client.request(json!({"command":"confirm","session":session,"confirmation_id":proposal["confirmation"]["id"]})).get("Err").is_some());
    let snapshot = client.inspect(session);
    assert_eq!(by_id(&snapshot, "101")["value"], "Kaji café 日本語");

    let check = by_id(&snapshot, "104");
    assert_eq!(check["supports_toggle"], true);
    let stale = client.stage(session, &check, json!({"kind":"set_toggle","on":true}));
    client.inspect(session);
    assert!(client.request(json!({"command":"confirm","session":session,"confirmation_id":stale["confirmation"]["id"]})).get("Err").is_some());
    for _ in 0..2 {
        let snapshot = client.inspect(session);
        let check = by_id(&snapshot, "104");
        let proposal = client.stage(session, &check, json!({"kind":"set_toggle","on":true}));
        client.confirm(session, &proposal);
        let snapshot = client.inspect(session);
        assert_eq!(by_id(&snapshot, "104")["toggle_state"], "on");
    }
    let snapshot = client.inspect(session);
    let beta = snapshot["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "Beta" && e["supports_select"] == true)
        .expect("real list item SelectionItem pattern")
        .clone();
    let proposal = client.stage(session, &beta, json!({"kind":"select"}));
    client.confirm(session, &proposal);
    let snapshot = client.inspect(session);
    assert!(
        snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "Beta" && e["selected"] == true)
    );
    let scroll = by_id(&snapshot, "106");
    assert_eq!(scroll["supports_scroll"], true);
    let proposal = client.stage(
        session,
        &scroll,
        json!({"kind":"scroll","horizontal":null,"vertical":100.0}),
    );
    client.confirm(session, &proposal);
    let snapshot = client.inspect(session);
    assert_eq!(by_id(&snapshot, "106")["vertical_scroll_percent"], 100.0);

    let button = by_id(&snapshot, "201");
    let proposal = client.stage(session, &button, json!({"kind":"invoke"}));
    unsafe {
        SetWindowTextW(
            GetDlgItem(Some(HWND(fixture.hwnd as _)), 201).unwrap(),
            w!("Changed after approval proposal"),
        )
        .unwrap();
    }
    let changed = client.request(json!({"command":"confirm","session":session,"confirmation_id":proposal["confirmation"]["id"]}));
    assert!(
        changed["Err"]
            .as_str()
            .unwrap()
            .contains("approved target changed")
    );
    assert_eq!(BUTTON_EFFECTS.load(Ordering::SeqCst), 0);
    let status = client.ok(json!({"command":"status"}));
    assert_eq!(status["phase"], "paused");
    client.ok(json!({"command":"resume","session":session}));
    let snapshot = client.inspect(session);
    let proposal = client.stage(session, &by_id(&snapshot, "201"), json!({"kind":"invoke"}));
    client.confirm(session, &proposal);
    assert_eq!(BUTTON_EFFECTS.load(Ordering::SeqCst), 1);
    assert_eq!(native::cursor().unwrap(), physical);
    assert_eq!(native::foreground(), foreground);
    let stopped = client.ok(json!({"command":"stop"}));
    assert_eq!(stopped["phase"], "stopped");
    assert!(client.request(json!({"command":"confirm","session":session,"confirmation_id":proposal["confirmation"]["id"]})).get("Err").is_some());
    client.ok(json!({"command":"shutdown"}));
    println!(
        "PASS: real UIA value/toggle/selection/scroll; Guide denied; default Assist stages; forged/replayed/stale approvals denied; changed target rejected; safe stop; physical cursor and foreground preserved"
    );
}
