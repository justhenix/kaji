use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::*,
    },
    core::w,
};

unsafe extern "system" fn stalled_provider(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
) -> LRESULT {
    if message == WM_GETOBJECT {
        // A live provider that stops answering must not survive the caller's timeout.
        std::thread::sleep(Duration::from_millis(6500));
    }
    if message == WM_DESTROY {
        unsafe {
            PostQuitMessage(0);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}
#[test]
#[ignore = "requires unlocked Windows desktop; creates a hidden deliberately stalled UIA provider"]
fn hung_provider_is_killed_and_next_inspection_still_works() {
    let (tx, rx) = mpsc::sync_channel(1);
    let window_thread = std::thread::spawn(move || unsafe {
        let instance = GetModuleHandleW(None).unwrap();
        let class = WNDCLASSW {
            hInstance: instance.into(),
            lpszClassName: w!("KajiUiaTimeoutFixture"),
            lpfnWndProc: Some(stalled_provider),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("KajiUiaTimeoutFixture"),
            w!("Kaji timeout fixture"),
            WS_OVERLAPPED,
            0,
            0,
            100,
            100,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .unwrap();
        tx.send(hwnd.0 as isize).unwrap();
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnregisterClassW(w!("KajiUiaTimeoutFixture"), Some(instance.into()));
    });
    let hwnd = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kaji-diag"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (result_tx, result_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            let _ = result_tx.send(line);
        }
    });
    let start = Instant::now();
    writeln!(
        input,
        "{}",
        serde_json::json!({"id":1,"command":"inspect","hwnd":hwnd})
    )
    .unwrap();
    input.flush().unwrap();
    let reply = result_rx.recv_timeout(Duration::from_secs(7));
    if reply.is_err() {
        let _ = child.kill();
    }
    unsafe {
        let _ = PostMessageW(Some(HWND(hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    let reply: serde_json::Value =
        serde_json::from_str(&reply.expect("UIA watchdog did not return")).unwrap();
    assert!(
        reply["result"]["Err"]
            .as_str()
            .is_some_and(|s| s.contains("timed out")),
        "{reply}"
    );
    assert!(start.elapsed() < Duration::from_secs(6));
    writeln!(
        input,
        "{}",
        serde_json::json!({"id":2,"command":"inspect","hwnd":1})
    )
    .unwrap();
    input.flush().unwrap();
    let next: serde_json::Value =
        serde_json::from_str(&result_rx.recv_timeout(Duration::from_secs(6)).unwrap()).unwrap();
    assert_eq!(next["id"], 2);
    assert!(
        next["result"].get("Err").is_some(),
        "an invalid HWND should be rejected"
    );
    writeln!(
        input,
        "{}",
        serde_json::json!({"id":3,"command":"shutdown"})
    )
    .unwrap();
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
    window_thread.join().unwrap();
    println!("PASS: hung provider terminated at deadline; subsequent UIA request returned");
}
