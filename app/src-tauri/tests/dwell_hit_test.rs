use kaji_engine::control::Point;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
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
fn dwell_allows_enabled_controls_but_not_disabled_text_or_blank_space() {
    kaji_engine::native::dpi_aware();
    let (tx, rx) = mpsc::sync_channel(1);
    let host = std::thread::spawn(move || unsafe {
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
        }
        points.push(Point { x: 270., y: 150. });
        tx.send((root.0 as isize, points)).unwrap();
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = UnregisterClassW(w!("KajiDwellFixture"), Some(module.into()));
    });
    let (hwnd, points) = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let result = std::panic::catch_unwind(|| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kaji-diag"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        for (i, point) in points.into_iter().enumerate() {
            writeln!(
                input,
                "{}",
                serde_json::json!({"id":i,"command":"hit_test","point":point})
            )
            .unwrap();
            input.flush().unwrap();
            let response: serde_json::Value =
                serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            let target = response["result"]
                .get("Ok")
                .expect("bounded hit-test failed");
            assert_eq!(!target.is_null(), i == 0, "fixture target {i}: {target:?}");
            if i == 0 {
                for repeat in 0..5 {
                    writeln!(
                        input,
                        "{}",
                        serde_json::json!({"id":20+repeat,"command":"hit_test","point":point})
                    )
                    .unwrap();
                    input.flush().unwrap();
                    let again: serde_json::Value =
                        serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                    assert_eq!(
                        &again["result"]["Ok"], target,
                        "same control changed identity between probes"
                    );
                }
            }
        }
        writeln!(
            input,
            "{}",
            serde_json::json!({"id":9,"command":"shutdown"})
        )
        .unwrap();
        drop(input);
        assert!(child.wait().unwrap().success());
    });
    unsafe {
        let _ = PostMessageW(Some(HWND(hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    host.join().unwrap();
    result.unwrap();
}
