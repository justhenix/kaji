use kaji_engine::{control::Point, native};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
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

static CLICKS: AtomicUsize = AtomicUsize::new(0);
unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_COMMAND && w.0 & 0xffff == 1 && w.0 >> 16 == 0 {
        CLICKS.fetch_add(1, Ordering::SeqCst);
        return LRESULT(0);
    }
    if message == WM_DESTROY {
        unsafe {
            PostQuitMessage(0);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}
struct Driver {
    child: Child,
    input: std::process::ChildStdin,
    lines: std::io::Lines<BufReader<std::process::ChildStdout>>,
    session: u64,
    sequence: u64,
    pose: Point,
    started: Instant,
}
impl Driver {
    fn request(&mut self, mut value: Value) -> Value {
        value["id"] = json!(1);
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let response: Value = serde_json::from_str(&self.lines.next().unwrap().unwrap()).unwrap();
        response["result"]
            .get("Ok")
            .unwrap_or_else(|| panic!("native request failed: {response}"))
            .clone()
    }
    fn frame(&mut self, pose: Point) -> Value {
        let status = self.request(json!({"command":"status"}));
        assert_ne!(
            status["phase"], "stopped",
            "native session stopped: {status}"
        );
        self.sequence += 1;
        self.pose = pose;
        self.request(json!({"command":"frame","frame":{"session":self.session,"sequence":self.sequence,"captured_ms":status["now_ms"],"yaw":0.,"pitch":0.,"faces":1,"candidates":[{"yaw":0.,"pitch":0.4,"center_x":pose.x,"center_y":pose.y,"eye_span":0.2}]}}));
        status
    }
    fn hold(&mut self, pose: Point, seconds: f64, jitter: bool) -> Value {
        let start = Instant::now();
        let mut status = Value::Null;
        while start.elapsed().as_secs_f64() < seconds {
            let phase = self.started.elapsed().as_secs_f64() * std::f64::consts::TAU / 0.5;
            let p = Point {
                x: pose.x + if jitter { phase.sin() * 0.003 } else { 0. },
                y: pose.y,
            };
            status = self.frame(p);
            std::thread::sleep(Duration::from_millis(24));
        }
        status
    }
    fn ramp(&mut self, to: Point) {
        let from = self.pose;
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(700) {
            let t = (start.elapsed().as_secs_f64() / 0.7).min(1.);
            self.frame(Point {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t,
            });
            std::thread::sleep(Duration::from_millis(24));
        }
        self.frame(to);
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        let _ = writeln!(self.input, "{}", json!({"id":9,"command":"stop"}));
        let _ = self.input.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "moves the native pointer and dwell-clicks only an inert test window; requires idle desktop"]
fn real_dwell_clicks_with_tremor_rearms_and_never_clicks_blank_space() {
    native::dpi_aware();
    CLICKS.store(0, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut idle_since = Instant::now();
    let mut point = native::cursor().unwrap();
    while idle_since.elapsed() < Duration::from_secs(2) {
        assert!(
            Instant::now() < deadline,
            "desktop remained active; no input was sent"
        );
        std::thread::sleep(Duration::from_millis(50));
        let current = native::cursor().unwrap();
        if current != point {
            idle_since = Instant::now();
            point = current;
        }
    }
    let original = native::cursor().unwrap();
    let monitors = native::monitors().unwrap();
    let monitor = monitors.iter().find(|r| r.contains(original)).unwrap();
    let start = monitor.center();
    unsafe {
        SetCursorPos(start.x as i32, start.y as i32).unwrap();
    }
    let direction = 1.;
    let vertical = 1.;
    let (tx, rx) = mpsc::sync_channel(1);
    let host = std::thread::spawn(move || unsafe {
        native::dpi_aware();
        let module = GetModuleHandleW(None).unwrap();
        let class = WNDCLASSW {
            hInstance: module.into(),
            lpszClassName: w!("KajiDwellExecutionFixture"),
            lpfnWndProc: Some(window_proc),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let root = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            w!("KajiDwellExecutionFixture"),
            w!("Kaji dwell click verification"),
            WS_POPUP | WS_VISIBLE,
            start.x as i32 - 240,
            start.y as i32 - 110,
            480,
            260,
            None,
            None,
            Some(module.into()),
            None,
        )
        .unwrap();
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("BUTTON"),
            w!("Safe test button"),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            80,
            60,
            320,
            100,
            Some(root),
            Some(HMENU(1 as _)),
            Some(module.into()),
            None,
        )
        .unwrap();
        tx.send(root.0 as isize).unwrap();
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = UnregisterClassW(w!("KajiDwellExecutionFixture"), Some(module.into()));
    });
    let hwnd = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let result = std::panic::catch_unwind(|| {
        assert_eq!(
            native::window_at(start),
            hwnd,
            "fixture is covered by another window"
        );
        let binary = std::env::var_os("KAJI_TEST_BINARY_DIR")
            .map(|p| std::path::PathBuf::from(p).join("kaji-diag.exe"))
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_kaji-diag").into());
        let mut child = Command::new(binary)
            .args(["--enable-input", "--allow-replay"])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut driver = Driver {
            child,
            input,
            lines,
            session: 0,
            sequence: 0,
            pose: Point { x: 0.5, y: 0.5 },
            started: Instant::now(),
        };
        assert!(
            !driver
                .request(json!({"command":"hit_test","point":start}))
                .is_null(),
            "fixture button is not actionable"
        );
        let session = driver.request(json!({"command":"begin","hwnd":hwnd}));
        driver.session = session["id"].as_u64().unwrap();
        let neutral = driver.pose;
        driver.hold(neutral, 1.7, false);
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            0,
            "startup clicked without aiming"
        );
        let gain = 1100. / 0.28;
        let aim = Point {
            x: neutral.x - direction * 60. / gain,
            y: neutral.y,
        };
        driver.ramp(aim);
        let mut samples = Vec::new();
        for _ in 0..14 {
            let status = driver.hold(aim, 0.25, true);
            samples.push(json!({"phase":status["phase"],"cursor":status["cursor"],"progress":status["dwell_progress"],"ready":status["dwell_ready"],"clicks":status["clicks"]}));
            if CLICKS.load(Ordering::SeqCst) > 0 {
                break;
            }
        }
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            1,
            "tremor prevented the real button click; statuses: {samples:?}"
        );
        driver.hold(aim, 1.8, true);
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            1,
            "holding repeated the click"
        );
        let second = Point {
            x: aim.x - direction * 30. / gain,
            y: aim.y,
        };
        driver.ramp(second);
        driver.hold(second, 2.4, false);
        assert_eq!(
            CLICKS.load(Ordering::SeqCst),
            2,
            "departure did not rearm clicking"
        );
        let blank = Point {
            x: second.x,
            y: second.y + vertical * 95. / gain,
        };
        driver.ramp(blank);
        let status = driver.hold(blank, 2.4, false);
        assert_eq!(status["clicks"], 2, "blank space generated a native click");
        let stopped = driver.request(json!({"command":"stop"}));
        assert_eq!(stopped["phase"], "stopped");
        println!(
            "PASS: real jittered dwell clicked once, held without repeats, rearmed, rejected blank space and stopped"
        );
    });
    unsafe {
        let _ = PostMessageW(Some(HWND(hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    host.join().unwrap();
    unsafe {
        let _ = SetCursorPos(original.x as i32, original.y as i32);
    }
    result.unwrap();
}
