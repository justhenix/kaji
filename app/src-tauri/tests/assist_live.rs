use kaji_engine::{control::Point, native};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};
use windows::Win32::UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*};

struct Client {
    child: Child,
    input: ChildStdin,
    responses: Receiver<Value>,
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
        let (tx, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(value) = serde_json::from_str(&line)
                    && tx.send(value).is_err()
                {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            responses,
            id: 0,
        }
    }
    fn send(&mut self, mut request: Value) -> u64 {
        self.id += 1;
        request["id"] = json!(self.id);
        writeln!(self.input, "{request}").unwrap();
        self.input.flush().unwrap();
        self.id
    }
    fn next(&self) -> Value {
        self.responses
            .recv_timeout(Duration::from_secs(8))
            .expect("native response deadline")
    }
    fn request(&mut self, request: Value) -> Value {
        let id = self.send(request);
        let result = self.next();
        assert_eq!(result["id"], id);
        result["result"].clone()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Restore(Point);
impl Drop for Restore {
    fn drop(&mut self) {
        unsafe {
            let _ = SetCursorPos(self.0.x as i32, self.0.y as i32);
        }
    }
}

#[test]
#[ignore = "requires Calculator foreground and KAJI_ASSIST_HWND; injects a mouse move, a 7-button click and Escape"]
fn collaboration_yields_without_losing_session_and_escape_revokes() {
    native::dpi_aware();
    let hwnd: isize = std::env::var("KAJI_ASSIST_HWND")
        .expect("set current Calculator HWND")
        .parse()
        .unwrap();
    assert_eq!(
        native::foreground(),
        hwnd,
        "Calculator must be foreground for the input test"
    );
    let _restore = Restore(native::cursor().unwrap());
    let mut client = Client::new();
    let begin = client.request(json!({"command":"begin","hwnd":hwnd}));
    let session = begin["Ok"]["session"].as_u64().expect("native begin");
    let snapshot = client.request(json!({"command":"inspect","session":session}));
    assert_eq!(snapshot["Ok"]["title"], "Calculator");
    let button = snapshot["Ok"]["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            e["control_type"] == 50000
                && (e["name"] == "7"
                    || e["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains("seven"))
        })
        .unwrap();
    let token = button["id"].as_str().unwrap().to_owned();
    let point: Point =
        serde_json::from_value(button["clickable"].clone()).expect("7 must be unobscured");
    let intent = client.request(json!({"command":"point","session":session,"element_id":token}));
    let revision = intent["Ok"]["revision"].as_u64().unwrap();
    unsafe {
        let movement = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 1,
                    dwFlags: MOUSEEVENTF_MOVE,
                    ..Default::default()
                },
            },
        };
        assert_eq!(
            SendInput(&[movement], std::mem::size_of::<INPUT>() as i32),
            1
        );
    }
    std::thread::sleep(Duration::from_millis(40));
    let active = client.request(json!({"command":"status"}));
    assert_eq!(active["Ok"]["phase"], "active");
    assert_eq!(active["Ok"]["cursor"]["revision"], revision);
    println!("PASS: foreign physical mouse movement preserves logical cursor and task session");
    assert_eq!(
        native::window_at(point),
        hwnd,
        "refuse to inject into a covering window"
    );
    assert!(
        !native::modifiers_down(),
        "refuse input with held buttons/modifiers"
    );
    unsafe {
        SetCursorPos(point.x as i32, point.y as i32).unwrap();
        let event = |flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        assert_eq!(
            SendInput(
                &[event(MOUSEEVENTF_LEFTDOWN), event(MOUSEEVENTF_LEFTUP)],
                std::mem::size_of::<INPUT>() as i32
            ),
            2
        );
    }
    std::thread::sleep(Duration::from_millis(50));
    let paused = client.request(json!({"command":"status"}));
    assert_eq!(paused["Ok"]["phase"], "paused");
    assert_eq!(paused["Ok"]["session"], session);
    assert!(paused["Ok"]["cursor"].is_null());
    assert!(
        client.request(json!({"command":"invoke","session":session,"revision":revision}))["Err"]
            .is_string()
    );
    let resumed = client.request(json!({"command":"resume","session":session}));
    assert_eq!(resumed["Ok"]["phase"], "active");
    assert!(
        client.request(json!({"command":"point","session":session,"element_id":token}))["Err"]
            .as_str()
            .unwrap()
            .contains("inspection required")
    );
    println!(
        "PASS: target activity pauses, rejects old intent, and resumes only with fresh inspection"
    );
    unsafe {
        let event = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_ESCAPE,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        assert_eq!(
            SendInput(
                &[event(KEYBD_EVENT_FLAGS(0)), event(KEYEVENTF_KEYUP)],
                std::mem::size_of::<INPUT>() as i32
            ),
            2
        );
    }
    std::thread::sleep(Duration::from_millis(40));
    let stopped = client.request(json!({"command":"status"}));
    assert_eq!(stopped["Ok"]["phase"], "stopped");
    assert!(stopped["Ok"]["reason"].as_str().unwrap().contains("Escape"));
    assert!(client.request(json!({"command":"resume","session":session}))["Err"].is_string());
    println!(
        "PASS: actual Escape hook revokes collaborative execution and cannot be resumed implicitly"
    );
    for delay_ms in [0, 1, 3, 5, 20, 40] {
        let begin_id = client.send(json!({"command":"begin","hwnd":hwnd}));
        std::thread::sleep(Duration::from_millis(delay_ms));
        let started = Instant::now();
        let stop_id = client.send(json!({"command":"stop"}));
        let a = client.next();
        let b = client.next();
        let stop = if a["id"] == stop_id { &a } else { &b };
        assert_eq!(stop["id"], stop_id);
        assert_eq!(stop["result"]["Ok"]["phase"], "stopped");
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(a["id"] == begin_id || b["id"] == begin_id);
        assert_eq!(
            client.request(json!({"command":"status"}))["Ok"]["phase"],
            "stopped"
        );
    }
    println!("PASS: stop cancels queued/in-flight initialization and no late begin rearms it");
    client.request(json!({"command":"shutdown"}));
    assert!(client.child.wait().unwrap().success());
}
