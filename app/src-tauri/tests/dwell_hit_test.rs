use kaji_engine::{
    control::Point,
    native::{self, Rect},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Client {
    fn new(exe: &str) -> Self {
        let mut child = Command::new(exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn request(&mut self, command: Value) -> Value {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        response["result"]
            .get("Ok")
            .unwrap_or_else(|| panic!("native read-only request failed: {response}"))
            .clone()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::*,
    },
    core::w,
};

unsafe extern "system" fn fixture(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_DESTROY {
        unsafe {
            PostQuitMessage(0);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}

#[test]
#[ignore = "briefly shows an inert Windows fixture; reads real UIA targets without clicking"]
fn dwell_and_guide_highlight_only_real_enabled_controls() {
    kaji_engine::native::dpi_aware();
    let (tx, rx) = mpsc::sync_channel(1);
    let host = std::thread::spawn(move || unsafe {
        native::dpi_aware();
        let module = GetModuleHandleW(None).unwrap();
        let class = WNDCLASSW {
            hInstance: module.into(),
            lpszClassName: w!("KajiDwellFixture"),
            lpfnWndProc: Some(fixture),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let root = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            w!("KajiDwellFixture"),
            w!("Kaji dwell target check"),
            WS_POPUP | WS_VISIBLE,
            30,
            30,
            340,
            180,
            None,
            None,
            Some(module.into()),
            None,
        )
        .unwrap();
        let mut points = Vec::new();
        let mut rects = Vec::new();
        for (class, name, x, y, style) in [
            (w!("BUTTON"), w!("Enabled"), 20, 20, WS_TABSTOP),
            (w!("BUTTON"), w!("Disabled"), 180, 20, WS_DISABLED),
            (w!("STATIC"), w!("Plain text"), 20, 100, WINDOW_STYLE(0)),
        ] {
            let control = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                name,
                WS_CHILD | WS_VISIBLE | style,
                x,
                y,
                120,
                40,
                Some(root),
                None,
                Some(module.into()),
                None,
            )
            .unwrap();
            let mut r = RECT::default();
            GetWindowRect(control, &mut r).unwrap();
            points.push(Point {
                x: f64::from(r.left + r.right) / 2.,
                y: f64::from(r.top + r.bottom) / 2.,
            });
            rects.push(Rect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            });
        }
        points.push(Point { x: 270., y: 150. });
        tx.send((root.0 as isize, points, rects)).unwrap();
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = UnregisterClassW(w!("KajiDwellFixture"), Some(module.into()));
    });
    let (hwnd, points, rects) = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let result = std::panic::catch_unwind(|| {
        let mut client = Client::new(env!("CARGO_BIN_EXE_kaji-diag"));
        for (i, point) in points.into_iter().enumerate() {
            let target = client.request(json!({"id":i,"command":"hit_test","point":point}));
            assert_eq!(!target.is_null(), i == 0, "fixture target {i}: {target:?}");
            if i == 0 {
                assert_eq!(target["rect"], json!(rects[0]));
                for repeat in 0..5 {
                    let again =
                        client.request(json!({"id":20+repeat,"command":"hit_test","point":point}));
                    assert_eq!(
                        again, target,
                        "same control changed identity between probes"
                    );
                }
            }
        }
        drop(client);
        let pointer = native::cursor().unwrap();
        let foreground = native::foreground();
        let mut client = Client::new(env!("CARGO_BIN_EXE_kaji-assist"));
        let status = client.request(json!({"id":1,"command":"begin","hwnd":hwnd,"mode":"guide"}));
        let session = status["session"].as_u64().unwrap();
        let snapshot = client.request(json!({"id":2,"command":"inspect","session":session}));
        let button = snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|element| element["name"] == "Enabled")
            .unwrap();
        let cursor = client
            .request(json!({"id":3,"command":"point","session":session,"element_id":button["id"]}));
        assert_eq!(cursor["target"], json!(rects[0]));
        assert_eq!(cursor["target_name"], "Enabled");
        assert_eq!(cursor["point"], json!(rects[0].center()));
        assert_eq!(
            native::cursor().unwrap(),
            pointer,
            "Highlighting moved the user's cursor"
        );
        assert_eq!(native::foreground(), foreground, "Highlighting stole focus");
    });
    unsafe {
        let _ = PostMessageW(Some(HWND(hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    host.join().unwrap();
    result.unwrap();
}
